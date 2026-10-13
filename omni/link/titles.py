"""Keep auto-titles in the user's language for sessions started from omni.

Hermes titles a session in two stages (``agent/title_generator.py``): an instant ``derived`` title (the
first line of the opening prompt) and then an ``llm`` title from a small-model call. The model is told
to "match the user's language", but small models often answer a Korean prompt with an English title
("README.md 를 읽고 두 줄로 요약해줘." → "README.md two-line summary"), so a Korean user's session list
ends up mixing languages.

When a session's first prompt sent through this link is mostly Hangul, the link records a *title hint*
(the derived title, computed exactly like Hermes does). While the hint is open, a title without any
Hangul is shown as the hint instead; once Hermes settles an ``llm`` title without Hangul, the link
renames the session to the hint (a Korean ``llm`` title is kept, and a name the user typed always
wins). Pure helpers only; the index owns the hint lifecycle.
"""

from __future__ import annotations

import re

# Same cap and trimming as Hermes' derive_title (agent/title_generator.py MAX_DERIVED_TITLE_CHARS).
DERIVED_TITLE_CHARS = 48

_HANGUL_RE = re.compile(r"[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힣ힰ-퟿]")
_LATIN_RE = re.compile(r"[A-Za-z]")


def has_hangul(text: str | None) -> bool:
    return bool(text) and _HANGUL_RE.search(text) is not None


def mostly_hangul(text: str | None) -> bool:
    """True when words with Hangul are at least as many as words written in Latin letters only.

    Counted per whitespace-separated word, not per character: a Korean request usually carries
    long ASCII identifiers ("src/omni/link/sessions.py 의 title 처리 고쳐줘"), and a Hangul
    syllable carries far more than one Latin letter, so a character count would call it English.
    """
    hangul = latin = 0
    for word in (text or "").split():
        if _HANGUL_RE.search(word):
            hangul += 1
        elif _LATIN_RE.search(word):
            latin += 1
    return hangul > 0 and hangul >= latin


def derive_title(prompt: str | None) -> str | None:
    """Hermes' instant title for an opening prompt: its first non-empty line, whitespace collapsed,
    cut at a word boundary past half the cap (or hard at the cap) and marked with an ellipsis."""
    line = next((ln.strip() for ln in (prompt or "").splitlines() if ln.strip()), "")
    line = " ".join(line.split())
    if len(line) > DERIVED_TITLE_CHARS:
        cut = line[:DERIVED_TITLE_CHARS]
        space = cut.rfind(" ")
        line = (cut[:space] if space > DERIVED_TITLE_CHARS // 2 else cut).rstrip(" ,.;:—-") + "…"
    return line or None


def title_hint_for(prompt: str | None) -> str | None:
    """The title to keep for a session whose first prompt is ``prompt``, or None when the prompt is
    not (mostly) Korean or is a slash command (Hermes does not title those from the raw text)."""
    text = (prompt or "").strip()
    if not text or text.startswith("/") or not mostly_hangul(text):
        return None
    return derive_title(text)
