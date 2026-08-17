from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    from .prompt import SYSTEM_PROMPT
    from .llm import get_vocabulary
except ImportError:  # pragma: no cover
    from prompt import SYSTEM_PROMPT
    from llm import get_vocabulary


app = FastAPI(title="GRE Vocabulary Chatbot")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class VocabularyRequest(BaseModel):
    word: str


@app.get("/")
def home():
    return {"message": "GRE Vocabulary API is running"}


@app.post("/api/vocab")
def vocabulary(request: VocabularyRequest):
    word = request.word.strip()

    if not word:
        raise HTTPException(status_code=400, detail="Please provide a vocabulary word.")

    if len(word) > 100:
        raise HTTPException(status_code=400, detail="Word is too long.")

    try:
        return get_vocabulary(word, SYSTEM_PROMPT)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
