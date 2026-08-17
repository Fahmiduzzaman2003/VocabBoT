async function learnWord() {
    const input = document.getElementById('wordInput');
    const word = (input?.value || '').trim();

    if (!word) {
        alert('Please enter a word.');
        return;
    }

    const loading = document.getElementById('loading');
    const errorBox = document.getElementById('error');
    const resultBox = document.getElementById('result');

    loading.style.display = 'block';
    errorBox.textContent = '';
    resultBox.innerHTML = '';

    try {
        const response = await fetch('http://127.0.0.1:8000/api/vocab', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ word })
        });

        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.detail || 'Request failed');
        }

        displayVocabulary(data);
    } catch (err) {
        errorBox.textContent = 'Error: ' + (err.message || 'Unknown error');
    } finally {
        loading.style.display = 'none';
    }
}

function displayVocabulary(data) {
    const resultBox = document.getElementById('result');
    const synonyms = Array.isArray(data.synonyms) ? data.synonyms.map(word => `<span>${word}</span>`).join('') : '';
    const antonyms = Array.isArray(data.antonyms) ? data.antonyms.map(word => `<span>${word}</span>`).join('') : '';
    const collocations = Array.isArray(data.collocations) ? data.collocations.map(word => `<span>${word}</span>`).join('') : '';
    const options = Array.isArray(data.mini_gre_question?.options) ? data.mini_gre_question.options.map(option => `<li>${option}</li>`).join('') : '';

    resultBox.innerHTML = `
        <div class="card">
            <div class="word">${data.word || 'Word'} <span class="pronunciation">${data.pronunciation || ''}</span></div>
            <p><strong>${data.part_of_speech || ''}</strong></p>

            <div class="section">
                <h3>Simple Meaning</h3>
                <p>${data.simple_meaning || ''}</p>
            </div>

            <div class="section">
                <h3>Bengali Meaning</h3>
                <p>${data.bengali_meaning || ''}</p>
            </div>

            <div class="section">
                <h3>Synonyms</h3>
                <div class="synonyms">${synonyms}</div>
            </div>

            <div class="section">
                <h3>Antonyms</h3>
                <div class="synonyms">${antonyms}</div>
            </div>

            <div class="section">
                <h3>GRE Nuance</h3>
                <p>${data.gre_nuance || ''}</p>
            </div>

            <div class="section">
                <h3>Examples</h3>
                <div class="example"><span class="tag">Daily:</span> ${data.examples?.daily || ''}</div>
                <div class="example"><span class="tag">Academic:</span> ${data.examples?.academic || ''}</div>
                <div class="example"><span class="tag">Conversation:</span> ${data.examples?.conversation || ''}</div>
            </div>

            <div class="section">
                <h3>Memory Trick</h3>
                <p>${data.memory_trick || ''}</p>
            </div>

            <div class="section">
                <h3>Common Collocations</h3>
                <div class="collocations">${collocations}</div>
            </div>

            <div class="section gre-question">
                <h3>Mini GRE Question</h3>
                <p>${data.mini_gre_question?.question || ''}</p>
                <ol>${options}</ol>
                <p><strong>Answer:</strong> ${data.mini_gre_question?.answer || ''}</p>
                <p>${data.mini_gre_question?.explanation || ''}</p>
            </div>
        </div>
    `;
}

document.addEventListener('DOMContentLoaded', function () {
    const input = document.getElementById('wordInput');
    const button = document.getElementById('learnBtn');

    if (input) {
        input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') {
                learnWord();
            }
        });
    }

    if (button) {
        button.addEventListener('click', learnWord);
    }
});