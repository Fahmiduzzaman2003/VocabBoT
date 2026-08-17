"""LLM provider layer.

Talks to Mistral, Gemini or OpenRouter, and always returns a dict that
matches the schema the frontend expects -- regardless of what the model
actually sent back.
"""

import json
import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

logger = logging.getLogger(__name__)

PROVIDERS = ("mistral", "gemini", "openrouter")

# Gemini retires model aliases fairly aggressively, so we try a list.
GEMINI_FALLBACK_MODELS = (
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-flash-latest",
)


class ProviderError(RuntimeError):
    """Raised when a provider cannot produce a usable answer."""


def _env(name, default=None):
    """Read an env var, treating blank/whitespace-only values as unset."""
    value = os.getenv(name)
    if value is None:
        return default
    value = value.strip()
    return value or default


def api_key_for(provider):
    if provider == "mistral":
        # Tolerate the historical typo'd spelling.
        return _env("MISTRAL_API_KEY") or _env("MISTRAl_API_KEY")
    if provider == "gemini":
        return _env("GEMINI_API_KEY")
    if provider == "openrouter":
        return _env("OPENROUTER_API_KEY")
    return None


def configured_providers():
    """Providers that actually have a key available, in preference order."""
    available = [p for p in PROVIDERS if api_key_for(p)]

    preferred = (_env("LLM_PROVIDER", "mistral") or "mistral").lower()
    if preferred in available:
        available.remove(preferred)
        available.insert(0, preferred)

    return available


# --------------------------------------------------------------------------
# JSON extraction
# --------------------------------------------------------------------------

def _clean_json_text(raw_response):
    if raw_response is None:
        return "{}"

    text = raw_response
    if hasattr(raw_response, "text"):
        text = raw_response.text

    if isinstance(text, (dict, list)):
        return json.dumps(text)

    text = str(text).strip()

    # Strip markdown fences the models like to add despite instructions.
    text = re.sub(r"```(?:json|JSON)?", "", text).strip()

    # Grab the outermost {...} block, ignoring any prose around it.
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end > start:
        text = text[start:end + 1]

    return text or "{}"


def _parse_json(raw, provider):
    payload = _clean_json_text(raw)
    try:
        data = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ProviderError(
            f"{provider} returned invalid JSON: {payload[:300]}"
        ) from exc

    if not isinstance(data, dict):
        raise ProviderError(f"{provider} returned {type(data).__name__}, expected an object.")

    return data


# --------------------------------------------------------------------------
# Schema normalisation
# --------------------------------------------------------------------------

def _as_text(value):
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (list, tuple)):
        return ", ".join(_as_text(v) for v in value if v is not None)
    if isinstance(value, dict):
        return ", ".join(f"{k}: {_as_text(v)}" for k, v in value.items())
    return str(value).strip()


def _as_list(value, limit=12):
    """Coerce anything the model sent into a clean list of strings."""
    if value is None:
        return []

    if isinstance(value, str):
        parts = re.split(r"[,;|]", value)
    elif isinstance(value, dict):
        parts = list(value.values())
    elif isinstance(value, (list, tuple)):
        parts = list(value)
    else:
        parts = [value]

    out = []
    for part in parts:
        text = _as_text(part)
        if text and text not in out:
            out.append(text)

    return out[:limit]


def normalize_entry(data, word):
    """Guarantee every field the UI reads exists and has the right type."""
    data = data or {}

    examples = data.get("examples")
    if not isinstance(examples, dict):
        # Some models return a list of sentences instead of a keyed object.
        items = _as_list(examples, limit=3)
        examples = {
            "daily": items[0] if len(items) > 0 else "",
            "academic": items[1] if len(items) > 1 else "",
            "conversation": items[2] if len(items) > 2 else "",
        }

    question = data.get("mini_gre_question")
    if not isinstance(question, dict):
        question = {}

    options = _as_list(question.get("options"), limit=6)
    answer = _as_text(question.get("answer"))

    # The answer is sometimes an index ("2") or a letter ("B") -- resolve it
    # to the actual option text so the UI can match it reliably.
    if options:
        if answer.isdigit():
            idx = int(answer)
            if 0 <= idx < len(options):
                answer = options[idx]
            elif 1 <= idx <= len(options):
                answer = options[idx - 1]
        elif len(answer) == 1 and answer.upper().isalpha():
            idx = ord(answer.upper()) - ord("A")
            if 0 <= idx < len(options):
                answer = options[idx]

        if answer and answer not in options:
            match = next(
                (o for o in options if o.lower() == answer.lower()), None
            )
            if match:
                answer = match

    difficulty = _as_text(data.get("difficulty")).title()
    if difficulty not in {"Easy", "Medium", "Hard"}:
        difficulty = "Medium"

    return {
        "word": _as_text(data.get("word")) or word,
        "pronunciation": _as_text(data.get("pronunciation")),
        "part_of_speech": _as_text(data.get("part_of_speech")),
        "difficulty": difficulty,
        "simple_meaning": _as_text(data.get("simple_meaning")),
        "bengali_meaning": _as_text(data.get("bengali_meaning")),
        "etymology": _as_text(data.get("etymology")),
        "synonyms": _as_list(data.get("synonyms"), limit=8),
        "antonyms": _as_list(data.get("antonyms"), limit=6),
        "word_family": _as_list(data.get("word_family"), limit=6),
        "gre_nuance": _as_text(data.get("gre_nuance")),
        "examples": {
            "daily": _as_text(examples.get("daily")),
            "academic": _as_text(examples.get("academic")),
            "conversation": _as_text(examples.get("conversation")),
        },
        "memory_trick": _as_text(data.get("memory_trick")),
        "collocations": _as_list(data.get("collocations"), limit=6),
        "mini_gre_question": {
            "question": _as_text(question.get("question")),
            "options": options,
            "answer": answer,
            "explanation": _as_text(question.get("explanation")),
        },
    }


# --------------------------------------------------------------------------
# Providers
# --------------------------------------------------------------------------

def _user_message(word):
    return f"Teach me the GRE vocabulary word: {word}"


def ask_mistral(word, system_prompt):
    from mistralai.client import Mistral

    api_key = api_key_for("mistral")
    if not api_key:
        raise ProviderError("MISTRAL_API_KEY is missing.")

    client = Mistral(api_key=api_key)
    response = client.chat.complete(
        model=_env("MISTRAL_MODEL", "mistral-small-latest"),
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": _user_message(word)},
        ],
        temperature=0.3,
        response_format={"type": "json_object"},
    )

    return _parse_json(response.choices[0].message.content, "Mistral")


def ask_openrouter(word, system_prompt):
    from openai import OpenAI

    api_key = api_key_for("openrouter")
    if not api_key:
        raise ProviderError("OPENROUTER_API_KEY is missing.")

    client = OpenAI(api_key=api_key, base_url="https://openrouter.ai/api/v1")
    response = client.chat.completions.create(
        model=_env("OPENROUTER_MODEL", "openrouter/auto"),
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": _user_message(word)},
        ],
        temperature=0.3,
        response_format={"type": "json_object"},
    )

    return _parse_json(response.choices[0].message.content, "OpenRouter")


def ask_gemini(word, system_prompt):
    from google import genai
    from google.genai import types

    api_key = api_key_for("gemini")
    if not api_key:
        raise ProviderError("GEMINI_API_KEY is missing.")

    client = genai.Client(api_key=api_key)
    prompt = f"{system_prompt}\n\nVocabulary word:\n{word}\n"

    models = []
    for model in (_env("GEMINI_MODEL"),) + GEMINI_FALLBACK_MODELS:
        if model and model not in models:
            models.append(model)

    errors = []
    for model in models:
        try:
            response = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.3,
                    response_mime_type="application/json",
                ),
            )
            return _parse_json(response, "Gemini")
        except Exception as exc:  # try the next model in the list
            errors.append(f"{model}: {exc}")
            logger.warning("Gemini model %s failed: %s", model, exc)

    raise ProviderError("Gemini failed. Tried -> " + " | ".join(errors))


_HANDLERS = {
    "mistral": ask_mistral,
    "gemini": ask_gemini,
    "openrouter": ask_openrouter,
}


def get_vocabulary(word, system_prompt):
    """Ask each configured provider in turn until one gives a usable answer."""
    providers = configured_providers()

    if not providers:
        raise ProviderError(
            "No LLM provider is configured. Add MISTRAL_API_KEY, GEMINI_API_KEY "
            "or OPENROUTER_API_KEY to your .env file."
        )

    errors = []
    for provider in providers:
        try:
            data = _HANDLERS[provider](word, system_prompt)
            entry = normalize_entry(data, word)
            entry["source"] = provider
            return entry
        except Exception as exc:
            errors.append(f"{provider}: {exc}")
            logger.warning("Provider %s failed for %r: %s", provider, word, exc)

    raise ProviderError("All providers failed. " + " | ".join(errors))
