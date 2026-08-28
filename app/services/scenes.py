# SPDX-License-Identifier: Apache-2.0
"""Scenes: naming the parts of a video so each gets its own footage.

The problem this solves already had a partial answer here. `match_materials_to_script`
asks the model for keywords *in narrative order* and then downloads and
concatenates in that order, so the pictures roughly follow the words. It is a
global heuristic: one script, one keyword list, and the boundaries between
sections are wherever the clips happen to fall.

A scene makes those boundaries explicit. Each one carries its own narration, its
own search terms or its own local files, and its own share of the running time —
so "the intro" gets intro footage for as long as the intro lasts, rather than
for as long as the first two clips happen to run.

The two are alternatives, not layers. When scenes are given they decide the
terms and the material order outright, and `match_materials_to_script` has
nothing left to guess at; the pipeline says so rather than letting both run.

## What is deliberately not here

`SceneConfig` has no `transition` field. `video.combine_videos` applies ONE
transition mode across the whole timeline, so a per-scene transition could be
accepted, stored, echoed back — and silently ignored. A field that reads like a
setting and behaves like a comment is worse than its absence. It belongs here
once composition can honour it.
"""

from __future__ import annotations

from typing import Callable, Iterable, Sequence

from loguru import logger

from app.models.schema import MaterialInfo, SceneConfig


class SceneError(ValueError):
    """A scene list that cannot be acted on, with the reason a person needs."""


def normalize(scenes: Sequence[SceneConfig] | None) -> list[SceneConfig]:
    """Scenes in order, each with an id, or `[]` when none were given.

    Ids are 1-based and assigned only where the caller left them at 0, so a
    caller that numbers its own scenes keeps its numbering and one that cannot
    be bothered still gets stable ids to read in logs and errors.
    """
    if not scenes:
        return []

    ordered: list[SceneConfig] = []
    used: set[int] = {s.scene_id for s in scenes if s.scene_id}
    next_id = 1
    for scene in scenes:
        if scene.scene_id:
            ordered.append(scene)
            continue
        while next_id in used:
            next_id += 1
        used.add(next_id)
        ordered.append(scene.model_copy(update={"scene_id": next_id}))
        next_id += 1

    seen: set[int] = set()
    for scene in ordered:
        if scene.scene_id in seen:
            raise SceneError(f"two scenes share id {scene.scene_id}")
        seen.add(scene.scene_id)
    return ordered


def combined_script(scenes: Sequence[SceneConfig], fallback: str = "") -> str:
    """The narration for the whole video: every scene's script, in order.

    A scene with no script of its own contributes nothing rather than repeating
    the whole video's script — a scene that says everything is not a scene.
    Falls back to the video-level script when no scene carries one, so
    scene-per-material use (own clips, shared narration) still works.
    """
    parts = [scene.script.strip() for scene in scenes if scene.script.strip()]
    return "\n\n".join(parts) if parts else fallback


def durations(scenes: Sequence[SceneConfig], total: float) -> list[float]:
    """How long each scene runs, given the narration's real length.

    A scene may state its own duration. Whatever is left over is split evenly
    between the scenes that did not, because the alternative — scaling every
    scene to fit — silently overrides the one instruction the caller gave.

    When the stated durations already exceed the audio, they are kept and the
    unstated ones get nothing: the audio is the thing that is actually going to
    play, and a caller who over-books it should see that in the output rather
    than have it quietly rebalanced.
    """
    if not scenes:
        return []
    if total <= 0:
        return [scene.duration or 0.0 for scene in scenes]

    stated = sum(scene.duration for scene in scenes if scene.duration)
    unstated = [s for s in scenes if not s.duration]
    if stated > total and unstated:
        logger.warning(
            f"scenes ask for {stated:.1f}s but the narration is {total:.1f}s; "
            f"{len(unstated)} scene(s) without a stated duration get none"
        )
    share = max(0.0, total - stated) / len(unstated) if unstated else 0.0
    return [scene.duration if scene.duration else share for scene in scenes]


def terms_for(
    scenes: Sequence[SceneConfig],
    *,
    generate: Callable[[str, str, int], Iterable[str]],
    video_subject: str,
    per_scene: int = 3,
) -> list[list[str]]:
    """Search terms per scene: the caller's own, else asked for from its script.

    Asked for PER SCENE rather than once for the video, which is the whole
    point — a keyword list generated from the whole script cannot be attributed
    back to the section that needs it.

    A scene with neither terms nor a script of its own is an error rather than a
    silent skip: it would otherwise download nothing and shorten the video by
    however long that scene was meant to be.
    """
    resolved: list[list[str]] = []
    for scene in scenes:
        if scene.search_terms:
            resolved.append([t.strip() for t in scene.search_terms if t.strip()])
            continue
        if scene.materials:
            resolved.append([])  # its own files; nothing to search for
            continue
        if not scene.script.strip():
            raise SceneError(
                f"scene {scene.scene_id} has no search terms, no materials and no "
                "script to derive terms from"
            )
        terms = list(generate(video_subject, scene.script, per_scene) or [])
        if not terms:
            raise SceneError(f"no search terms could be generated for scene {scene.scene_id}")
        resolved.append(terms)
    return resolved


def local_materials(scenes: Sequence[SceneConfig]) -> list[MaterialInfo]:
    """Every scene's own files, in scene order."""
    found: list[MaterialInfo] = []
    for scene in scenes:
        found.extend(scene.materials or [])
    return found


def describe(scenes: Sequence[SceneConfig], budget: Sequence[float]) -> str:
    """One line per scene, for the log. Never a file path's contents."""
    lines = []
    for scene, seconds in zip(scenes, budget):
        source = (
            f"{len(scene.materials)} local file(s)" if scene.materials
            else f"terms: {', '.join(scene.search_terms)}" if scene.search_terms
            else "terms from its script"
        )
        lines.append(f"  scene {scene.scene_id}: {seconds:.1f}s, {source}")
    return "\n".join(lines)
