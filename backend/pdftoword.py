import json
from pypdf import PdfReader

PDF_FILE = "VocabPDFMK.pdf"
OUTPUT_FILE = "words.json"

reader = PdfReader(PDF_FILE)

text = ""

for page in reader.pages:
    page_text = page.extract_text()

    if page_text:
        text += page_text + " "

words = text.split()

# Clean words
words = [
    word.strip(".,!?;:\"'()[]{}<>")
    .lower()
    for word in words
]

# Remove empty strings and duplicates
words = list(dict.fromkeys(
    word for word in words if word
))

with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    json.dump(words, f, ensure_ascii=False, indent=2)

print(f"Created {OUTPUT_FILE}")
print(f"Total words: {len(words)}")