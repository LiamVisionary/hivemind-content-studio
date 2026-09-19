"""Word-anchored composition: a script whose elements address words, not seconds.

The problem this solves is the one that makes variant videos expensive. A
composition normally pins every caption, cut and overlay to a timestamp, so
rewriting one line of narration invalidates the whole timing sheet by hand.

Here the author never writes a timestamp. They write the words, mark the spans
and beats that carry meaning, and point elements at those names:

    <hook><HOST>Here is @{proof} the useful part @{/proof}.</hook>

    take.window(during="selection.proof")   -> (1.10, 2.34)

`proof` resolves to wherever those words actually landed in the delivered audio.
Rewrite the line, regenerate the voice, realign, and every element that pointed
at `proof` moves with it. That is the whole trick, and it is why one composition
can produce fifty variants without a timing pass.

The design follows Hypit's SVML script model (hypit-ai/hypit, Apache-2.0 with
conditions) — Segments, Roles, Dual Text, Selections, Moments and its temporal
vocabulary of Windows and Instants. This is an independent implementation of
that model against our own transcription; no Hypit code is used or required.

Alignment is the one place we deliberately differ. Hypit runs WhisperX forced
alignment, which is given the words and only has to locate them. We have
`app/services/subtitle.py` producing free-transcription word timings from
mlx-whisper, which can mishear, merge or drop a word. `align()` therefore
matches the authored tokens against the transcribed ones and interpolates
across the gaps, so a mishearing costs a little precision on that word instead
of desynchronising everything after it. Hand it forced-aligner output and the
match is exact and the interpolation never fires.
"""

from __future__ import annotations

import difflib
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Sequence

__all__ = [
    "Anchor",
    "Moment",
    "ScriptError",
    "Script",
    "Segment",
    "Selection",
    "SemanticTake",
    "Token",
    "Window",
    "align",
    "parse_script",
]


class ScriptError(ValueError):
    """The script could not be read. The message names the offending text."""


# --------------------------------------------------------------------------
# The parsed script
# --------------------------------------------------------------------------


@dataclass
class Token:
    """One authored unit: what the viewer reads and what the voice says.

    The two sides come apart because they genuinely differ. `<API | A P I>`
    shows "API" and pronounces the letters; `<2026 | twenty twenty six>` shows
    a compact year. A token with no `spoken` side is metadata that takes no
    time; a token with no `display` side is heard but never captioned.
    """

    display: str = ""
    spoken: str = ""
    attributes: dict[str, Any] = field(default_factory=dict)
    cue_break_after: bool = False
    role: str | None = None
    segment: str = ""
    # Index among the script's spoken tokens. This is the axis alignment works
    # on, and -1 means the token contributes no speech and so has no time.
    speech_index: int = -1
    start: float | None = None
    end: float | None = None

    @property
    def is_spoken(self) -> bool:
        return bool(self.spoken.strip())

    @property
    def is_displayed(self) -> bool:
        return bool(self.display.strip())


@dataclass
class Anchor:
    """One semantic boundary: an edge of a spoken token.

    `edge="start"` means the start of token `index`; `edge="end"` means the end
    of token `index`. Markers choose an adjacent boundary rather than inventing
    a position, so a marker always names a real word edge and never a point
    inside a word.
    """

    index: int
    edge: str  # "start" | "end"


@dataclass
class Selection:
    """A named span of meaning, such as the claim a demonstration covers."""

    name: str
    open_at: Anchor
    close_at: Anchor


@dataclass
class Moment:
    """A named point, such as the beat a verdict lands on."""

    name: str
    at: Anchor


@dataclass
class Segment:
    """A performable passage. Its accepted media becomes one aligned take."""

    name: str
    tokens: list[Token] = field(default_factory=list)

    @property
    def spoken_tokens(self) -> list[Token]:
        return [t for t in self.tokens if t.is_spoken]

    @property
    def dialogue(self) -> str:
        """Role-aware text for a speaking model, using the spoken side.

        This is what a video or TTS model is asked to perform, so it carries
        the pronunciation side and the turn labels and nothing else.
        """
        lines: list[str] = []
        current: str | None = None
        buffer: list[str] = []

        def flush() -> None:
            if not buffer:
                return
            body = _join(buffer)
            lines.append(f"{current}: {body}" if current else body)
            buffer.clear()

        for token in self.tokens:
            if not token.is_spoken:
                continue
            if token.role != current:
                flush()
                current = token.role
            buffer.append(token.spoken)
        flush()
        return "\n".join(lines)

    @property
    def speech(self) -> str:
        """Pronunciation only, with no turn labels — what `measure` counts."""
        return _join([t.spoken for t in self.tokens if t.is_spoken])

    @property
    def caption_text(self) -> str:
        """The display side, which is what a viewer actually reads."""
        return _join([t.display for t in self.tokens if t.is_displayed])


@dataclass
class Script:
    """The words the video will say, and the meanings marked inside them.

    A script holds no timecodes, no media and no prompts. Everything timed is
    derived from it once real audio exists.
    """

    segments: list[Segment] = field(default_factory=list)
    selections: dict[str, Selection] = field(default_factory=dict)
    moments: dict[str, Moment] = field(default_factory=dict)

    def segment(self, name: str) -> Segment:
        for seg in self.segments:
            if seg.name == name:
                return seg
        raise KeyError(f"No segment named {name!r}")

    @property
    def tokens(self) -> list[Token]:
        return [t for seg in self.segments for t in seg.tokens]

    @property
    def spoken_tokens(self) -> list[Token]:
        return [t for t in self.tokens if t.is_spoken]

    @property
    def speech(self) -> str:
        return _join([t.spoken for t in self.spoken_tokens])

    def caption_cues(self) -> list[list[Token]]:
        """Displayed tokens grouped into the blocks a viewer reads at once.

        A cue ends where the author wrote `||`, where the speaker changes, and
        where a segment ends. Those are the three places a reading break is
        already implied, which is why most scripts need no `||` at all.
        """
        cues: list[list[Token]] = []
        current: list[Token] = []
        last_role: str | None = None
        last_segment: str | None = None
        for token in self.tokens:
            if not token.is_displayed:
                # A speech-only token still ends a cue if the author broke there.
                if token.cue_break_after and current:
                    cues.append(current)
                    current = []
                continue
            changed = current and (token.role != last_role or token.segment != last_segment)
            if changed:
                cues.append(current)
                current = []
            current.append(token)
            last_role, last_segment = token.role, token.segment
            if token.cue_break_after:
                cues.append(current)
                current = []
        if current:
            cues.append(current)
        return cues


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------

# Markers are `@{...}` with `/`, `~` and `!` inside. They contribute no text and
# no whitespace, so `是的@{part}就是这样` stays one joined run.
_MARKER = re.compile(r"@\{(/?)(~?)([A-Za-z0-9_-]+)(!?)(~?)\}")
# A tag is a segment open/close, a self-closing segment, a role cue, or dual
# text. Dual text is the only one containing an unescaped `|`.
_TAG = re.compile(r"<(/?)([^<>]*?)(/?)>")
_ATTRS = re.compile(r"\{([^{}]*)\}$")
_ESCAPES = {"@": "@", "<": "<", ">": ">", "{": "{", "}": "}", "|": "|", "\\": "\\"}
# CJK ranges where each character is its own lexical unit, so prose in these
# scripts needs no spaces to be tokenised.
_CJK = (
    (0x3040, 0x30FF),  # kana
    (0x3400, 0x4DBF),  # CJK ext A
    (0x4E00, 0x9FFF),  # CJK unified
    (0xF900, 0xFAFF),  # compatibility ideographs
)


def _is_cjk(char: str) -> bool:
    point = ord(char)
    return any(low <= point <= high for low, high in _CJK)


def _join(parts: Iterable[str]) -> str:
    """Join authored runs the way the script's languages want them joined.

    English needs the space it was written with; Chinese does not take one
    between characters. Joining on a single space would put gaps inside Chinese
    words, and joining on nothing would run English words together.
    """
    out = ""
    for part in parts:
        part = part.strip()
        if not part:
            continue
        if out and not (_is_cjk(out[-1]) and _is_cjk(part[0])):
            out += " "
        out += part
    return out


def _unescape(text: str) -> str:
    out: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text) and text[index + 1] in _ESCAPES:
            out.append(_ESCAPES[text[index + 1]])
            index += 2
            continue
        out.append(char)
        index += 1
    return "".join(out)


def _split_unescaped(text: str, sep: str) -> list[str]:
    parts: list[str] = []
    buffer: list[str] = []
    index = 0
    while index < len(text):
        if text[index] == "\\" and index + 1 < len(text):
            buffer.append(text[index : index + 2])
            index += 2
            continue
        if text.startswith(sep, index):
            parts.append("".join(buffer))
            buffer = []
            index += len(sep)
            continue
        buffer.append(text[index])
        index += 1
    parts.append("".join(buffer))
    return parts


def _is_punctuation(char: str) -> bool:
    return not char.isalnum() and not char.isspace() and not _is_cjk(char)


def _words(text: str) -> Iterator[str]:
    """Split a run of prose into speech tokens.

    Two rules, both from the need for a marker or attribute to land on a whole
    word. Punctuation never starts a token — it attaches to the word before it,
    so `化。` and `Hello,` are one unit each, and `word-anchored`, `don't` and
    `3.5` stay whole. A CJK character always starts one, so Chinese prose needs
    no spaces to be read.
    """
    tokens: list[str] = []
    buffer = ""
    index = 0
    while index < len(text):
        char = text[index]
        # An escape is still written `\@` here — unescaping happens after
        # tokenising — and the author escaped it to make it literal text, so it
        # behaves like an ordinary character and may start a word. Without this,
        # `Follow us \@hypit.` puts the handle's `@` on the end of "us".
        escaped = char == "\\" and index + 1 < len(text) and text[index + 1] in _ESCAPES
        if escaped:
            if buffer and _is_cjk(buffer[-1]):
                tokens.append(buffer)
                buffer = ""
            buffer += text[index : index + 2]
            index += 2
            continue
        index += 1
        if char.isspace():
            if buffer:
                tokens.append(buffer)
                buffer = ""
            continue
        if _is_cjk(char):
            if buffer:
                tokens.append(buffer)
            buffer = char
            continue
        if _is_punctuation(char):
            if buffer:
                buffer += char
            elif tokens:
                tokens[-1] += char
            else:
                buffer = char
            continue
        if buffer and _is_cjk(buffer[-1]):
            tokens.append(buffer)
            buffer = ""
        buffer += char
    if buffer:
        tokens.append(buffer)
    yield from tokens


def _parse_attributes(word: str) -> tuple[str, dict[str, Any]]:
    """Pull `word{emphasis,importance=2}` apart into the word and its roles."""
    match = _ATTRS.search(word)
    if not match:
        return word, {}
    attributes: dict[str, Any] = {}
    for item in match.group(1).split(","):
        item = item.strip()
        if not item:
            continue
        if "=" in item:
            key, _, raw = item.partition("=")
            attributes[key.strip()] = _coerce(raw.strip())
        else:
            attributes[item] = True
    return word[: match.start()], attributes


def _coerce(raw: str) -> Any:
    for cast in (int, float):
        try:
            return cast(raw)
        except ValueError:
            continue
    if raw in ("true", "false"):
        return raw == "true"
    return raw


def parse_script(source: str) -> Script:
    """Read a word-anchored script.

    Grammar, all of it:

    ==========================  ==================================================
    ``<opening>...</opening>``   a segment; all prose lives inside one
    ``<pause/>``                 a wordless segment that still has boundaries
    ``<HOST>``                   a role cue; applies until the next one
    ``<API | A P I>``            dual text: displayed | pronounced
    ``<name|>``                  one unit, same wording both sides
    ``< | aside>``               spoken, never captioned
    ``||``                       a caption cue handoff
    ``word{emphasis}``           roles for a caption family to interpret
    ``@{proof} … @{/proof}``     a selection: a named span
    ``@{claim!}``                a moment: a named point
    ==========================  ==================================================

    A leading `~` moves a marker to the previous word's end; a trailing `~` on
    a close moves it to the next word's start.
    """
    script = Script()
    segment: Segment | None = None
    role: str | None = None
    speech_index = 0
    # Markers seen before the next spoken token arrives. A marker that wants
    # the *previous* word's end can be resolved at once; one that wants the
    # next word's start has to wait for it.
    open_selections: dict[str, Anchor] = {}
    pending_break = False

    def last_token() -> Token | None:
        if segment and segment.tokens:
            for token in reversed(segment.tokens):
                if token.is_spoken:
                    return token
        for seg in reversed(script.segments):
            for token in reversed(seg.tokens):
                if token.is_spoken:
                    return token
        return None

    def add(token: Token) -> None:
        nonlocal speech_index, pending_break
        if segment is None:
            raise ScriptError(f"Text outside a segment: {token.display or token.spoken!r}")
        token.segment = segment.name
        token.role = role
        if token.is_spoken:
            token.speech_index = speech_index
            speech_index += 1
        if pending_break:
            # The break was authored before this token, so it closes the cue
            # that ended with the previous one.
            previous = next((t for t in reversed(segment.tokens) if t.is_displayed), None)
            if previous is not None:
                previous.cue_break_after = True
            pending_break = False
        segment.tokens.append(token)

    def record_marker(close: str, lead: str, name: str, bang: str, trail: str) -> None:
        # "next word's start" is the token that has not arrived yet, which is
        # exactly the current speech_index.
        next_start = Anchor(speech_index, "start")
        previous = last_token()
        previous_end = Anchor(previous.speech_index, "end") if previous else Anchor(0, "start")
        if bang:
            anchor = previous_end if lead else next_start
            if name in script.moments or name in script.selections:
                raise ScriptError(f"Marker name {name!r} is used twice")
            script.moments[name] = Moment(name, anchor)
            return
        if close:
            anchor = next_start if trail else previous_end
            opened = open_selections.pop(name, None)
            if opened is None:
                raise ScriptError(f"Selection {name!r} is closed but never opened")
            script.selections[name] = Selection(name, opened, anchor)
            return
        if name in script.moments or name in script.selections or name in open_selections:
            raise ScriptError(f"Marker name {name!r} is used twice")
        open_selections[name] = previous_end if lead else next_start

    # Strip comments before anything else; they enter no projection.
    source = re.sub(r"<!--.*?-->", "", source, flags=re.S)

    position = 0
    after_marker = False
    while position < len(source):
        tag = _TAG.search(source, position)
        chunk = source[position : tag.start()] if tag else source[position:]
        # Prose between tags: markers, cue breaks and words.
        cursor = 0
        while cursor < len(chunk):
            marker = _MARKER.search(chunk, cursor)
            text = chunk[cursor : marker.start()] if marker else chunk[cursor:]
            for piece_index, piece in enumerate(_split_unescaped(text, "||")):
                if piece_index:
                    if segment is None:
                        raise ScriptError("A cue break sits outside a segment")
                    previous = next((t for t in reversed(segment.tokens) if t.is_displayed), None)
                    if previous is None:
                        pending_break = True
                    else:
                        previous.cue_break_after = True
                else:
                    # `... part @{/proof}, and ...` — the comma abuts the marker,
                    # so it belongs to "part". A marker takes no time and must
                    # not turn attached punctuation into its own speech unit.
                    piece = _reattach_punctuation(piece, last_token() if after_marker else None)
                for word in _words(piece):
                    body, attributes = _parse_attributes(word)
                    body = _unescape(body)
                    if not body:
                        continue
                    add(Token(display=body, spoken=body, attributes=attributes))
            if not marker:
                after_marker = False
                break
            record_marker(*marker.groups())
            after_marker = True
            cursor = marker.end()
        if not tag:
            break

        closing, body, self_closing = tag.groups()
        position = tag.end()
        raw = body.strip()
        if closing:
            if segment is None or segment.name != raw:
                raise ScriptError(f"Unexpected closing tag </{raw}>")
            script.segments.append(segment)
            segment, role = None, None
            continue
        if "|" in _without_escapes(body):
            # Dual text. The display side owns attributes and the spoken side
            # owns pronunciation; either side may be empty.
            display_raw, _, spoken_raw = _partition_unescaped(body)
            display_raw = display_raw.strip()
            spoken_raw = spoken_raw.strip()
            if not spoken_raw and display_raw:
                spoken_raw = display_raw
            display, attributes = _parse_attributes(display_raw)
            add(
                Token(
                    display=_unescape(display),
                    spoken=_unescape(spoken_raw),
                    attributes=attributes,
                )
            )
            continue
        if self_closing:
            if segment is not None:
                raise ScriptError(f"Segment <{raw}/> opens inside <{segment.name}>")
            script.segments.append(Segment(name=raw))
            continue
        if raw.isupper():
            # A role cue is a bare turn marker, not a paired element.
            if segment is None:
                raise ScriptError(f"Role <{raw}> sits outside a segment")
            role = raw
            continue
        if segment is not None:
            raise ScriptError(f"Segment <{raw}> opens inside <{segment.name}>")
        segment = Segment(name=raw)

    if segment is not None:
        raise ScriptError(f"Segment <{segment.name}> is never closed")
    if open_selections:
        raise ScriptError(f"Selection {sorted(open_selections)[0]!r} is opened but never closed")
    return script


def _reattach_punctuation(piece: str, previous: Token | None) -> str:
    """Move punctuation that abuts a marker back onto the word it belongs to.

    Returns the remainder of the run. CJK is left alone: each character is
    already its own token, so nothing there needs reattaching.
    """
    if previous is None or not piece or piece[0].isspace():
        return piece
    cut = 0
    while cut < len(piece) and not piece[cut].isspace() and not piece[cut].isalnum() and not _is_cjk(piece[cut]):
        cut += 1
    if not cut:
        return piece
    previous.display += piece[:cut]
    previous.spoken += piece[:cut]
    return piece[cut:]


def _without_escapes(text: str) -> str:
    """Drop escape pairs so a search only sees separators the author meant."""
    return re.sub(r"\\.", "", text)


def _partition_unescaped(text: str) -> tuple[str, str, str]:
    parts = _split_unescaped(text, "|")
    if len(parts) == 1:
        return parts[0], "", ""
    return parts[0], "|", "|".join(parts[1:])


# --------------------------------------------------------------------------
# Alignment
# --------------------------------------------------------------------------


def _normalise(word: str) -> str:
    """Reduce a word to what two transcriptions would agree on."""
    word = unicodedata.normalize("NFKC", word).casefold()
    return re.sub(r"[^\w]", "", word, flags=re.UNICODE)


def align(
    script: Script,
    heard: Sequence[Any],
    *,
    segment: str | None = None,
    offset: float = 0.0,
) -> "SemanticTake":
    """Give the authored script real times from what the audio actually says.

    `heard` is transcribed words — either the dicts mlx-whisper returns or the
    `_Word` objects in `app/services/subtitle.py`, both of which carry `word`,
    `start` and `end`.

    The authored tokens and the heard ones are matched as two sequences rather
    than zipped, because free transcription drops, merges and mishears words.
    Every authored token that matched takes the heard word's times; a run that
    did not match is spread evenly across the gap between its matched
    neighbours, so one bad word costs a little precision there and nothing
    downstream of it.
    """
    tokens = script.segment(segment).spoken_tokens if segment else script.spoken_tokens
    if not tokens:
        return SemanticTake(script=script, tokens=[], segment=segment, duration=0.0)

    heard_words = [_heard(item) for item in heard]
    matcher = difflib.SequenceMatcher(
        a=[_normalise(t.spoken) for t in tokens],
        b=[_normalise(w[0]) for w in heard_words],
        autojunk=False,
    )
    for a_start, b_start, size in matcher.get_matching_blocks():
        for step in range(size):
            token = tokens[a_start + step]
            _, start, end = heard_words[b_start + step]
            token.start, token.end = start + offset, end + offset

    _interpolate(tokens, fallback_end=(heard_words[-1][2] + offset) if heard_words else 0.0)
    duration = max((t.end or 0.0) for t in tokens)
    return SemanticTake(script=script, tokens=tokens, segment=segment, duration=duration)


def _heard(item: Any) -> tuple[str, float, float]:
    if isinstance(item, dict):
        return str(item.get("word", "")), float(item.get("start", 0.0)), float(item.get("end", 0.0))
    return str(getattr(item, "word", "")), float(getattr(item, "start", 0.0)), float(getattr(item, "end", 0.0))


def _interpolate(tokens: list[Token], *, fallback_end: float) -> None:
    """Give unmatched tokens a fair share of the time between their neighbours."""
    known = [i for i, t in enumerate(tokens) if t.start is not None]
    if not known:
        # Nothing matched at all. An even spread over the heard audio is the
        # only honest answer, and it keeps ordering intact.
        span = fallback_end / len(tokens) if tokens else 0.0
        for index, token in enumerate(tokens):
            token.start, token.end = index * span, (index + 1) * span
        return
    first, last = known[0], known[-1]
    for index in range(first):
        # Leading tokens nobody heard: share the run-up to the first match.
        head = tokens[first].start or 0.0
        span = head / (first + 1)
        tokens[index].start, tokens[index].end = index * span, (index + 1) * span
    for index in range(last + 1, len(tokens)):
        tail_start = tokens[last].end or 0.0
        span = max(fallback_end - tail_start, 0.0) / (len(tokens) - last)
        step = index - last
        tokens[index].start = tail_start + (step - 1) * span
        tokens[index].end = tail_start + step * span
    for left, right in zip(known, known[1:]):
        if right - left == 1:
            continue
        gap_start = tokens[left].end or 0.0
        gap_end = tokens[right].start or gap_start
        count = right - left - 1
        span = (gap_end - gap_start) / count if count else 0.0
        for step in range(count):
            token = tokens[left + 1 + step]
            token.start = gap_start + step * span
            token.end = gap_start + (step + 1) * span


# --------------------------------------------------------------------------
# Resolution: names to seconds and frames
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Window:
    """An interval an element occupies."""

    start: float
    end: float

    @property
    def duration(self) -> float:
        return self.end - self.start

    def frames(self, fps: float) -> tuple[int, int]:
        """Frame range, end-exclusive — the form a renderer wants."""
        return round(self.start * fps), round(self.end * fps)


_OFFSET = re.compile(r"^\s*(?P<base>[^+\-]+?)\s*(?:(?P<sign>[+-])\s*(?P<amount>[0-9.]+)(?P<unit>f|ms|s))?\s*$")


class SemanticTake:
    """An aligned performance: the script's names, now locatable in real time.

    Everything an element can ask for goes through `window()` and `instant()`,
    which take the same names the script author wrote.
    """

    def __init__(self, *, script: Script, tokens: list[Token], segment: str | None, duration: float) -> None:
        self.script = script
        self.tokens = tokens
        self.segment = segment
        self.duration = duration

    # -- anchors ---------------------------------------------------------

    def _at_anchor(self, anchor: Anchor) -> float:
        if not self.tokens:
            return 0.0
        if anchor.edge == "start":
            if anchor.index >= len(self.tokens):
                return self.duration  # the marker sat at the very end
            return self.tokens[anchor.index].start or 0.0
        if anchor.index < 0:
            return 0.0  # the marker sat at the very beginning
        index = min(anchor.index, len(self.tokens) - 1)
        return self.tokens[index].end or 0.0

    def _resolve(self, reference: str) -> float | Window:
        """Turn one name into a point or an interval.

        Accepts `selection.<name>`, `moment.<name>`, `segment.<name>`,
        `program`, `program.start`, `program.end`, and literal clock positions
        such as `2.5s`, `250ms` or `36f` (frames need `fps`, see `instant`).
        """
        reference = reference.strip()
        if reference in ("program", "program.start", "program.end"):
            if reference == "program":
                return Window(0.0, self.duration)
            return 0.0 if reference.endswith("start") else self.duration
        kind, _, name = reference.partition(".")
        if kind == "selection":
            selection = self.script.selections.get(name)
            if selection is None:
                raise KeyError(f"No selection named {name!r}")
            return Window(self._at_anchor(selection.open_at), self._at_anchor(selection.close_at))
        if kind == "moment":
            moment = self.script.moments.get(name)
            if moment is None:
                raise KeyError(f"No moment named {name!r}")
            return self._at_anchor(moment.at)
        if kind == "segment":
            spoken = [t for t in self.tokens if t.segment == name]
            if not spoken:
                raise KeyError(f"Segment {name!r} has no aligned words")
            return Window(spoken[0].start or 0.0, spoken[-1].end or 0.0)
        raise KeyError(f"Cannot resolve {reference!r}")

    # -- the author-facing vocabulary -------------------------------------

    def instant(self, at: str, *, boundary: str = "start", fps: float = 30.0) -> float:
        """One point in time.

        `at` is a name, a literal (`"2s"`, `"12f"`), or either with an offset
        (`"moment.claim + 12f"`). `boundary` picks an end of a span.
        """
        base, delta = self._split_offset(at, fps)
        value = _literal(base, fps)
        if value is None:
            resolved = self._resolve(base)
            if isinstance(resolved, Window):
                value = resolved.start if boundary == "start" else resolved.end
            else:
                value = resolved
        return value + delta

    def window(
        self,
        *,
        during: str | None = None,
        at: str | None = None,
        until: str | None = None,
        for_: str | None = None,
        fps: float = 30.0,
    ) -> Window:
        """One interval, in the forms an element actually needs.

        ``during="selection.proof"``      the span the words occupy
        ``at="moment.claim", for_="8f"``  eight frames from a beat
        ``until="moment.claim", for_="250ms"``  a beat's run-up
        ``at="2s", for_="12f"``           plain clock time, when that is the intent
        """
        if during is not None:
            base, delta = self._split_offset(during, fps)
            resolved = self._resolve(base)
            if not isinstance(resolved, Window):
                raise ValueError(f"{during!r} is a point, not a span; use at= with for_=")
            return Window(resolved.start + delta, resolved.end + delta)
        length = _duration(for_, fps) if for_ else None
        if at is not None:
            start = self.instant(at, fps=fps)
            return Window(start, start + length if length is not None else self.duration)
        if until is not None:
            end = self.instant(until, fps=fps)
            return Window(end - length if length is not None else 0.0, end)
        raise ValueError("A window needs during=, at= or until=")

    def _split_offset(self, text: str, fps: float) -> tuple[str, float]:
        match = _OFFSET.match(text)
        if not match or not match.group("sign"):
            return text.strip(), 0.0
        amount = _duration(f"{match.group('amount')}{match.group('unit')}", fps)
        return match.group("base"), amount if match.group("sign") == "+" else -amount

    # -- projections -------------------------------------------------------

    def cues(self, fps: float = 30.0) -> list[dict[str, Any]]:
        """Caption cues with real times — the shape a renderer or SRT wants.

        Each cue carries its own words so a karaoke treatment can highlight
        them one at a time; the cue's span is simply its first word's start to
        its last word's end.
        """
        out: list[dict[str, Any]] = []
        timed = {id(t): t for t in self.tokens}
        for cue in self.script.caption_cues():
            words = [
                {
                    "text": token.display,
                    "start": token.start,
                    "end": token.end,
                    "attributes": token.attributes,
                }
                for token in cue
                if id(token) in timed and token.start is not None
            ]
            if not words:
                continue
            out.append(
                {
                    "text": _join(w["text"] for w in words),
                    "start": words[0]["start"],
                    "end": words[-1]["end"],
                    "role": cue[0].role,
                    "segment": cue[0].segment,
                    "words": words,
                    "frames": Window(words[0]["start"], words[-1]["end"]).frames(fps),
                }
            )
        return out

    def anchors(self, fps: float = 30.0) -> dict[str, Any]:
        """Every named anchor, resolved. Useful for handing a frontend the map."""
        return {
            "duration": self.duration,
            "selections": {
                name: {"start": w.start, "end": w.end, "frames": w.frames(fps)}
                for name in self.script.selections
                for w in [self._resolve(f"selection.{name}")]
            },
            "moments": {
                name: {"at": t, "frame": round(t * fps)}
                for name in self.script.moments
                for t in [self._resolve(f"moment.{name}")]
            },
        }


def _literal(text: str, fps: float) -> float | None:
    match = re.fullmatch(r"([0-9]*\.?[0-9]+)(f|ms|s)", text.strip())
    if not match:
        return None
    return _duration(text, fps)


def _duration(text: str, fps: float) -> float:
    match = re.fullmatch(r"\s*([0-9]*\.?[0-9]+)(f|ms|s)\s*", text)
    if not match:
        raise ValueError(f"{text!r} is not a duration; write 12f, 250ms or 1.5s")
    amount, unit = float(match.group(1)), match.group(2)
    if unit == "f":
        return amount / fps
    if unit == "ms":
        return amount / 1000.0
    return amount
