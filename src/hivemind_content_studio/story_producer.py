"""The producer behind the Story studio: a local model asked structured questions.

The Story studio walks one production — concept, character sheets, location,
storyboard, motion script, gate. At six points along that walk it is useful to
have a second opinion that carries the whole brief: eight concepts to choose
between, the contract behind the one that won, five location directions, the
panels of a board, the timed beats of a shot, a shorter draft of the same shot.

Those are not media prompts, so they do not belong in ``prompt_profiles`` —
that module teaches a model to write for a specific *generator* (H3's six
sections, its <d> dialogue tags, its shot headers). What is asked for here is
production *thinking*, and the answer is JSON the studio renders as editable
fields rather than text anyone pastes anywhere.

Everything runs on the same local llama-server the prompt helper loads, through
``local_llm.runtime().chat``. Nothing about the story leaves the machine.

Two hard rules shape every task below:

  Options before decisions. A task that returns one answer where the studio
  asked for a comparison has skipped the only step that is cheap to redo.

  Never invent the locked facts. Once a character contract exists, later tasks
  quote it; a task that quietly re-describes a character is how the sheet and
  the board end up disagreeing about who is in the shot.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Callable

from . import hivemindos_models, local_llm


class StoryProducerError(RuntimeError):
    """The producer could not answer in a shape the studio can use."""


# The house rules every task inherits. Repeated in one place rather than in
# seven, so a change to how the producer behaves is a change to one string.
_HOUSE = (
    "You are the producer on a short-form character film. You are talking to a "
    "director who makes the taste decisions; your job is to carry the brief, "
    "draft production language, and offer options rather than verdicts.\n"
    "Rules:\n"
    "- The characters and world are the director's original IP. Never reuse a "
    "named character, world or story from an existing film, show, game or book, "
    "and never reuse an example you were shown.\n"
    "- Be concrete. A detail someone could draw beats an adjective.\n"
    "- Never restate facts the director has already locked. Quote them or leave "
    "them alone; do not redescribe a character who already has a sheet.\n"
    "- Answer with JSON only. No prose before it, no prose after it, no code "
    "fence, no commentary."
)


class ProducerTruncated(StoryProducerError):
    """The model stopped mid-answer. Distinct from "it wrote prose", because the
    two need opposite responses: prose is worth asking again for, and a cut-off
    answer asked for again the same way is cut off again.

    ``salvaged`` carries whatever finished before the cut, when the task has a
    list to recover.
    """

    def __init__(self, message: str, salvaged: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.salvaged = salvaged or None


@dataclass(frozen=True)
class Task:
    """One question the studio knows how to ask and how to render the answer to.

    ``schema`` is written into the instruction verbatim — a small local model
    follows a shown shape far more reliably than a described one. ``check``
    is the studio's own read of the answer; it raises when the shape is wrong
    so the caller can push back once with a specific complaint rather than a
    generic "that was not JSON".

    ``max_tokens`` is per task because the answers are wildly different sizes and
    the shared default is 2048 — which eight concepts of six prose fields do not
    fit, let alone a sixteen-panel board, and a reasoning model's <think> block
    is charged to the same budget. Overrunning it does not error: llama-server
    returns the truncated text with finish_reason "length", which arrives here as
    unparseable JSON after several minutes of waiting. Setting these generously
    costs nothing when the model stops early.

    ``list_key`` names the array the answer is mostly made of, when it has one.
    A truncated answer can then be salvaged down to the elements that DID
    finish — six concepts beats an error message and a lost five minutes.

    ``dict_key`` is the same idea for an answer that is an OBJECT of independent
    values rather than a list: ten written fields out of seventeen are ten fields
    the director does not have to write. Without it a cut-off fill was a total
    loss, which is what the studio reported on 2026-08-24 — minutes of waiting
    and every box still empty.

    ``shorter`` is what "answer again, shorter" means for this task. Asking for
    "half as many entries" is right for eight concepts and wrong for a fill,
    where every field was asked for on purpose and dropping half of them is the
    failure being retried.
    """

    id: str
    instruction: str
    schema: str
    check: Callable[[Any], None]
    max_tokens: int = 4000
    list_key: str = ""
    dict_key: str = ""
    shorter: str = (
        "keep every field but write each one in a few words, and give at most "
        "half as many entries"
    )


def _require_list(payload: Any, key: str, *, minimum: int = 1) -> list:
    if not isinstance(payload, dict):
        raise StoryProducerError("the answer was not a JSON object")
    rows = payload.get(key)
    if not isinstance(rows, list) or len(rows) < minimum:
        raise StoryProducerError(f'"{key}" must be a list of at least {minimum}')
    return rows


def _require_fields(rows: list, fields: tuple[str, ...], *, label: str) -> None:
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise StoryProducerError(f"{label} {index + 1} was not an object")
        missing = [field for field in fields if not str(row.get(field) or "").strip()]
        if missing:
            raise StoryProducerError(f'{label} {index + 1} is missing: {", ".join(missing)}')


def _check_concepts(payload: Any) -> None:
    rows = _require_list(payload, "concepts", minimum=2)
    _require_fields(rows, ("pair", "hook", "friction", "reward", "signature"), label="concept")


def _check_shortlist(payload: Any) -> None:
    rows = _require_list(payload, "ranked", minimum=1)
    _require_fields(rows, ("id", "why"), label="ranked entry")
    if not isinstance(payload.get("recommend"), list) or not payload["recommend"]:
        raise StoryProducerError('"recommend" must be a non-empty list of concept ids')


def _check_contract(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise StoryProducerError("the answer was not a JSON object")
    contract = payload.get("contract")
    if not isinstance(contract, dict):
        raise StoryProducerError('"contract" must be an object')
    missing = [field for field in ("pressure", "who", "goal", "other", "behavior", "reward")
               if not str(contract.get(field) or "").strip()]
    if missing:
        raise StoryProducerError(f'the contract is missing: {", ".join(missing)}')
    rows = _require_list(payload, "characters", minimum=1)
    _require_fields(rows, ("name", "silhouette", "face", "signature", "never"), label="character")


def _check_locations(payload: Any) -> None:
    rows = _require_list(payload, "directions", minimum=2)
    _require_fields(rows, ("place", "time", "depth", "lights"), label="location")
    for index, row in enumerate(rows):
        motion = row.get("motion")
        if not isinstance(motion, list) or not motion:
            raise StoryProducerError(f"location {index + 1} lists nothing that can move")


def _check_board(payload: Any) -> None:
    rows = _require_list(payload, "panels", minimum=1)
    _require_fields(rows, ("job", "verb", "reason"), label="panel")
    verbs = [str(row.get("verb") or "").strip().lower() for row in rows]
    if len(rows) > 1 and len(set(verbs)) == 1:
        raise StoryProducerError("every panel has the same action — each one needs its own dominant verb")


def _check_beats(payload: Any) -> None:
    rows = _require_list(payload, "beats", minimum=1)
    _require_fields(rows, ("action",), label="beat")
    for index, row in enumerate(rows):
        for field in ("from", "to"):
            try:
                float(row.get(field))
            except (TypeError, ValueError):
                raise StoryProducerError(f'beat {index + 1} has no numeric "{field}"') from None
    if not str(payload.get("force") or "").strip():
        raise StoryProducerError('"force" must name what is making the world move')


def _check_filled(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise StoryProducerError("the answer was not a JSON object")
    values = payload.get("values")
    if not isinstance(values, dict) or not values:
        raise StoryProducerError('"values" must be an object of field id to written text')
    written = {key: value for key, value in values.items() if str(value or "").strip()}
    if not written:
        raise StoryProducerError("every field came back empty")
    payload["values"] = written


def _check_compressed(payload: Any) -> None:
    if not isinstance(payload, dict) or not str(payload.get("script") or "").strip():
        raise StoryProducerError('"script" must be the compressed prompt')


TASKS: dict[str, Task] = {
    "concepts": Task(
        id="concepts",
        instruction=(
            "Give the director genuinely different concepts for a human-and-creature pair, "
            "from the brief below. Different means different in relationship, in silhouette "
            "and in what the small conflict IS — not the same idea in five costumes. "
            "Each concept needs: the pair, the visual hook that stops a scroll, a small "
            "everyday conflict, the emotional reward, and one signature detail that would "
            "still be readable at thumbnail size. Do not describe finished shots."
        ),
        schema=(
            '{"concepts": [{"id": "A", "title": "short name", "pair": "", "hook": "", '
            '"friction": "", "reward": "", "signature": ""}]}'
        ),
        check=_check_concepts,
        # Eight concepts of six prose fields, plus whatever a reasoning model
        # spends thinking about them first.
        max_tokens=6000,
        list_key="concepts",
    ),
    "shortlist": Task(
        id="shortlist",
        instruction=(
            "Compare the concepts below on five axes: how recognizable the pair is, how "
            "clearly the emotion reads before any context, whether there is a tenth story "
            "in this pair as well as a first, how distinct the two silhouettes are, and how "
            "many hard things one clip would have to get right. Score each 1-5, say why in "
            "one sentence, then recommend the strongest two or three by id."
        ),
        schema=(
            '{"ranked": [{"id": "A", "scores": {"recognizable": 4, "clarity": 3, '
            '"repeatable": 5, "silhouette": 4, "simplicity": 2}, "why": ""}], '
            '"recommend": ["A", "C"], "reason": ""}'
        ),
        check=_check_shortlist,
        max_tokens=4000,
        list_key="ranked",
    ),
    "contract": Task(
        id="contract",
        instruction=(
            "The director has locked one concept. Turn it into the contract every later "
            "stage will quote. The contract is one sentence in six parts: the everyday "
            "pressure, who tries what, who responds how, and what the moment becomes. "
            "Then, for each recurring character, write the identity locks: silhouette "
            "first, then face, then pattern and colour placement, then the one signature "
            "detail, then default posture and behaviour — and a never-change list naming "
            "only the things that must not drift between generations. Also write a "
            "one-sentence story promise the whole clip has to keep."
        ),
        schema=(
            '{"title": "", "promise": "", "contract": {"pressure": "", "who": "", '
            '"goal": "", "other": "", "behavior": "", "reward": ""}, '
            '"characters": [{"name": "", "role": "", "species": "", "silhouette": "", '
            '"face": "", "pattern": "", "signature": "", "behavior": "", "never": ""}]}'
        ),
        check=_check_contract,
        max_tokens=5000,
    ),
    "location": Task(
        id="location",
        instruction=(
            "Offer location directions that would each serve this contract differently. "
            "For each: the place, the time of day, the weather, the palette and its single "
            "accent, the foreground-to-background layout, the practical light sources, and "
            "a list of things in it that can physically move and what would move them. "
            "The plate will be generated EMPTY — no people, no animals — so describe the "
            "place only."
        ),
        schema=(
            '{"directions": [{"place": "", "time": "", "weather": "", "palette": "", '
            '"accent": "", "depth": "", "lights": "", "motion": ["", ""], "forbid": ""}]}'
        ),
        check=_check_locations,
        max_tokens=5000,
        list_key="directions",
    ),
    "board": Task(
        id="board",
        instruction=(
            "Build the storyboard panels for the requested format. Every panel is a "
            "different moment with its own dominant verb, its own camera distance, and a "
            "stated reason the camera is there — finish the sentence 'the viewer now needs "
            "to discover ___'. Name one thing moving in each panel. Do not repeat a "
            "composition, and do not restate what the characters look like: their sheets "
            "are attached. Also write the emotional arc as 'start feeling to end feeling'."
        ),
        schema=(
            '{"title": "", "promise": "", "arc": "", "panels": [{"n": 1, "job": "", '
            '"verb": "", "shot": "macro|close|low|overhead|wide|pullback", "reason": "", '
            '"motion": ""}]}'
        ),
        check=_check_board,
        # Sixteen panels is the largest answer this studio asks for.
        max_tokens=6000,
        list_key="panels",
    ),
    "beats": Task(
        id="beats",
        instruction=(
            "Write the motion direction for ONE generation of the stated length. The "
            "references already carry appearance and place, so spend nothing on them. "
            "Name the single force making the world move, and say what each depth does "
            "about it — the character, cloth or fur, the object being touched, the "
            "foreground, the midground, the background atmosphere, and the light. Then "
            "write the timed beats: each one has a start and end second, ONE dominant "
            "action, and the emotional result of that action. Cover the whole clip. Then "
            "the camera plan as a short list of motivated angles, and the diegetic audio "
            "— sounds made by things visible in the shot."
        ),
        schema=(
            '{"force": "", "layers": {"subject": "", "cloth": "", "contact": "", '
            '"foreground": "", "midground": "", "background": "", "light": ""}, '
            '"beats": [{"from": 0, "to": 5, "action": "", "emotion": ""}], '
            '"camera": "", "audio": "", "negatives": ""}'
        ),
        check=_check_beats,
        max_tokens=5000,
    ),
    "fill": Task(
        id="fill",
        instruction=(
            "The director is part-way through a production and wants specific blanks "
            "filled. You are given everything they have already written, keyed by field "
            "id, and the fields to write. Write ONLY those fields.\n"
            "- Fit what is already there. A field is not a fresh idea; it is the next "
            "consistent detail in a production that already has a shape.\n"
            "- Write the value itself, in the register the field is in — no field name, "
            "no label, no explanation, no quotes around it.\n"
            "- Match the length of what is already written in comparable fields. One "
            "line means one line.\n"
            "- Where a field lists allowed options, answer with exactly one of them.\n"
            "- Never contradict a locked contract, an identity lock or a never-change "
            "list. Those are decisions, not suggestions.\n"
            "- If a field genuinely cannot be written from what exists, leave it out "
            "rather than inventing a fact the rest of the production will have to live with."
        ),
        schema='{"values": {"<field id>": "the written value"}}',
        check=_check_filled,
        max_tokens=4000,
        dict_key="values",
        shorter=(
            "write every field that was asked for, each one in a few words — do "
            "not drop any of them"
        ),
    ),
    "compress": Task(
        id="compress",
        instruction=(
            "Compress the draft below to fit the stated character limit. Keep, in this "
            "order of priority: the timed actions, the emotional turn, the environmental "
            "motion and its cause, the final composition, and the necessary audio. Delete "
            "appearance, wardrobe, scene inventory, repeated adjectives and any quality "
            "language that does not change what happens. Compression is not vagueness — "
            "shorter sentences, same events. Return the compressed prompt and its exact "
            "character count."
        ),
        schema='{"script": "", "chars": 0}',
        check=_check_compressed,
        max_tokens=3000,
    ),
}


def task_ids() -> list[str]:
    return sorted(TASKS)


def system_prompt(task: Task) -> str:
    """The instruction as the model receives it: house rules, task, shape."""
    return f"{_HOUSE}\n\n{task.instruction}\n\nAnswer with exactly this JSON shape:\n{task.schema}"


# A model told "JSON only" still wraps it in a fence about a third of the time,
# and reasoning models emit a preamble before it. Both are mechanical, so they
# are repaired rather than rejected — a retry costs the user seconds of local
# inference for a slip that has one right answer.
_FENCE = re.compile(r"^\s*```(?:json)?\s*|\s*```\s*$", re.IGNORECASE)

# Closed reasoning blocks. local_llm strips these too, but only when they CLOSE
# — and the interesting case here is the one that does not, below.
_THINK_CLOSED = re.compile(r"<(think|thinking|reasoning)>.*?</\1>", re.IGNORECASE | re.DOTALL)
_THINK_OPEN = re.compile(r"<(think|thinking|reasoning)>", re.IGNORECASE)


def strip_reasoning(answer: str) -> str:
    """Everything the model wrote that is not it thinking out loud.

    An UNCLOSED opener means the model was still reasoning when it ran out of
    room. Whatever follows it is not an answer — often a half-drafted JSON
    object, which the brace scan below would otherwise happily pick up and parse
    as if it were the real one. So the tail is dropped, leaving nothing, which
    reads as the truncation it is.
    """
    body = _THINK_CLOSED.sub("", str(answer or ""))
    opener = _THINK_OPEN.search(body)
    if opener:
        body = body[: opener.start()]
    return _FENCE.sub("", body.strip()).strip()


def _spans(body: str, opener: str, closer: str, start: int) -> int:
    """Index just past the bracket at `start`, or -1 if it never closes.

    String-aware, because a brace inside a value ("a { in the prose") would
    otherwise unbalance the count and make a complete answer look truncated.
    """
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(body)):
        char = body[index]
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == opener:
            depth += 1
        elif char == closer:
            depth -= 1
            if depth == 0:
                return index + 1
    return -1


def salvage_list(body: str, key: str) -> list:
    """The elements of `key`'s array that finished, out of an answer that did not.

    A model that ran out of room after six of eight concepts wrote six perfectly
    good concepts. Throwing all of them away — after minutes of local inference
    — to report "did not answer with JSON" is the worst of both outcomes.
    """
    if not key:
        return []
    marker = re.search(rf'"{re.escape(key)}"\s*:\s*\[', body)
    if not marker:
        return []
    items: list = []
    cursor = marker.end()
    while cursor < len(body):
        opening = body.find("{", cursor)
        if opening < 0:
            break
        closing = _spans(body, "{", "}", opening)
        if closing < 0:
            break  # this element is the one that was cut off
        try:
            items.append(json.loads(body[opening:closing]))
        except json.JSONDecodeError:
            break
        cursor = closing
    return items


# One JSON string, matched where it starts rather than searched for — a salvage
# that skips forward past garbage would happily pair a key with a value from
# somewhere else in the answer.
_STRING = re.compile(r'"(?:[^"\\]|\\.)*"')


def salvage_pairs(body: str, key: str) -> dict[str, str]:
    """The key/value pairs of `key`'s object that finished, out of an answer that
    did not.

    Written for the fill task, whose answer is one flat object of field id to
    written text. Every pair in it is independent of every other, so a model that
    ran out of room after ten of seventeen wrote ten usable fields — and the
    caller can ask again for only what is still blank.

    Only string-to-string pairs are taken, and only while each one is the next
    thing in the text, so a half-written eleventh value is where this stops.
    """
    if not key:
        return {}
    marker = re.search(rf'"{re.escape(key)}"\s*:\s*\{{', body)
    if not marker:
        return {}
    pairs: dict[str, str] = {}
    cursor = marker.end()
    while True:
        cursor = _skip_space(body, cursor)
        name = _STRING.match(body, cursor)
        if not name:
            break
        cursor = _skip_space(body, name.end())
        if cursor >= len(body) or body[cursor] != ":":
            break
        cursor = _skip_space(body, cursor + 1)
        value = _STRING.match(body, cursor)
        if not value:
            break  # the value that was being written when the room ran out
        try:
            field = json.loads(name.group(0))
            written = json.loads(value.group(0))
        except json.JSONDecodeError:
            break
        if isinstance(field, str) and isinstance(written, str) and field.strip() and written.strip():
            pairs[field] = written
        cursor = _skip_space(body, value.end())
        if cursor >= len(body) or body[cursor] != ",":
            break
        cursor += 1
    return pairs


def _skip_space(body: str, index: int) -> int:
    while index < len(body) and body[index].isspace():
        index += 1
    return index


def extract_json(answer: str, *, list_key: str = "", dict_key: str = "") -> Any:
    """The JSON out of whatever the model actually said.

    Raises rather than returning None: a caller that cannot tell "no JSON" from
    "empty JSON" would render blank fields as an answer. ``ProducerTruncated``
    is raised specifically when the text starts an object it never closes, so
    the retry can ask for something SMALLER instead of asking again identically
    and being cut off in the same place.
    """
    body = strip_reasoning(answer)
    if not body:
        raise ProducerTruncated(
            "the producer spent its whole answer budget reasoning and wrote nothing — "
            "try a non-reasoning model, or ask for fewer at once"
        )
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        pass
    opening = body.find("{")
    if opening < 0:
        raise StoryProducerError(f"the producer answered with prose, not JSON: {_snippet(body)}")
    closing = _spans(body, "{", "}", opening)
    if closing > 0:
        try:
            return json.loads(body[opening:closing])
        except json.JSONDecodeError:
            pass
    # An object that never closes is a cut-off answer, not a malformed one.
    salvaged = salvage_list(body, list_key)
    if salvaged:
        raise ProducerTruncated(
            "the producer ran out of room mid-answer",
            {list_key: salvaged},
        )
    pairs = salvage_pairs(body, dict_key)
    if pairs:
        raise ProducerTruncated(
            "the producer ran out of room mid-answer",
            {dict_key: pairs},
        )
    raise ProducerTruncated(
        f"the producer ran out of room mid-answer and nothing complete survived: {_snippet(body)}"
    )


def _snippet(body: str, limit: int = 180) -> str:
    """Enough of the answer to diagnose it. Local text, local model — this never
    leaves the machine, and an error with no evidence in it cannot be acted on."""
    flat = " ".join(str(body or "").split())
    return f"{flat[:limit]}…" if len(flat) > limit else flat or "(empty)"


def build_messages(task: Task, brief: str, context: dict[str, Any] | None = None) -> list[dict[str, str]]:
    """The conversation for one ask.

    ``context`` is whatever the studio has already locked — the contract, the
    characters, the location, the board. It rides as a separate labelled block
    rather than being folded into the brief so the model can tell the facts it
    must preserve from the question it is being asked.
    """
    user = brief.strip()
    if context:
        locked = json.dumps(context, ensure_ascii=False, indent=2)
        user = f"Already locked — preserve these exactly:\n{locked}\n\n{user}" if user else \
            f"Already locked — preserve these exactly:\n{locked}"
    return [
        {"role": "system", "content": system_prompt(task)},
        {"role": "user", "content": user},
    ]


@dataclass(frozen=True)
class Answer:
    """What one ask came back with, and anything the studio should say about it.

    ``notes`` are for the honest middle ground: an answer that IS usable but is
    not what was asked for — six concepts out of eight because the model ran out
    of room. Silently returning six would misrepresent it; refusing all six after
    minutes of local inference would be worse.
    """

    payload: dict[str, Any]
    notes: tuple[str, ...] = ()


def produce(
    *,
    model_id: str,
    task_id: str,
    brief: str,
    context: dict[str, Any] | None = None,
    runtime: Any | None = None,
    temperature: float = 0.85,
) -> Answer:
    """Ask one task and return the parsed answer.

    One retry, and it is a POINTED one: the model is told what was wrong with
    its own answer rather than being asked again from scratch. A blind retry of
    a model that just returned prose returns prose again; naming the missing
    field fixes it most of the time, and when it does not the caller gets a
    message that says which field, which is something the user can act on.

    A CUT-OFF answer is retried differently — asked for something smaller —
    because repeating the same ask at the same size runs out of room in the same
    place. If the first cut-off answer had complete list elements in it, those
    are used instead of spending another few minutes on a second try.
    """
    task = TASKS.get(task_id)
    if task is None:
        raise StoryProducerError(f"Unknown producer task: {task_id}")
    engine = runtime if runtime is not None else local_llm.runtime()
    messages = build_messages(task, brief, context)

    def _ask(history: list[dict[str, str]]) -> str:
        try:
            return engine.chat(
                model_id=model_id, messages=history, temperature=temperature,
                max_tokens=task.max_tokens,
                # The shared default is 180s, which a 6000-token answer from a
                # reasoning model on a busy machine will exceed — and a timeout
                # here reads to the user exactly like a hang.
                timeout=900.0,
            )
        except local_llm.LocalLlmError as exc:
            raise StoryProducerError(str(exc)) from exc
        except hivemindos_models.HivemindosModelsError as exc:
            # A cloud failure that carries a REMEDY (no credits, HivemindOS not
            # running, not linked) is not a bad answer and must not be retried —
            # it has to reach the studio with its repair attached. Anything else
            # from that engine is an answer problem, so it joins the local path
            # and gets the same pointed retry.
            if exc.remedy:
                raise
            raise StoryProducerError(str(exc)) from exc

    def _parse(text: str) -> dict[str, Any]:
        payload = extract_json(text, list_key=task.list_key, dict_key=task.dict_key)
        task.check(payload)
        return payload

    answer = _ask(messages)
    try:
        return Answer(_parse(answer))
    except ProducerTruncated as cut:
        # Salvage first: the elements that finished are real work, and checking
        # them tells us whether they are enough on their own.
        if cut.salvaged:
            try:
                task.check(cut.salvaged)
                kept = len(next(iter(cut.salvaged.values())))
                return Answer(cut.salvaged, (
                    f"The producer ran out of room part-way through, so {kept} came back "
                    f"instead of the whole answer. Ask again for the rest.",
                ))
            except StoryProducerError:
                pass  # not enough survived to be useful; ask again, smaller
        retry = messages + [
            {"role": "user", "content":
                "Your last answer was cut off before it finished. Answer again, shorter: "
                f"{task.shorter}. Exactly this JSON shape and nothing else:\n{task.schema}"},
        ]
        second = _ask(retry)
        payload = _parse(second)
        return Answer(payload, ("The first answer was cut off, so this one was asked for shorter.",))
    except StoryProducerError as first:
        retry = messages + [
            {"role": "assistant", "content": answer},
            {"role": "user", "content":
                f"That answer could not be used: {first}. Answer again with exactly this "
                f"JSON shape and nothing else:\n{task.schema}"},
        ]
        second = _ask(retry)
        return Answer(_parse(second))
