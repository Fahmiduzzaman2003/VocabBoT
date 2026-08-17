import json
import os
import re

from dotenv import load_dotenv
from openai import OpenAI
from google import genai

load_dotenv()


def _clean_json_text(raw_response):
    if raw_response is None:
        return "{}"

    text = raw_response

    if hasattr(raw_response, "text"):
        text = raw_response.text

    if isinstance(text, (dict, list)):
        return json.dumps(text)

    text = str(text).strip()

    text = text.replace("```json", "")
    text = text.replace("```JSON", "")
    text = text.replace("```", "")
    text = text.strip()

    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        text = match.group(0)

    return text


def ask_openrouter(word, system_prompt):
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        raise RuntimeError("OPENROUTER_API_KEY is missing.")

    model = os.getenv("OPENROUTER_MODEL", "openrouter/free")
    client = OpenAI(api_key=api_key, base_url="https://openrouter.ai/api/v1")

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Teach me the GRE vocabulary word: {word}"},
        ],
        temperature=0.3,
    )

    content = response.choices[0].message.content
    payload = _clean_json_text(content)

    try:
        return json.loads(payload)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"OpenRouter returned invalid JSON: {payload[:500]}") from exc


def ask_gemini(word, system_prompt):
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is missing.")

    client = genai.Client(api_key=api_key)

    model_candidates = [
        os.getenv("GEMINI_MODEL", "gemini-2.0-flash"),
        "gemini-2.0-flash",
        "gemini-1.5-flash",
    ]

    prompt = f"{system_prompt}\n\nVocabulary word:\n{word}\n"

    last_error = None
    for model in model_candidates:
        try:
            response = client.models.generate_content(model=model, contents=prompt)
            payload = _clean_json_text(response)
            return json.loads(payload)
        except Exception as exc:  # pragma: no cover - fallback logic
            last_error = exc

    raise RuntimeError(f"Gemini failed to return valid JSON. Last error: {last_error}")


def get_vocabulary(word, system_prompt):
    provider = os.getenv("LLM_PROVIDER", "openrouter").lower()

    if provider == "gemini":
        return ask_gemini(word, system_prompt)

    return ask_openrouter(word, system_prompt)
