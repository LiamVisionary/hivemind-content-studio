"""The local prompt helper, the story producer and the saved prompt library.

The idea text never leaves this machine: every route here talks to a
llama-server this process owns on 127.0.0.1. Moved out of control_api.py
unchanged (2026-09-04).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from .. import (
    hivemindos_models,
    local_llm,
    prompt_profiles,
    provider_models,
    story_producer,
    text_models,
)
from .models import (
    FavoriteBody,
    PromptHelperDescribeLookBody,
    PromptHelperGenerateBody,
    PromptHelperLoadBody,
    PromptHelperUnloadBody,
    StoryProducerBody,
)


def register(app, ctx) -> None:
    """Register the prompt helper, story producer and prompt history routes."""
    router = APIRouter()
    prompt_history = ctx.prompt_history
    require_owner = ctx.require_owner

    # ---- prompt helper -------------------------------------------------
    #
    # An app-native replacement for the ComfyUI prompt_assistant node: the owner
    # picks any GGUF on this machine and the studio runs it in a llama-server it
    # owns, so loading and unloading are things the UI can actually do. Owner
    # gated like the rest, and the idea text never leaves this machine.

    @router.get("/api/prompt-helper/runtime", dependencies=[Depends(require_owner)])
    def prompt_helper_runtime() -> dict:
        return {"ok": True, **local_llm.runtime().snapshot()}

    @router.get("/api/text-models", dependencies=[Depends(require_owner)])
    def text_model_catalog() -> dict:
        """Every model the producer can think with, from both sources at once.

        One answer rather than two calls the browser has to reconcile: the local
        runtime's snapshot, HivemindOS's catalog and credit state, and which id a
        fresh install should start on. A source that cannot answer comes back as
        a source that cannot answer, with the action that repairs it — the picker
        renders that state instead of silently offering fewer models.
        """
        return {"ok": True, **text_models.catalog()}

    @router.post("/api/prompt-helper/load", dependencies=[Depends(require_owner)])
    def prompt_helper_load(body: PromptHelperLoadBody) -> dict:
        try:
            return local_llm.runtime().load(body.modelId, unload_others=body.unloadOthers)
        except local_llm.LocalLlmError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    @router.post("/api/prompt-helper/free-comfy", dependencies=[Depends(require_owner)])
    def prompt_helper_free_comfy() -> dict:
        try:
            freed = local_llm.free_comfy_memory()
        except local_llm.LocalLlmError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        return {**freed, **local_llm.runtime().snapshot()}

    @router.post("/api/prompt-helper/unload", dependencies=[Depends(require_owner)])
    def prompt_helper_unload(body: PromptHelperUnloadBody) -> dict:
        return local_llm.runtime().unload(body.modelId)

    @router.post("/api/story/producer", dependencies=[Depends(require_owner)])
    def story_producer_ask(body: StoryProducerBody) -> dict:
        """Ask the Story studio's producer one structured question.

        Same local llama-server the prompt helper loads, and the same rule: the
        story never leaves this machine. The answer is JSON the studio renders
        as editable fields — the director edits every one of them before
        anything is generated from it, which is why a slightly wrong answer here
        is cheap and a silently empty one is not.
        """
        if body.task not in story_producer.TASKS:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown producer task. Known tasks: {', '.join(story_producer.task_ids())}",
            )
        try:
            answer = story_producer.produce(
                model_id=body.modelId, task_id=body.task,
                brief=body.brief, context=body.context,
                # Which engine runs this id is a lookup, not an assumption. A
                # HivemindOS id used to be sent to the local runtime, which
                # answered "Unknown local model" for a model that exists.
                runtime=text_models.runtime_for(body.modelId),
            )
        except hivemindos_models.HivemindosModelsError as exc:
            # The cloud producer's failures are the ones with a repair attached
            # (top up, open HivemindOS, link it). The message is HivemindOS's own
            # sentence; `remedy` is which button the studio should offer with it.
            raise HTTPException(status_code=400, detail={
                "message": str(exc), "remedy": exc.remedy, "provider": "hivemindos",
            }) from exc
        except provider_models.ProviderModelsError as exc:
            # Same contract for the owner's own accounts: `remedy` names the
            # account to reconnect or the key to add, so a refused credential
            # arrives as a button rather than as the provider's 401 text.
            raise HTTPException(status_code=400, detail={
                "message": str(exc), "remedy": exc.remedy, "provider": exc.provider,
            }) from exc
        except story_producer.StoryProducerError as exc:
            # 400 rather than 500: every one of these is something the owner can
            # act on — load a model, pick a bigger one, or ask for fewer at once.
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        # `notes` is for an answer that IS usable but is not what was asked for
        # (six concepts of eight, because the model ran out of room). The studio
        # shows them; returning the short answer silently would misrepresent it.
        return {"ok": True, "task": body.task, "result": answer.payload, "notes": list(answer.notes)}

    @router.post("/api/prompt-helper/generate", dependencies=[Depends(require_owner)])
    def prompt_helper_generate(body: PromptHelperGenerateBody) -> dict:
        idea = body.idea.strip()
        if not idea:
            raise HTTPException(status_code=400, detail="Enter an idea before using the prompt helper")
        profile = prompt_profiles.profile_for(
            body.targetModel, media_type=body.mediaType,
            first_frame=body.hasFirstFrame, last_frame=body.hasLastFrame,
        )
        # Whichever engine owns this id — the same lookup the Story producer
        # uses. The helper was locked to `local_llm`, so an owner with no GGUF
        # on the machine had a dialog that could not write anything while the
        # producer one screen over was happily using their ChatGPT plan.
        runtime = text_models.runtime_for(body.modelId)
        warnings: list[str] = []
        image = (body.imageBase64 or "").strip() or None
        # Vision is a LOCAL question: a GGUF needs a projector file beside it,
        # which is why this check exists at all. A cloud model's vision support
        # is the provider's business and asking the local runtime about an id it
        # has never seen answers "no" for every one of them.
        if image and text_models.source_of(body.modelId) == text_models.LOCAL and not runtime.model_sees_images(body.modelId):
            # Say so rather than quietly writing a prompt about an image the
            # model was never shown.
            warnings.append(
                "This model has no vision projector beside it, so the start frame was not read — "
                "the opening shot describes the idea, not the image."
            )
            image = None
        # Client-computed from the composer's character catalog; bounded here
        # because the system prompt is a token budget, not a dumping ground.
        notes = [note.strip()[:200] for note in (body.characterNotes or []) if note.strip()][:12]
        revision = (body.revision or "").strip()
        current = (body.currentPrompt or "").strip()
        refine = prompt_profiles.normalize_refine(body.refine) if body.refine is not None else None
        if refine is not None and current:
            # The prompt being refined is the authority on its own grammar. The
            # dialog's targetModel is a guess about the next run, and when that
            # guess missed reference mode the helper taught the three-field
            # format to a six-section prompt — and the model dutifully deleted
            # subject_definitions and every <Picture N> (seen live 2026-08-24).
            profile = prompt_profiles.profile_matching_prompt(current, profile)
        messages = [
            {"role": "system", "content": prompt_profiles.system_prompt(
                profile, duration_seconds=body.durationSeconds, character_notes=notes,
                continuation=body.isContinuation, previous_prompt=body.previousPrompt,
                ugc=body.ugc, references=body.references, persona_gender=body.personaGender,
                cast=body.cast)},
            {"role": "user", "content": idea},
        ]
        # Revising is the same conversation with the current draft in it, so
        # the format rules, the clip length and the start frame all still
        # apply — a note like "make it night" must not quietly cost the
        # <d> tags or push a beat past the end of the clip.
        if revision and current:
            messages += [
                {"role": "assistant", "content": current},
                {"role": "user", "content":
                    f"Change the prompt: {revision}\n\nRewrite it in full, keeping everything else "
                    "as it is and the format identical."},
            ]
        elif revision:
            raise HTTPException(
                status_code=400, detail="Write a prompt before asking for changes to it")
        elif refine is not None:
            # Refinement is the same conversation shape as a revision — the
            # draft as an assistant turn, the ask as the next user turn — so
            # the profile's format rules, the clip length and the cast all
            # still govern the rewrite.
            if not current:
                raise HTTPException(status_code=400, detail="Write a prompt before refining it")
            messages += [
                {"role": "assistant", "content": current},
                {"role": "user", "content": prompt_profiles.refine_instruction(
                    refine, media_type=body.mediaType,
                    structure=prompt_profiles.structure_clause(current))},
            ]

        def _write(history: list[dict]) -> str:
            try:
                return runtime.chat(model_id=body.modelId, messages=history, image=image)
            except local_llm.LocalLlmError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except (hivemindos_models.HivemindosModelsError, provider_models.ProviderModelsError) as exc:
                # Same contract as the producer route: a refusal that names a
                # repair reaches the browser as a button, not as a 401.
                raise HTTPException(status_code=400, detail={
                    "message": str(exc), "remedy": exc.remedy,
                    "provider": getattr(exc, "provider", "") or "hivemindos",
                }) from exc

        prompt = prompt_profiles.normalize(profile, _write(messages))
        edited = None
        if refine is not None and current:
            # A refinement must never cost the prompt its skeleton: section
            # headers, <Subject/Picture/Video/Audio N> labels and <d> dialogue
            # tags mirror the mode and the attached references. One pointed
            # retry names exactly what went missing; if the model flattens it
            # AGAIN, the owner keeps their prompt — a "refined" draft that
            # deleted the reference structure is worse than no refinement.
            lost = prompt_profiles.structure_losses(current, prompt)
            if lost:
                shown = ", ".join(lost[:6]) + ("…" if len(lost) > 6 else "")
                restore = messages + [
                    {"role": "assistant", "content": prompt},
                    {"role": "user", "content":
                        f"Your rewrite dropped structure it must keep: {shown}. Output the refined "
                        "prompt again with every section header, every <Subject/Picture/Video/Audio N> "
                        "label and every <d>[Language] dialogue tag from the original intact."},
                ]
                second = prompt_profiles.normalize(profile, _write(restore))
                if not prompt_profiles.structure_losses(current, second):
                    prompt = second
                else:
                    prompt = current
                    warnings.append(
                        f"The model kept dropping the prompt's structure ({shown}), so nothing "
                        "was changed. Try again, or steer it with the notes field."
                    )
            # An unchanged result from a plain refine is a legitimate "already
            # in shape". A DIRECTED refine (a knob turned, or owner notes) that
            # comes back byte-identical is the model ignoring the ask — push
            # once, then say which of the two happened.
            edited = prompt_profiles.changed_lines(current, prompt)
            if edited == 0 and prompt_profiles.refine_is_directed(refine):
                harder = messages + [
                    {"role": "assistant", "content": prompt},
                    {"role": "user", "content":
                        "That is the same prompt — the refinement was not applied. Apply it now "
                        "and output the full refined prompt."},
                ]
                second = prompt_profiles.normalize(profile, _write(harder))
                edited = prompt_profiles.changed_lines(current, second)
                if edited:
                    prompt = second
                else:
                    warnings.append(
                        "The model handed the prompt back unchanged. Try spelling out what to "
                        "change in the notes field, or edit the text directly."
                    )
            elif edited == 0:
                warnings.append("Already in shape — the model found nothing worth changing.")
        if revision and current:
            # A revision that comes back byte-identical is the model ignoring
            # the note, and it is indistinguishable on screen from a correct
            # edit of three words inside twenty lines. Push once, firmly, then
            # say which of the two happened.
            edited = prompt_profiles.changed_lines(current, prompt)
            if edited == 0:
                harder = messages + [
                    {"role": "assistant", "content": prompt},
                    {"role": "user", "content":
                        f"That is the same prompt — you did not apply the change. Apply it now: "
                        f"{revision}. Output the full prompt with that change made."},
                ]
                second = prompt_profiles.normalize(profile, _write(harder))
                edited = prompt_profiles.changed_lines(current, second)
                if edited:
                    prompt = second
                else:
                    warnings.append(
                        "The model handed back the same prompt — it did not apply that change. "
                        "Try naming the line to change, or edit the text directly."
                    )
        late = prompt_profiles.timeline_overruns(prompt, body.durationSeconds)
        if late:
            # One corrective pass. Small models overshoot the clip often enough
            # that handing back a timeline whose last beat never renders is the
            # common case, not the edge one — and the fix is mechanical to ask
            # for but not safe to apply by hand (moving a beat rewrites intent).
            retry = messages + [
                {"role": "assistant", "content": prompt},
                {"role": "user", "content":
                    f"Shot(s) starting at {', '.join(f'{t:g}s' for t in late)} fall outside the "
                    f"{body.durationSeconds:g}s clip, so they would never render. Rewrite the whole "
                    "prompt with the same story compressed to fit, keeping the format identical."},
            ]
            second = prompt_profiles.normalize(profile, _write(retry))
            if not prompt_profiles.timeline_overruns(second, body.durationSeconds):
                prompt = second
            else:
                prompt = second if len(prompt_profiles.timeline_overruns(second, body.durationSeconds)) < len(late) else prompt
                warnings.append(
                    f"The timeline still runs past the {body.durationSeconds:g}s clip — trim it or "
                    "regenerate before using it."
                )
        if body.isContinuation and prompt_profiles.continuation_opens_on_speech(prompt):
            # Same shape as the timeline repair above, and for the same reason:
            # the instruction says to hold the carried-over framing before
            # anything is said, and small helpers still open [Shot 1] on
            # dialogue. Asked once, then reported rather than silently shipped.
            retry = messages + [
                {"role": "assistant", "content": prompt},
                {"role": "user", "content":
                    "The clip opens on dialogue, but its first ~0.9s is the previous shot's "
                    "carried-over frames — those words would be spoken over the old picture. "
                    "Rewrite the whole prompt so [Shot 1] is a silent hold on the previous "
                    "framing with only small motion, and the first spoken line starts at 1s or "
                    "later with an explicit timestamp. Keep the scene and the format identical."},
            ]
            second = prompt_profiles.normalize(profile, _write(retry))
            if not prompt_profiles.continuation_opens_on_speech(second) \
                    and not prompt_profiles.timeline_overruns(second, body.durationSeconds):
                prompt = second
            else:
                warnings.append(
                    "This continuation starts speaking over the frames carried from the previous "
                    "shot. Move the first line a second in, or the join will read as a cut."
                )
        if body.ugc:
            # Polish and silence are the two ways a UGC prompt fails, and both
            # are things a helper does by habit rather than by choice — the
            # production vocabulary is what a video prompt normally wants, and
            # every H3 profile tells it speech is off by default. Checked in one
            # pass and repaired once, same shape as the timeline fix above:
            # naming the offending words is safe to ask for, but deleting them
            # by hand would leave the sentences around them broken.
            def _ugc_faults(text: str) -> list[str]:
                found = []
                tells = prompt_profiles.ugc_polish_tells(text)
                if tells:
                    found.append(
                        "it uses production words that give the clip away as an ad — "
                        + ", ".join(f'"{tell}"' for tell in tells)
                    )
                if prompt_profiles.ugc_missing_speech(profile, text):
                    found.append("nobody speaks in it, and a UGC clip is someone talking to camera")
                if profile.startswith("minimax-h3") and prompt_profiles.ugc_has_music(text):
                    found.append("it scores the clip, and UGC has no music — non_diegetic_music must be N/A")
                return found

            faults = _ugc_faults(prompt)
            if faults:
                retry = messages + [
                    {"role": "assistant", "content": prompt},
                    {"role": "user", "content":
                        "That prompt would not pass as something a real person filmed: "
                        + "; ".join(faults)
                        + ". Rewrite the whole prompt fixing every one of those, keeping the same "
                        "story, the same beats and the format identical."},
                ]
                second = prompt_profiles.normalize(profile, _write(retry))
                remaining = _ugc_faults(second)
                if len(remaining) < len(faults) and not prompt_profiles.timeline_overruns(
                        second, body.durationSeconds):
                    prompt, faults = second, remaining
                for fault in faults:
                    warnings.append(f"Reads as produced rather than filmed: {fault}.")
        return {
            "ok": True,
            "prompt": prompt,
            "profile": profile,
            # Say when the continuation rules were in force, so a prompt written
            # for a chained shot is visibly a different job from a fresh one.
            "profileLabel": prompt_profiles.profile_label(
                profile, continuation=body.isContinuation, ugc=body.ugc),
            "warnings": warnings,
            "sawImage": bool(image),
            # None for a fresh write; a line count for a revision, so the UI can
            # show that something happened even when the change is three words.
            "changedLines": edited,
        }

    # A Hive Persona's LOOK (hair, face, build, wardrobe in a line or two) is
    # what the cast writes into <Subject N>'s definition; written by the loaded
    # helper from the persona's own pictures so it is not a field owners skip.
    # Same runtime, same chat call, same owner gate as the prompt helper above —
    # the pictures go only to the llama-server this process spawned, and
    # neither they nor the answer are logged.
    @router.post("/api/prompt-helper/describe-look", dependencies=[Depends(require_owner)])
    def prompt_helper_describe_look(body: PromptHelperDescribeLookBody) -> dict:
        images = [str(item or "").strip() for item in (body.images or [])]
        if not images:
            raise HTTPException(status_code=422, detail="Attach at least one picture to describe")
        if len(images) > 3:
            raise HTTPException(status_code=422, detail="Attach at most three pictures — the clearest ones")
        for item in images:
            _header, separator, payload = item.partition(",")
            if not item.startswith("data:image/") or not separator or not payload.strip():
                raise HTTPException(
                    status_code=422, detail="Each picture must be an image data URL (data:image/…;base64,…)")
        runtime = local_llm.runtime()
        loaded = runtime.loaded_model_ids()
        model_id = (body.modelId or "").strip()
        if model_id and model_id not in loaded:
            raise HTTPException(status_code=409, detail=f"{model_id} is not loaded. Load it first.")
        if not model_id:
            if not loaded:
                raise HTTPException(
                    status_code=409, detail="No helper model is loaded. Load one in the prompt helper first.")
            model_id = loaded[0]
        if not runtime.model_sees_images(model_id):
            # Said up front rather than letting a blind model describe pictures
            # it was never shown — that answer reads exactly like a real one.
            raise HTTPException(
                status_code=409,
                detail="The loaded helper model cannot see pictures — load a vision-capable one "
                       "(e.g. Swarm Scout or Qwen3.6)",
            )
        count = "one photo" if len(images) == 1 else f"{len(images)} photos"
        messages = [
            {"role": "system", "content": prompt_profiles.look_system_prompt(body.gender)},
            {"role": "user", "content": f"Here {'is' if len(images) == 1 else 'are'} {count} of the same person. "
                                        "Write the description."},
        ]
        try:
            # Every picture rides the one user turn (local_llm.chat attaches
            # them all to the last user message). Cooler than the prompt
            # writer: a look is a reading of the pictures, not a draft.
            answer = runtime.chat(model_id=model_id, messages=messages, images=images, temperature=0.3)
        except local_llm.LocalLlmEmptyAnswer:
            answer = ""
        except local_llm.LocalLlmError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        look = prompt_profiles.normalize_look(answer)
        if not look:
            # Nothing came back, or nothing survived the clean-up (a model that
            # answered with just quotes or a fence). Either way: not a look.
            raise HTTPException(
                status_code=502, detail="The helper returned nothing — try again or load a larger model")
        return {"ok": True, "look": look}

    @router.get("/api/simple/prompts", dependencies=[Depends(require_owner)])
    def list_prompts(favorites: bool = False, limit: int = 200) -> dict:
        return {"ok": True, "prompts": prompt_history().list(favorites_only=favorites, limit=limit)}

    @router.post("/api/simple/prompts/{prompt_id}/favorite", dependencies=[Depends(require_owner)])
    def favorite_prompt(prompt_id: str, body: FavoriteBody) -> dict:
        try:
            return {"ok": True, "prompt": prompt_history().set_favorite(prompt_id, body.favorite)}
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None

    @router.delete("/api/simple/prompts/{prompt_id}", dependencies=[Depends(require_owner)])
    def delete_prompt(prompt_id: str) -> dict:
        try:
            prompt_history().delete(prompt_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from None
        return {"ok": True}

    app.include_router(router)
