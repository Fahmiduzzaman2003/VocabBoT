/* VocabVerse - GRE vocabulary studio */

(function () {
    "use strict";

    // Where to send API calls, in priority order:
    //   1. <meta name="api-base"> - set this when the frontend is hosted
    //      separately from the backend (e.g. Vercel calling Render directly).
    //   2. file:// - opened from disk, so assume the local dev server.
    //   3. same origin - FastAPI serving the UI, or a Vercel /api rewrite.
    var META_BASE = (document.querySelector('meta[name="api-base"]') || {}).content || "";
    var API_BASE = META_BASE.replace(/\/+$/, "") ||
                   (location.protocol === "file:" ? "http://127.0.0.1:8000" : "");

    var STORE_KEY = "vocabverse.v1";
    var MAX_RECENT = 12;

    // The full GRE list lives in words.json, generated from your PDF by
    // backend/clean_words.py. It is fetched once, lazily, the first time the
    // word bank is opened. FALLBACK_WORDS only covers a failed fetch.
    var FALLBACK_WORDS = [
        "ephemeral", "ubiquitous", "laconic", "perfunctory", "obdurate",
        "garrulous", "intransigent", "equivocate", "quixotic", "recalcitrant",
        "sanguine", "taciturn", "venerate", "abstruse", "belie", "cacophony",
        "dearth", "ebullient", "fastidious", "gregarious", "hackneyed",
        "iconoclast", "magnanimous", "obsequious", "paragon", "prosaic",
        "candor", "furtive"
    ];

    var WORD_BANK = [];
    var wordsPromise = null;
    var wordsFailed = false;
    var activeLetter = null;

    function loadWords() {
        if (wordsPromise) return wordsPromise;

        wordsPromise = fetch("words.json").then(function (res) {
            if (!res.ok) throw new Error("HTTP " + res.status);
            return res.json();
        }).then(function (list) {
            WORD_BANK = (Array.isArray(list) ? list : [])
                .map(function (w) { return String(w).trim().toLowerCase(); })
                .filter(function (w) { return /^[a-z][a-z'-]{1,24}$/.test(w); });

            if (!WORD_BANK.length) throw new Error("words.json was empty");
            return WORD_BANK;
        }).catch(function (err) {
            // Keep the app usable rather than leaving the panel dead.
            console.error("Could not load words.json:", err);
            wordsFailed = true;
            WORD_BANK = FALLBACK_WORDS.slice();
            return WORD_BANK;
        });

        return wordsPromise;
    }

    var STARTERS = [
        { title: "High frequency", words: ["ephemeral", "ubiquitous", "laconic", "candor"] },
        { title: "Describing people", words: ["garrulous", "obsequious", "magnanimous", "taciturn"] },
        { title: "Tricky pairs", words: ["equivocate", "vacillate", "prosaic", "insipid"] }
    ];

    // ---------------------------------------------------------------
    // element refs
    // ---------------------------------------------------------------

    var $ = function (id) { return document.getElementById(id); };

    var form = $("searchForm");
    var input = $("wordInput");
    var learnBtn = $("learnBtn");
    var wordBankBtn = $("wordBankBtn");
    var wordBank = $("wordBank");
    var wbList = $("wbList");
    var wbLetters = $("wbLetters");
    var wbSearch = $("wbSearch");
    var wbCount = $("wbCount");
    var wbNote = $("wbNote");
    var wbRandom = $("wbRandom");
    var wbClose = $("wbClose");
    var errorBox = $("error");
    var resultBox = $("result");
    var skeleton = $("skeleton");
    var waitNote = $("waitNote");
    var emptyState = $("emptyState");
    var hero = $("hero");
    var recentRow = $("recentRow");
    var recentChips = $("recentChips");
    var clearRecent = $("clearRecent");
    var savedPanel = $("savedPanel");
    var savedChips = $("savedChips");
    var savedCount = $("savedCount");
    var statusDot = $("statusDot");
    var statusText = $("statusText");
    var footerProvider = $("footerProvider");

    var isLoading = false;
    var currentEntry = null;

    // ---------------------------------------------------------------
    // safe DOM building (never innerHTML with model output)
    // ---------------------------------------------------------------

    function el(tag, props, children) {
        var node = document.createElement(tag);

        if (props) {
            Object.keys(props).forEach(function (key) {
                var value = props[key];
                if (value === null || value === undefined || value === false) return;

                if (key === "text") {
                    node.textContent = value;
                } else if (key === "className") {
                    node.className = value;
                } else if (key === "onClick") {
                    node.addEventListener("click", value);
                } else if (key === "dataset") {
                    Object.keys(value).forEach(function (d) { node.dataset[d] = value[d]; });
                } else {
                    node.setAttribute(key, value === true ? "" : value);
                }
            });
        }

        (children || []).forEach(function (child) {
            if (child === null || child === undefined) return;
            node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
        });

        return node;
    }

    function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
    }

    // ---------------------------------------------------------------
    // persistence
    // ---------------------------------------------------------------

    function defaultState() {
        return {
            recent: [],
            saved: [],
            learned: [],
            quiz: { correct: 0, total: 0 },
            streak: { count: 0, last: null }
        };
    }

    function loadState() {
        try {
            var raw = localStorage.getItem(STORE_KEY);
            if (!raw) return defaultState();
            var parsed = JSON.parse(raw);
            var base = defaultState();
            return {
                recent: Array.isArray(parsed.recent) ? parsed.recent : base.recent,
                saved: Array.isArray(parsed.saved) ? parsed.saved : base.saved,
                learned: Array.isArray(parsed.learned) ? parsed.learned : base.learned,
                quiz: parsed.quiz && typeof parsed.quiz.total === "number" ? parsed.quiz : base.quiz,
                streak: parsed.streak && typeof parsed.streak.count === "number" ? parsed.streak : base.streak
            };
        } catch (err) {
            return defaultState();
        }
    }

    function saveState() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(state));
        } catch (err) {
            /* storage full or blocked - the app still works without it */
        }
    }

    var state = loadState();

    function today() {
        return new Date().toISOString().slice(0, 10);
    }

    function touchStreak() {
        var day = today();
        if (state.streak.last === day) return;

        var yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        state.streak.count = state.streak.last === yesterday ? state.streak.count + 1 : 1;
        state.streak.last = day;
    }

    function recordLookup(word) {
        var key = word.toLowerCase();

        state.recent = [key].concat(state.recent.filter(function (w) { return w !== key; }))
                            .slice(0, MAX_RECENT);

        if (state.learned.indexOf(key) === -1) state.learned.push(key);

        touchStreak();
        saveState();
        renderStats();
        renderRecent();
    }

    // ---------------------------------------------------------------
    // stats / chips
    // ---------------------------------------------------------------

    function renderStats() {
        $("statWords").textContent = state.learned.length;
        $("statWordsFoot").textContent = state.learned.length
            ? "unique words looked up"
            : "Start your first lookup";

        var q = state.quiz;
        if (q.total > 0) {
            $("statAccuracy").textContent = Math.round((q.correct / q.total) * 100) + "%";
            $("statAccuracyFoot").textContent = q.correct + " of " + q.total + " correct";
        } else {
            $("statAccuracy").textContent = "—";
            $("statAccuracyFoot").textContent = "No attempts yet";
        }

        $("statStreak").textContent = state.streak.count;
        $("statStreakFoot").textContent = state.streak.count > 1
            ? "days in a row"
            : (state.streak.count === 1 ? "Started today" : "Come back tomorrow");
    }

    function wordChip(word, solid) {
        return el("button", {
            type: "button",
            className: "chip" + (solid ? " solid" : ""),
            text: word,
            title: "Look up " + word,
            onClick: function () { lookup(word); }
        });
    }

    function renderRecent() {
        clear(recentChips);
        if (!state.recent.length) {
            recentRow.hidden = true;
            return;
        }
        recentRow.hidden = false;
        state.recent.forEach(function (w) { recentChips.appendChild(wordChip(w)); });
    }

    function renderSaved() {
        clear(savedChips);
        savedCount.textContent = state.saved.length;

        if (!state.saved.length) {
            savedPanel.hidden = true;
            return;
        }

        savedPanel.hidden = false;
        state.saved.forEach(function (w) {
            var chip = wordChip(w, true);
            var remove = el("span", { text: " ✕", title: "Remove" });
            remove.addEventListener("click", function (ev) {
                ev.stopPropagation();
                state.saved = state.saved.filter(function (s) { return s !== w; });
                saveState();
                renderSaved();
                if (currentEntry && currentEntry.word.toLowerCase() === w) syncSaveButton();
            });
            chip.appendChild(remove);
            savedChips.appendChild(chip);
        });
    }

    // ---------------------------------------------------------------
    // word bank
    // ---------------------------------------------------------------

    var MAX_SHOWN = 300;   // cap per view so 1000+ chips never jank the page

    function lettersIn(words) {
        var seen = {};
        words.forEach(function (w) { seen[w[0].toUpperCase()] = true; });
        return Object.keys(seen).sort();
    }

    function wbMatches() {
        var q = wbSearch.value.trim().toLowerCase();

        if (q) return WORD_BANK.filter(function (w) { return w.indexOf(q) !== -1; });
        if (activeLetter) {
            return WORD_BANK.filter(function (w) {
                return w[0].toUpperCase() === activeLetter;
            });
        }
        return WORD_BANK;
    }

    function renderLetters() {
        clear(wbLetters);
        // While filtering, letter tabs would fight the search box.
        if (wbSearch.value.trim()) return;

        lettersIn(WORD_BANK).forEach(function (letter) {
            wbLetters.appendChild(el("button", {
                type: "button",
                className: "letter" + (letter === activeLetter ? " active" : ""),
                text: letter,
                role: "tab",
                "aria-selected": letter === activeLetter ? "true" : "false",
                onClick: function () {
                    activeLetter = (activeLetter === letter) ? null : letter;
                    renderWordBank();
                }
            }));
        });
    }

    function renderWordBank() {
        renderLetters();

        var matches = wbMatches();
        var shown = matches.slice(0, MAX_SHOWN);

        clear(wbList);
        shown.forEach(function (w) {
            var chip = wordChip(w);
            // Picking from the bank should get out of the way of the result.
            chip.addEventListener("click", closeWordBank);
            wbList.appendChild(chip);
        });

        wbCount.textContent = WORD_BANK.length;

        var notes = [];
        if (wordsFailed) {
            notes.push("Could not load words.json — showing a short built-in list.");
        }
        if (!matches.length) {
            notes.push("No words match that filter.");
        } else if (matches.length > shown.length) {
            notes.push("Showing " + shown.length + " of " + matches.length +
                       " — keep typing, or pick a letter, to narrow it down.");
        }

        wbNote.textContent = notes.join(" ");
        wbNote.hidden = !notes.length;
    }

    function openWordBank() {
        wordBank.hidden = false;
        wordBankBtn.setAttribute("aria-expanded", "true");

        loadWords().then(function () {
            if (!activeLetter && !wbSearch.value.trim()) {
                activeLetter = lettersIn(WORD_BANK)[0] || null;
            }
            renderWordBank();
            wbSearch.focus();
        });
    }

    function closeWordBank() {
        wordBank.hidden = true;
        wordBankBtn.setAttribute("aria-expanded", "false");
    }

    function randomWord() {
        loadWords().then(function () {
            var pool = WORD_BANK.filter(function (w) {
                return state.recent.indexOf(w) === -1;
            });
            if (!pool.length) pool = WORD_BANK;
            if (pool.length) {
                closeWordBank();
                lookup(pool[Math.floor(Math.random() * pool.length)]);
            }
        });
    }

    function renderStarters() {
        var host = $("starterGroups");
        clear(host);

        STARTERS.forEach(function (group) {
            var chips = el("div", { className: "chips" },
                group.words.map(function (w) { return wordChip(w); }));
            host.appendChild(el("div", { className: "starter-group" }, [
                el("h3", { text: group.title }),
                chips
            ]));
        });
    }

    // ---------------------------------------------------------------
    // networking
    // ---------------------------------------------------------------

    var waitTimer = null;

    function setLoading(on) {
        isLoading = on;
        learnBtn.disabled = on;
        learnBtn.classList.toggle("loading", on);
        learnBtn.querySelector(".btn-label").textContent = on ? "Thinking" : "Learn";
        skeleton.hidden = !on;

        clearTimeout(waitTimer);
        waitNote.hidden = true;

        if (on) {
            resultBox.replaceChildren();
            // A sleeping free-tier backend can take ~50s to answer the first
            // request; say so rather than spinning silently.
            waitTimer = setTimeout(function () { waitNote.hidden = false; }, 6000);
        }
    }

    function showError(message) {
        errorBox.textContent = message;
        errorBox.hidden = false;
    }

    function hideError() {
        errorBox.hidden = true;
        errorBox.textContent = "";
    }

    async function checkHealth() {
        try {
            var res = await fetch(API_BASE + "/api/health");
            var data = await res.json();

            if (data.providers && data.providers.length) {
                statusDot.className = "status-dot ok";
                statusText.textContent = "Online";
                footerProvider.textContent = "Powered by " + data.active;
            } else {
                statusDot.className = "status-dot bad";
                statusText.textContent = "No API key";
                showError("No LLM provider is configured. Add an API key to your .env file and restart the server.");
            }
        } catch (err) {
            statusDot.className = "status-dot bad";
            statusText.textContent = "Offline";
        }
    }

    function cleanTerm(term) {
        // Strip things like "ubiquitously (adverb)" down to the word itself.
        return String(term).split("(")[0].replace(/[^A-Za-z\-' ]/g, "").trim();
    }

    async function lookup(word, skipHistory) {
        if (isLoading) return;

        var raw = String(word == null ? "" : word).trim();
        var term = cleanTerm(raw);

        if (!term) {
            showError(raw
                ? "That does not look like a word — please use letters only."
                : "Please enter a word to look up.");
            input.focus();
            return;
        }

        input.value = term;
        hideError();
        emptyState.hidden = true;
        setLoading(true);

        try {
            var res = await fetch(API_BASE + "/api/vocab", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ word: term })
            });

            var data = await res.json().catch(function () { return {}; });

            if (!res.ok) {
                throw new Error(typeof data.detail === "string"
                    ? data.detail
                    : "Lookup failed (" + res.status + ").");
            }

            currentEntry = data;
            render(data);
            recordLookup(data.word || term);
            // Collapse the marketing copy but keep the live stats in view.
            hero.classList.add("compact");

            // Keep the URL shareable/bookmarkable for the current word.
            if (!skipHistory) {
                var url = "?word=" + encodeURIComponent(data.word || term);
                if (location.search !== url) history.pushState({ word: data.word || term }, "", url);
            }
        } catch (err) {
            var offline = (err && err.message === "Failed to fetch");
            showError(offline
                ? "Cannot reach the server. Make sure the backend is running on port 8000."
                : (err.message || "Something went wrong."));
            if (!state.recent.length) emptyState.hidden = false;
        } finally {
            setLoading(false);
        }
    }

    // ---------------------------------------------------------------
    // rendering the entry
    // ---------------------------------------------------------------

    function speak(word) {
        if (!("speechSynthesis" in window)) return;
        window.speechSynthesis.cancel();
        var utter = new SpeechSynthesisUtterance(word);
        utter.lang = "en-US";
        utter.rate = 0.9;
        window.speechSynthesis.speak(utter);
    }

    function isSaved(word) {
        return state.saved.indexOf(word.toLowerCase()) !== -1;
    }

    var saveBtn = null;

    function syncSaveButton() {
        if (!saveBtn || !currentEntry) return;
        var on = isSaved(currentEntry.word);
        saveBtn.classList.toggle("active", on);
        saveBtn.title = on ? "Remove from saved" : "Save this word";
        saveBtn.textContent = on ? "★" : "☆";
    }

    function textPanel(title, body, accent, bodyClass) {
        if (!body) return null;
        return el("div", { className: "panel " + (accent || "") }, [
            el("h3", { text: title }),
            el("p", { className: bodyClass || "", text: body })
        ]);
    }

    function chipBlock(title, items, clickable, note) {
        if (!items || !items.length) return null;

        var chips = el("div", { className: "chips" }, items.map(function (item) {
            if (!clickable) return el("span", { className: "chip", text: item });
            return wordChip(item);
        }));

        return el("div", { className: "block" }, [
            el("h3", { text: title }),
            note ? el("p", { className: "related-note", text: note }) : null,
            chips
        ]);
    }

    function examplesBlock(examples) {
        var rows = [
            ["Daily", examples.daily],
            ["Academic", examples.academic],
            ["Conversation", examples.conversation]
        ].filter(function (r) { return r[1]; });

        if (!rows.length) return null;

        return el("div", { className: "block" }, [
            el("h3", { text: "Examples in use" })
        ].concat(rows.map(function (r) {
            return el("div", { className: "example" }, [
                el("span", { className: "tag", text: r[0] }),
                document.createTextNode(r[1])
            ]);
        })));
    }

    function quizBlock(quiz) {
        if (!quiz || !quiz.question || !quiz.options.length) return null;

        var answered = false;
        var feedback = el("div", { className: "quiz-feedback", hidden: true });
        var buttons = [];

        function norm(s) { return String(s).trim().toLowerCase(); }

        quiz.options.forEach(function (option, index) {
            var btn = el("button", {
                type: "button",
                className: "option",
                onClick: function () {
                    if (answered) return;
                    answered = true;

                    var correct = norm(option) === norm(quiz.answer);

                    buttons.forEach(function (b) {
                        b.disabled = true;
                        var isAnswer = norm(b.dataset.value) === norm(quiz.answer);
                        if (isAnswer) b.classList.add("correct");
                        else if (b === btn) b.classList.add("wrong");
                        else b.classList.add("dim");
                    });

                    state.quiz.total += 1;
                    if (correct) state.quiz.correct += 1;
                    saveState();
                    renderStats();

                    clear(feedback);
                    feedback.className = "quiz-feedback " + (correct ? "good" : "bad");
                    feedback.appendChild(el("span", {
                        className: "verdict",
                        text: correct ? "Correct. " : "Not quite. "
                    }));
                    feedback.appendChild(document.createTextNode(
                        quiz.explanation || ("The answer is " + quiz.answer + ".")
                    ));
                    feedback.hidden = false;
                },
                dataset: { value: option }
            }, [
                el("span", { className: "marker", text: String.fromCharCode(65 + index) }),
                document.createTextNode(option)
            ]);

            buttons.push(btn);
        });

        return el("div", { className: "quiz" }, [
            el("h3", { text: "Practice question" }),
            el("p", { className: "quiz-q", text: quiz.question }),
            el("div", { className: "options" }, buttons),
            feedback
        ]);
    }

    function render(data) {
        var difficulty = (data.difficulty || "Medium").toLowerCase();

        saveBtn = el("button", {
            type: "button",
            className: "icon-btn",
            "aria-label": "Save word",
            onClick: function () {
                var key = data.word.toLowerCase();
                if (isSaved(key)) {
                    state.saved = state.saved.filter(function (s) { return s !== key; });
                } else {
                    state.saved.push(key);
                }
                saveState();
                renderSaved();
                syncSaveButton();
            }
        });

        var head = el("div", { className: "word-head" }, [
            el("div", { className: "word-top" }, [
                el("div", {}, [
                    el("div", { className: "word", text: data.word }),
                    el("div", { className: "word-sub" }, [
                        data.pronunciation ? el("span", { className: "pronunciation", text: data.pronunciation }) : null,
                        data.part_of_speech ? el("span", { className: "pos", text: data.part_of_speech }) : null,
                        el("span", { className: "badge " + difficulty, text: data.difficulty || "Medium" }),
                        data.cached ? el("span", { className: "badge meta", text: "cached" }) : null
                    ])
                ]),
                el("div", { className: "word-tools" }, [
                    el("button", {
                        type: "button",
                        className: "icon-btn",
                        title: "Hear pronunciation",
                        "aria-label": "Hear pronunciation",
                        text: "🔊",
                        onClick: function () { speak(data.word); }
                    }),
                    saveBtn
                ])
            ])
        ]);

        var memoryPanel = textPanel("Memory trick", data.memory_trick, "accent-warm");

        var body = el("div", { className: "card-body" }, [
            el("div", { className: "grid-2" }, [
                textPanel("Meaning", data.simple_meaning, "accent-violet", "lead"),
                textPanel("Bengali", data.bengali_meaning, "accent-cyan", "bengali")
            ]),

            data.gre_nuance || data.etymology
                ? el("div", { className: "grid-2 stack-gap" }, [
                    textPanel("GRE nuance", data.gre_nuance, "accent-violet"),
                    textPanel("Origin", data.etymology, "accent-cyan")
                ])
                : null,

            memoryPanel ? el("div", { className: "stack-gap" }, [memoryPanel]) : null,

            chipBlock("Synonyms", data.synonyms, true, "Tap any word to explore it."),
            chipBlock("Antonyms", data.antonyms, true),
            chipBlock("Word family", data.word_family, true),
            chipBlock("Common collocations", data.collocations, false),

            examplesBlock(data.examples || {}),
            quizBlock(data.mini_gre_question)
        ]);

        var card = el("div", { className: "card" }, [head, body]);

        resultBox.replaceChildren(card);
        syncSaveButton();
        card.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // ---------------------------------------------------------------
    // wiring
    // ---------------------------------------------------------------

    form.addEventListener("submit", function (ev) {
        ev.preventDefault();
        lookup(input.value);
    });

    wordBankBtn.addEventListener("click", function () {
        if (wordBank.hidden) openWordBank(); else closeWordBank();
    });

    wbClose.addEventListener("click", closeWordBank);
    wbRandom.addEventListener("click", randomWord);

    var searchDebounce = null;
    wbSearch.addEventListener("input", function () {
        clearTimeout(searchDebounce);
        searchDebounce = setTimeout(function () {
            if (wbSearch.value.trim()) activeLetter = null;
            renderWordBank();
        }, 120);
    });

    wbSearch.addEventListener("keydown", function (ev) {
        // Enter looks up the first match straight from the filter box.
        if (ev.key === "Enter") {
            ev.preventDefault();
            var first = wbMatches()[0];
            if (first) lookup(first);
        }
    });

    clearRecent.addEventListener("click", function () {
        state.recent = [];
        saveState();
        renderRecent();
    });

    document.addEventListener("keydown", function (ev) {
        if (ev.key === "/" && document.activeElement !== input) {
            ev.preventDefault();
            input.focus();
            input.select();
        } else if (ev.key === "Escape" && document.activeElement === input) {
            input.blur();
        }
    });

    // Back/forward between words the user has visited.
    window.addEventListener("popstate", function (ev) {
        var word = (ev.state && ev.state.word) ||
                   new URLSearchParams(location.search).get("word");
        if (word) lookup(word, true);
    });

    renderStats();
    renderRecent();
    renderSaved();
    renderStarters();
    checkHealth();

    if (state.recent.length) {
        emptyState.hidden = true;
        recentRow.hidden = false;
    }

    // Deep link: /?word=ephemeral opens straight to that entry.
    var initial = new URLSearchParams(location.search).get("word");
    if (initial) lookup(initial, true);
})();
