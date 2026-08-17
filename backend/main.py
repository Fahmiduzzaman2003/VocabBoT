import logging
import re
from collections import OrderedDict
from pathlib import Path
from threading import Lock

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

try:
    from .prompt import SYSTEM_PROMPT
    from .llm import ProviderError, configured_providers, get_vocabulary
except ImportError:  # running as a script rather than a package
    from prompt import SYSTEM_PROMPT
    from llm import ProviderError, configured_providers, get_vocabulary


logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("vocabbot")

FRONTEND_DIR = Path(__file__).resolve().parents[1] / "frontend"

# A word plus optional hyphen/apostrophe/space -- keeps prompt input sane.
WORD_PATTERN = re.compile(r"^[A-Za-z][A-Za-z\-' ]{0,48}$")

CACHE_SIZE = 128
_cache = OrderedDict()
_cache_lock = Lock()


app = FastAPI(title="VocabVerse - GRE Vocabulary API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class VocabularyRequest(BaseModel):
    word: str = Field(..., min_length=1, max_length=50)


def _cache_get(key):
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return _cache[key]
    return None


def _cache_put(key, value):
    with _cache_lock:
        _cache[key] = value
        _cache.move_to_end(key)
        while len(_cache) > CACHE_SIZE:
            _cache.popitem(last=False)


@app.get("/api/health")
def health():
    providers = configured_providers()
    return {
        "status": "ok" if providers else "no_provider",
        "providers": providers,
        "active": providers[0] if providers else None,
        "cached_words": len(_cache),
    }


@app.post("/api/vocab")
def vocabulary(request: VocabularyRequest):
    word = " ".join(request.word.split())

    if not word:
        raise HTTPException(status_code=400, detail="Please enter a vocabulary word.")

    if not WORD_PATTERN.match(word):
        raise HTTPException(
            status_code=400,
            detail="Please enter a single English word (letters, hyphens and apostrophes only).",
        )

    key = word.lower()
    cached = _cache_get(key)
    if cached is not None:
        return {**cached, "cached": True}

    try:
        entry = get_vocabulary(word, SYSTEM_PROMPT)
    except ProviderError as exc:
        # Log the detail, but don't leak provider internals to the browser.
        logger.error("Lookup failed for %r: %s", word, exc)
        raise HTTPException(
            status_code=503,
            detail="The vocabulary service is unavailable right now. Please try again.",
        ) from exc
    except Exception as exc:
        logger.exception("Unexpected error for %r", word)
        raise HTTPException(
            status_code=500,
            detail="Something went wrong while looking up that word.",
        ) from exc

    _cache_put(key, entry)
    return {**entry, "cached": False}


# Serve the UI from the same origin as the API. Mounted last so the /api
# routes above take precedence.
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
