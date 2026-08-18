"""Turn the raw PDF dump (words.json) into a clean vocabulary list.

The PDF is laid out in columns, so pypdf glues adjacent words together
("approbationclangor" = "approbation" + "clangor"). Those tokens only ever
appear glued, so the list cannot serve as its own dictionary -- we ask the
configured LLM to split them and then verify every split by re-joining the
parts and checking they reproduce the original token exactly.

Run:  python backend/clean_words.py
Out:  frontend/words.json  (static asset the UI fetches)
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.llm import _parse_json, configured_providers  # noqa: E402

RAW = Path(__file__).resolve().parent / "words.json"
OUT = ROOT / "frontend" / "words.json"

# Boilerplate from the PDF's header/footer, not vocabulary.
FILLER = {
    "for", "vocab", "quizzes", "please", "here", "group", "test", "take", "from",
    "the", "and", "you", "your", "this", "that", "with", "list", "words", "word",
    "page", "quiz", "hour", "all", "not", "are", "was", "one", "two", "go", "ad",
}

GLUE_MIN_LEN = 12   # only tokens at least this long are split candidates
BATCH = 40

# Stragglers the model kept splitting into non-words. Each is checked by the
# same concatenation rule as the LLM's answers, so a typo here cannot slip in.
MANUAL_SPLITS = {
    "expeditedaunting": ["expedite", "daunting"],
    "manifestobeisance": ["manifest", "obeisance"],
    "ramblesinecure": ["ramble", "sinecure"],
    "residualsordid": ["residual", "sordid"],
    "stoicspendthrift": ["stoic", "spendthrift"],
}

SPLIT_PROMPT = """You are cleaning a GRE vocabulary list extracted from a PDF.
The PDF had multiple columns, so some entries are two or three separate words
run together with no space (e.g. "approbationclangor" is "approbation" +
"clangor", and "circumspectascribebelie" is "circumspect" + "ascribe" +
"belie").

For each token below, decide whether it is ONE real English word or SEVERAL
real English words concatenated.

Return ONLY JSON of this exact shape:
{"results": {"<token>": ["<word>", ...], ...}}

Rules:
- If the token is already a single valid English word, return it as a
  one-element list.
- If it is several words run together, return them in order.
- The parts MUST concatenate back to the original token exactly, with no
  letters added, removed, or reordered.
- Every part must be a real English word.
- Include every token given, using the token exactly as the key.

Tokens:
"""


def ask_llm(prompt):
    providers = configured_providers()
    if not providers:
        raise SystemExit("No LLM provider configured - add a key to .env")

    errors = []
    for provider in providers:
        try:
            return _ask(provider, prompt)
        except Exception as exc:
            errors.append(f"{provider}: {exc}")
    raise SystemExit("All providers failed: " + " | ".join(errors))


def _ask(provider, prompt):
    """Send a bare prompt (not the vocabulary schema) to one provider."""
    import os

    if provider == "mistral":
        from mistralai.client import Mistral
        client = Mistral(api_key=os.getenv("MISTRAL_API_KEY"))
        r = client.chat.complete(
            model=os.getenv("MISTRAL_MODEL", "mistral-small-latest"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0,
            response_format={"type": "json_object"},
        )
        return _parse_json(r.choices[0].message.content, "Mistral")

    if provider == "gemini":
        from google import genai
        from google.genai import types
        client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))
        r = client.models.generate_content(
            model=os.getenv("GEMINI_MODEL", "gemini-3.6-flash"),
            contents=prompt,
            config=types.GenerateContentConfig(
                temperature=0, response_mime_type="application/json"),
        )
        return _parse_json(r, "Gemini")

    from openai import OpenAI
    client = OpenAI(api_key=os.getenv("OPENROUTER_API_KEY"),
                    base_url="https://openrouter.ai/api/v1")
    r = client.chat.completions.create(
        model=os.getenv("OPENROUTER_MODEL", "openrouter/auto"),
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
        response_format={"type": "json_object"},
    )
    return _parse_json(r.choices[0].message.content, "OpenRouter")


def main():
    raw = json.load(open(RAW, encoding="utf-8"))
    print(f"raw entries: {len(raw)}")

    kept, candidates = [], []
    for w in raw:
        w = w.strip().lower()
        if not w.isalpha() or len(w) < 3 or w in FILLER:
            continue
        (candidates if len(w) >= GLUE_MIN_LEN else kept).append(w)

    print(f"after junk filter: {len(kept) + len(candidates)} "
          f"({len(candidates)} split candidates)")

    resolved = {}

    # Seed with the manual overrides, held to the same verification rule.
    for token, parts in MANUAL_SPLITS.items():
        if token in candidates and "".join(parts) == token:
            resolved[token] = parts

    for i in range(0, len(candidates), BATCH):
        batch = candidates[i:i + BATCH]
        data = ask_llm(SPLIT_PROMPT + "\n".join(batch))
        results = data.get("results", data) or {}

        for token in batch:
            if token in MANUAL_SPLITS:
                continue  # already resolved above; don't let the model override
            parts = results.get(token)
            if isinstance(parts, str):
                parts = [parts]
            if not isinstance(parts, list) or not parts:
                continue
            parts = [str(p).strip().lower() for p in parts]
            # Verification: the parts must rebuild the token exactly.
            if "".join(parts) == token and all(p.isalpha() and len(p) >= 3 for p in parts):
                resolved[token] = parts

        print(f"  batch {i // BATCH + 1}: {len(resolved)} verified so far")

    split_count = sum(1 for t, p in resolved.items() if len(p) > 1)
    unverified = [t for t in candidates if t not in resolved]

    final = list(kept)
    for token in candidates:
        final.extend(resolved.get(token, [token]))

    final = sorted(dict.fromkeys(w for w in final if 3 <= len(w) <= 20))

    OUT.write_text(json.dumps(final, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\ntokens split      : {split_count}")
    print(f"unverified (kept) : {len(unverified)} {unverified[:8]}")
    print(f"final word count  : {len(final)}")
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
