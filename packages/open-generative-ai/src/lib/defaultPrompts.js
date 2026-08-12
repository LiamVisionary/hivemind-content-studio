// Default prompt library — the prompts that ship WITH the studio.
//
// Not user data, so deliberately not in the owner-sealed library
// (savedLibraryStore.js): these are read-only, they need no unlocked vault to
// browse, deleting is meaningless, and they update with the app rather than
// being frozen into a blob at first run. They render beside the saved prompts in
// the same Prompts menu, below a divider.
//
// A prompt is written FOR a model, not for an idea. The same 30-second street
// scene has to be prose for a cloud Seedance job, MiniMax H3's trained
// three-field format (H3 also renders the audio, so its version has to say what
// is heard), and a single flowing paragraph for LTX. So an idea appears once per
// model family, and the menu shows ONLY the variants written for the model
// currently selected — a starter is a finished prompt, not a draft to port by
// hand, so the ones for other models are hidden rather than ranked below.
//
// LENGTH IS ALSO A MODEL PROPERTY, which is why an entry is a LIST of parts
// rather than one blob of text. Only Seedance 2.5 renders 30s in one
// generation; H3 holds a scene for ~15s, LTX for ~10, and both continue a clip
// instead — H3 by pinning the previous clip's tail as motion context ("Continue
// scene"), LTX and Seedance 2.0 through their extend paths. So a 30s idea is
// split at the model's own ceiling and each part is written as what it actually
// is: part 1 opens the scene, later parts continue one already running. A
// continuation is NOT the same text with different beats — it has to re-describe
// the established scene (characters, wardrobe, location, palette, lens), because
// a prompt that stops naming them makes the model cut to an unrelated take. For
// H3 it must additionally open on a HOLD with no dialogue, since the first ~0.9s
// of a chained clip is the previous shot's pinned tail (see chainPrompt.js and
// prompt_profiles._H3_CONTINUATION_CLAUSE).
//
// Part durations are what the prompt's own timeline adds up to, and are checked
// against the beats in tests: a shot stamped at or past the end of its part is a
// beat that never renders.

import { isLtxFamilyModel, isMinimaxFamilyModel } from './videoTasks.js';

// Families a starter can be written for, and how the menu names them. Tokens,
// not model ids: Seedance ships as dozens of catalog entries and H3 as three
// workflows, and a prompt written for one reads the same on its siblings.
// Seedance 2.5 is split out from the rest of Seedance because its 30s ceiling
// changes how the prompt is written, not just how long it runs.
export const PROMPT_FAMILIES = Object.freeze({
  'seedance-2.5': 'Seedance 2.5',
  seedance: 'Seedance 2.0 / 1.5 / Lite',
  minimax: 'MiniMax H3',
  ltx: 'LTX 2.3',
});

// Verbatim from Liam's Seedance 2.5 prompt (2026-08-11), and the source text
// every other variant below is a rewrite of.
const KOREAN_HOME_VIDEO_SEEDANCE_25 = `Create a 30-second ultra-realistic candid home-video sequence of a young Korean woman in her early 20s living an ordinary late morning in a quiet Korean residential neighborhood.

SUBJECT:
Young Korean woman, natural everyday appearance, realistic skin texture, minimal makeup, black wavy hair in a messy side ponytail with wispy bangs. Faded charcoal-grey sleeveless crop top, loose high-waisted light-wash jeans, black canvas sneakers, simple black cord necklace. Warm, relaxed personality. Keep her face, body, hairstyle, clothing, and appearance perfectly consistent throughout.

SETTING:
Authentic Korean residential neighborhood — narrow concrete alleys, low-rise homes, small terraces, potted plants, laundry lines, bicycles, utility poles, overhead wires and mature trees. Quiet, lived-in atmosphere. No shops, advertisements, crowds, cafés, or commercial activity.

VISUAL STYLE:
Ultra-realistic documentary home-video footage from an early-2000s consumer DV camcorder. Imperfect handheld operation, natural camera shake, awkward framing, occasional reframing, autofocus hunting, slight lens breathing, exposure pumping between sunlight and shade, subtle motion blur, mild rolling shutter, faded colors, soft contrast, slight digital compression and sensor noise. No stabilization, no cinematic camera moves, no modern color grading. Everything must feel genuinely captured, not AI-generated.

TIMELINE:
00:00–00:05 — Outside her small house, she sits on a low concrete wall adjusting her messy ponytail. Wind moves loose strands of hair. She casually smiles while the camera struggles to lock focus.

00:05–00:10 — She walks into a narrow residential alley. A stray cat approaches. She crouches naturally, pets it and gently feeds it. Autofocus shifts imperfectly between her face and the cat.

00:10–00:15 — In a small front yard, she hangs laundry on a clothesline. Fabric moves naturally in the breeze while sunlight and cloud shadows subtly change the exposure.

00:15–00:20 — She sits on a quiet terrace with a simple ceramic coffee cup, casually watching the neighborhood and brushing loose hair behind her ear. Handheld side angle with natural camera drift.

00:20–00:25 — Close side profile. Someone off-camera casually greets her. She turns, smiles warmly, raises her hand and naturally says, “Annyeong.” The camera reacts slightly late.

00:25–00:30 — She walks slowly down a tree-lined residential lane holding her coffee. She notices the camera, gives a small genuine smile, then looks away and continues walking. The recording abruptly cuts to black mid-motion like an old camcorder being switched off.

AUDIO:
Only authentic location sound: birds, distant motorcycles, light wind, rustling leaves, faint neighborhood chatter, cat sounds, footsteps on concrete, laundry moving on the clothesline and subtle residential ambience. Natural Korean speech only. No music, narration, cinematic sound effects, or artificial sound design.

GOAL:
Make it feel like a forgotten personal home video from the early 2000s — intimate, spontaneous, imperfect, warm, mundane and deeply believable. Prioritize realistic human motion, natural facial expressions, physical interaction, environmental detail and consistent identity over cinematic beauty.`;

// The identity blocks every Seedance part repeats. Repetition is the point: a
// continuation that stops describing her renders a different woman.
const SEEDANCE_IDENTITY = `SUBJECT:
Young Korean woman, natural everyday appearance, realistic skin texture, minimal makeup, black wavy hair in a messy side ponytail with wispy bangs. Faded charcoal-grey sleeveless crop top, loose high-waisted light-wash jeans, black canvas sneakers, simple black cord necklace. Warm, relaxed personality. Keep her face, body, hairstyle, clothing, and appearance perfectly consistent throughout.

SETTING:
Authentic Korean residential neighborhood — narrow concrete alleys, low-rise homes, small terraces, potted plants, laundry lines, bicycles, utility poles, overhead wires and mature trees. Quiet, lived-in atmosphere. No shops, advertisements, crowds, cafés, or commercial activity.

VISUAL STYLE:
Ultra-realistic documentary home-video footage from an early-2000s consumer DV camcorder. Imperfect handheld operation, natural camera shake, awkward framing, occasional reframing, autofocus hunting, slight lens breathing, exposure pumping between sunlight and shade, subtle motion blur, mild rolling shutter, faded colors, soft contrast, slight digital compression and sensor noise. No stabilization, no cinematic camera moves, no modern color grading. Everything must feel genuinely captured, not AI-generated.`;

const SEEDANCE_AUDIO_GOAL = `AUDIO:
Only authentic location sound: birds, distant motorcycles, light wind, rustling leaves, faint neighborhood chatter, cat sounds, footsteps on concrete, laundry moving on the clothesline and subtle residential ambience. Natural Korean speech only. No music, narration, cinematic sound effects, or artificial sound design.

GOAL:
Make it feel like a forgotten personal home video from the early 2000s — intimate, spontaneous, imperfect, warm, mundane and deeply believable. Prioritize realistic human motion, natural facial expressions, physical interaction, environmental detail and consistent identity over cinematic beauty.`;

const KOREAN_HOME_VIDEO_SEEDANCE_A = `Create a 15-second ultra-realistic candid home-video sequence of a young Korean woman in her early 20s living an ordinary late morning in a quiet Korean residential neighborhood.

${SEEDANCE_IDENTITY}

TIMELINE:
00:00–00:05 — Outside her small house, she sits on a low concrete wall adjusting her messy ponytail. Wind moves loose strands of hair. She casually smiles while the camera struggles to lock focus.

00:05–00:10 — She walks into a narrow residential alley. A stray cat approaches. She crouches naturally, pets it and gently feeds it. Autofocus shifts imperfectly between her face and the cat.

00:10–00:15 — In a small front yard, she hangs laundry on a clothesline. Fabric moves naturally in the breeze while sunlight and cloud shadows subtly change the exposure. The clip ends mid-action with the camera still rolling.

${SEEDANCE_AUDIO_GOAL}`;

const KOREAN_HOME_VIDEO_SEEDANCE_B = `Continue the previous clip with no cut. The same recording keeps running: same woman, same clothes, same neighborhood, same camcorder, same late-morning light. Begin from the final frame of the previous clip and carry its motion forward.

${SEEDANCE_IDENTITY}

TIMELINE:
00:00–00:05 — She sits on a quiet terrace with a simple ceramic coffee cup, casually watching the neighborhood and brushing loose hair behind her ear. Handheld side angle with natural camera drift.

00:05–00:10 — Close side profile. Someone off-camera casually greets her. She turns, smiles warmly, raises her hand and naturally says, “Annyeong.” The camera reacts slightly late.

00:10–00:15 — She walks slowly down a tree-lined residential lane holding her coffee. She notices the camera, gives a small genuine smile, then looks away and continues walking. The recording abruptly cuts to black mid-motion like an old camcorder being switched off.

${SEEDANCE_AUDIO_GOAL}`;

// H3's trained format: three fields, "[Shot 1]" unstamped, later shots at
// MM:SS.mmm, a stable speaker id for anyone who talks, and no negative prompt —
// "no music" is written as non_diegetic_music: N/A, never as a prohibition.
const KOREAN_HOME_VIDEO_H3_A = `integrated_multimodal_description: Ultra-realistic documentary home-video footage shot on an early-2000s consumer DV camcorder — faded desaturated colour, soft contrast, mild digital compression and visible sensor noise, imperfect handheld operation with natural shake and awkward framing, autofocus hunting, slight lens breathing and exposure pumping between sunlight and shade, no stabilisation and no modern colour grading. [Shot 1] A Korean woman in her early twenties (S1) sits on a low concrete wall outside a small house in a quiet Korean residential neighbourhood of narrow concrete alleys, low-rise homes, potted plants and overhead wires; she has natural skin texture and almost no makeup, black wavy hair in a messy side ponytail with wispy bangs, a faded charcoal-grey sleeveless crop top, loose high-waisted light-wash jeans, black canvas sneakers and a thin black cord necklace. She reaches back with both hands and reties the ponytail while the wind lifts loose strands across her face, then smiles to herself; the camera hunts for focus, overshoots her and settles again. [Shot 2] At 00:05.000, the same woman walks into a narrow alley lined with potted plants, a leaning bicycle and a utility pole; a stray tabby cat trots up to her, she crouches down on her heels, holds out her hand, strokes its back and sets a small piece of food on the concrete, and the autofocus shifts imperfectly back and forth between her face and the animal. [Shot 3] At 00:10.000, in a small front yard she pegs a damp shirt onto a clothesline strung between two poles, the fabric swinging in the breeze while a cloud crosses the sun and the exposure pumps down and back up; the camera reframes late and clips the top of her head for a moment, still rolling as the clip ends.

overall_soundscape: Quiet lived-in residential ambience — birdsong, a distant motorcycle two streets away, light wind moving leaves and the laundry on the line, faint neighbourhood chatter. Close handling noise from the camcorder body, her footsteps on concrete, the cat's short meow, wooden pegs clicking onto the line. Her breathing and a small laugh to herself.

non_diegetic_music: N/A`;

const KOREAN_HOME_VIDEO_H3_B = `integrated_multimodal_description: Ultra-realistic documentary home-video footage shot on an early-2000s consumer DV camcorder — faded desaturated colour, soft contrast, mild digital compression and visible sensor noise, imperfect handheld operation with natural shake, autofocus hunting and exposure pumping between sunlight and shade, no stabilisation and no modern colour grading. The recording continues without a cut in the same quiet Korean residential neighbourhood of narrow concrete alleys, low-rise homes, potted plants and overhead wires, in the same late-morning light. [Shot 1] The same Korean woman in her early twenties (S1) — natural skin texture, almost no makeup, black wavy hair in a messy side ponytail with wispy bangs, a faded charcoal-grey sleeveless crop top, loose high-waisted light-wash jeans, black canvas sneakers and a thin black cord necklace — stands where the previous shot left her, the framing unchanged, breathing and shifting her weight while a strand of hair moves in the breeze; nobody speaks. [Shot 2] At 00:01.000, she sits down on a quiet terrace with a plain ceramic coffee cup held in both hands, watching the neighbourhood and tucking a loose strand of hair behind her ear; the handheld camera drifts a short distance to the side, slowly, then settles. [Shot 3] At 00:06.000, a close side profile of her face as someone off camera casually greets her; she turns towards the voice, smiles warmly and raises one hand. (S1) says: <d>[Korean] 안녕.</d> The camera reacts a moment late and swings to recentre her. [Shot 4] At 00:11.000, she walks slowly away down a tree-lined residential lane holding the coffee cup, dappled sunlight crossing her shoulders; she notices the camera, gives a small genuine smile, looks away and keeps walking, and the recording cuts abruptly to black mid-step like an old camcorder being switched off.

overall_soundscape: The same quiet residential ambience carried over — birdsong, a distant motorcycle, light wind in the leaves, faint neighbourhood chatter. Close camcorder handling noise, her footsteps on concrete, the ceramic cup clinking against her ring, fabric shifting as she sits. Her breathing and a small laugh under the greeting, then abrupt hard silence as the recording ends.

non_diegetic_music: N/A`;

// LTX wants one flowing chronological paragraph, and dialogue text does not
// belong in its visual conditioning — so the greeting is described as an action
// rather than quoted.
const KOREAN_HOME_VIDEO_LTX_A = `Handheld early-2000s DV camcorder footage, faded colour and soft contrast with visible sensor noise, autofocus hunting and exposure pumping between sunlight and shade. A Korean woman in her early twenties — messy black side ponytail with wispy bangs, faded charcoal-grey sleeveless crop top, loose light-wash jeans, black canvas sneakers — sits on a low concrete wall outside a small house in a quiet Korean residential neighbourhood, retying her ponytail with both hands while the wind lifts loose strands across her face. She smiles to herself as the camera drifts and struggles to lock focus on her. She stands, steps down and walks into a narrow concrete alley lined with potted plants, a leaning bicycle and a utility pole strung with overhead wires. The shot ends on her mid-stride, the camera still following.`;

const KOREAN_HOME_VIDEO_LTX_B = `Handheld early-2000s DV camcorder footage continuing without a cut, faded colour and soft contrast with visible sensor noise, autofocus hunting and exposure pumping. The same Korean woman in her early twenties — messy black side ponytail with wispy bangs, faded charcoal-grey sleeveless crop top, loose light-wash jeans, black canvas sneakers — crouches in the narrow alley as a stray tabby cat walks up to her, strokes its back and sets a small piece of food on the concrete, the focus shifting imperfectly between her face and the animal. She stands and moves into a small front yard, where she pegs a damp shirt onto a clothesline, the fabric swinging in the breeze as a cloud crosses the sun and the exposure dips and recovers. The camera reframes late, clipping the top of her head for a moment.`;

// ── Screen reaction (H3 REFERENCE mode) ─────────────────────────────────────
// A different H3 format from the three-field one above: reference mode was
// trained on six sections, and it is reached by ATTACHING references to the
// ordinary H3 tier rather than by picking a workflow (minimax-h3-reference is
// routing-only). One clip goes in the References menu as a reference video with
// its "sound" toggle on, which hands the graph <Video 1> for the picture and
// <Audio 1> for that clip's own soundtrack — the label the toggle spends, ahead
// of its <Video N> (see media_studio.py). Video labels start at <Video 1>, not
// <Video 0>.
//
// [audio reuse] means the attached track is reperformed rather than used as a
// timbre hint, which is what keeps the show's dialogue intelligible; the audio
// retention marker therefore comes from the copy family (fully_copy), not the
// preserved family the picture labels use.
//
// The show is a fill-in on purpose. In reference mode the model is looking at
// the clip you attached, and the guide is explicit that you describe what is
// actually there — so every [BRACKET] below has to be replaced with your own
// clip's content before generating.
const SCREEN_REACTION_SUBJECT = `<Subject 1> is a young adult woman in real-life American-anime street style: fair skin; sharp stylised makeup with bold winged eyeliner and glossy lips; wild neon-green hair in chaotic twin pigtails with loose flyaways and uneven bangs framing her face; an exaggerated cute-but-edgy anime-IRL look that never becomes a 2D cartoon. Colourful layered street fashion, dressed for an evening at home. No picture references are attached — her appearance is defined by this text only.`;

const SCREEN_REACTION_TV = `subject_definitions:
${SCREEN_REACTION_SUBJECT} She sits on a couch facing a television, her back and near shoulder toward the camera in over-the-shoulder framing.
<Video 1> is the ten-second clip from [SHOW NAME] that plays ON the television screen: [WHAT THE CLIP SHOWS — the setting, who is in frame and where they stand, the palette and the light]. <Video 1> is the screen content and nothing else: it is not a full-frame edit of the living room, and it is not an identity source for <Subject 1>.
<Audio 1> is the complete synchronised soundtrack of that same clip — [SHOW NAME] dialogue, its room tone and its effects. <Audio 1> is reused 1:1 as the target video's entire final audio track. Do not rewrite, paraphrase, mumble or re-synthesise the spoken lines, and do not build a competing living-room mix that replaces it.

summary:
[audio reuse] A live-action cinematic 16:9 over-the-shoulder shot: <Subject 1> sits on a couch watching television while the screen plays <Video 1> beat for beat, and <Audio 1> is copied 1:1 as the complete soundtrack. Real time, about ten seconds.

retention_analysis:
<Subject 1>: attribute_transfer — the neon-green pigtails, the anime-IRL styling and the over-the-shoulder couch pose come from the text above, with no picture identity source.
<Video 1>: fully_preserved as the television picture only — the [SHOW NAME] footage stays readable on the screen for the whole clip, while the living room, the couch and <Subject 1> are new and taken from nothing in it.
<Audio 1>: fully_copy — reused 1:1 as the complete final audio track, its dialogue and effects intelligible and verbatim, never a re-spoken or garbled replacement.

detailed_description:
Live-action photoreal cinematic 16:9 in a dim, cosy living room at night. [Shot 1] The camera holds a locked over-the-shoulder position behind <Subject 1> and slightly to one side: her neon-green pigtails and the edge of her near shoulder and head fill the foreground, slightly soft, and past them the television glows in the midground. The bezel and the whole screen stay inside the frame, and the picture on it is <Video 1> — [WHAT THE CLIP SHOWS, in one short clause] — playing continuously and updating in sync for the full ten seconds. Soft television light falls on the back of her hair and across the couch fabric; a low lamp and a plain wall sit behind her in the dark. She watches attentively with only small natural movement — a breath, a slight tilt of the head, one shift of weight — and never turns toward the camera. The composition does not change: no cutaway, no camera move, no push in that crops the screen, and the shot ends still holding it. The [SHOW NAME] dialogue and effects heard across the clip are the copied soundtrack itself, so do not give the on-screen characters a speaker id in this room and do not replace <Audio 1> with newly generated speech.

overall_soundscape:
The copied soundtrack from <Audio 1> runs throughout as the complete final mix — the clip's dialogue, ambience and effects, clear and unaltered. <Subject 1> says nothing, and no separate living-room bed is laid over the top.

non_diegetic_music:
N/A`;

const SCREEN_REACTION_PHONE = `subject_definitions:
${SCREEN_REACTION_SUBJECT} She is curled into the corner of a couch at night, holding a phone upright in one hand a little below eye level, the camera behind her shoulder in over-the-shoulder framing.
<Video 1> is the ten-second clip from [SHOW NAME] that plays ON the phone screen: [WHAT THE CLIP SHOWS — the setting, who is in frame and where they stand, the palette and the light]. <Video 1> is the screen content and nothing else: it is not a full-frame edit of the room, and it is not an identity source for <Subject 1>.
<Audio 1> is the complete synchronised soundtrack of that same clip — [SHOW NAME] dialogue, its room tone and its effects — playing out of the phone's small speaker. <Audio 1> is reused 1:1 as the target video's entire final audio track. Do not rewrite, paraphrase, mumble or re-synthesise the spoken lines, and do not build a competing room mix that replaces it.

summary:
[audio reuse] A live-action vertical 9:16 over-the-shoulder shot: <Subject 1> watches <Video 1> on the phone in her hand, the clip letterboxed across the middle of the upright screen and playing beat for beat, with <Audio 1> copied 1:1 as the complete soundtrack. Real time, about ten seconds.

retention_analysis:
<Subject 1>: attribute_transfer — the neon-green pigtails, the anime-IRL styling and the phone-in-hand couch pose come from the text above, with no picture identity source.
<Video 1>: fully_preserved as the phone-screen picture only — the [SHOW NAME] footage stays sharp and readable inside the letterbox for the whole clip, while the room, the phone and <Subject 1> are new and taken from nothing in it.
<Audio 1>: fully_copy — reused 1:1 as the complete final audio track, its dialogue and effects intelligible and verbatim, never a re-spoken or garbled replacement.

detailed_description:
Live-action photoreal vertical 9:16 in a dark room at night, lit almost entirely by the phone. [Shot 1] The camera holds a locked over-the-shoulder position close behind <Subject 1>: her neon-green pigtails and the curve of her shoulder frame the lower left of the picture, slightly soft, and the phone she holds in her raised hand sits in the middle third of the frame, screen square to the lens and large enough to read easily. The screen plays <Video 1> — [WHAT THE CLIP SHOWS, in one short clause] — letterboxed across the middle of the upright display with black bands above and below, updating in sync for the full ten seconds. The phone is never perfectly still: a real hand holds it, so it drifts and settles by a few millimetres, and her thumb rests along the edge of the case. Cold screen light rakes across her fingers, her jaw and the flyaway strands of her hair, and falls off into darkness a short distance behind her; a faint sheen of fingerprints catches the glow at the screen's edge without ever obscuring the picture. She watches with small natural movement — a blink, a slight tilt of the head, one shift of weight — and never turns toward the camera. The composition does not change: no cutaway, no camera move, no reframe that crops the screen or tips it out of the light. The [SHOW NAME] dialogue and effects heard across the clip are the copied soundtrack itself, so do not give the on-screen characters a speaker id in this room and do not replace <Audio 1> with newly generated speech.

overall_soundscape:
The copied soundtrack from <Audio 1> runs throughout as the complete final mix — the clip's dialogue, ambience and effects, clear and unaltered, as if coming from the phone's speaker. <Subject 1> says nothing, and no separate room bed is laid over the top.

non_diegetic_music:
N/A`;

const KOREAN_HOME_VIDEO_LTX_C = `Handheld early-2000s DV camcorder footage continuing without a cut, faded colour and soft contrast with visible sensor noise, autofocus hunting and exposure pumping. The same Korean woman in her early twenties — messy black side ponytail with wispy bangs, faded charcoal-grey sleeveless crop top, loose light-wash jeans, black canvas sneakers — sits on a quiet terrace holding a plain ceramic coffee cup in both hands, watching the neighbourhood and tucking a loose strand of hair behind her ear while the camera drifts slowly to the side. She turns towards someone off camera, smiles warmly and raises a hand in greeting, and the camera reacts a moment late and swings to recentre her. She walks slowly away down a tree-lined residential lane with the cup in her hand, dappled sunlight crossing her shoulders, glances at the camera with a small genuine smile, then looks away and keeps walking as the recording cuts abruptly to black mid-step.`;

/**
 * The shipped library.
 *
 * `idea` groups the variants of one scene; `family` decides which model they are
 * written for; `format` is the shape of the text itself, which is checked in
 * tests because a starter in the wrong shape is a broken generation, not a
 * rough draft; `requires` names media the prompt cannot run without; `parts` is
 * the scene split at that model's own length ceiling — one entry for a model
 * that can render the whole thing in a single generation.
 */
export const DEFAULT_PROMPTS = Object.freeze([
  Object.freeze({
    id: 'korean-home-video-seedance-25',
    idea: 'korean-home-video',
    section: 'video',
    family: 'seedance-2.5',
    format: 'prose',
    name: 'Korean neighbourhood home video',
    summary: 'Candid early-2000s camcorder day, six beats',
    note: 'The whole 30s in one generation — Seedance 2.5 takes 4-30s.',
    parts: [Object.freeze({
      label: 'Whole clip',
      durationSeconds: 30,
      prompt: KOREAN_HOME_VIDEO_SEEDANCE_25,
    })],
  }),
  Object.freeze({
    id: 'korean-home-video-seedance',
    idea: 'korean-home-video',
    section: 'video',
    family: 'seedance',
    format: 'prose',
    name: 'Korean neighbourhood home video',
    summary: 'Candid early-2000s camcorder day, six beats',
    note: 'Seedance 2.0 and older render 15s at a time, so the scene is split in two.',
    parts: [
      Object.freeze({
        label: 'Beats 1-3',
        durationSeconds: 15,
        prompt: KOREAN_HOME_VIDEO_SEEDANCE_A,
        note: 'Set duration to 15s and generate.',
      }),
      Object.freeze({
        label: 'Beats 4-6',
        durationSeconds: 15,
        continuation: true,
        prompt: KOREAN_HOME_VIDEO_SEEDANCE_B,
        note: 'Press Extend on the part 1 result (Seedance 2.0 Extend continues from that generation), then paste this.',
      }),
    ],
  }),
  Object.freeze({
    id: 'korean-home-video-h3',
    idea: 'korean-home-video',
    section: 'video',
    family: 'minimax',
    format: 'h3-fields',
    name: 'Korean neighbourhood home video',
    summary: 'Same six beats in H3 three-field format',
    note: 'H3 holds a scene for ~15s, so the day is two chained clips. Part 2 opens on a hold because the first ~0.9s is the pinned tail of part 1.',
    parts: [
      Object.freeze({
        label: 'Beats 1-3',
        durationSeconds: 15,
        prompt: KOREAN_HOME_VIDEO_H3_A,
        note: 'Set duration to 15s and generate.',
      }),
      Object.freeze({
        label: 'Beats 4-6',
        durationSeconds: 15,
        continuation: true,
        prompt: KOREAN_HOME_VIDEO_H3_B,
        note: 'Press Continue scene on the part 1 result to pin its tail as motion context, then paste this over the armed prompt.',
      }),
    ],
  }),
  Object.freeze({
    id: 'screen-reaction-tv-h3',
    idea: 'screen-reaction',
    section: 'video',
    family: 'minimax',
    format: 'h3-reference',
    name: 'Watching a show on TV',
    summary: 'Over-the-shoulder reaction, clip playing on the screen',
    requires: 'One reference video with its sound on',
    note: 'Reference mode: attach the clip in References as a reference video and turn on its “sound” toggle — that gives the prompt <Video 1> and <Audio 1>, and routes the job to the H3 reference workflow. Replace every [BRACKET] with your own clip before generating; the model is looking at what you attached.',
    parts: [Object.freeze({
      label: 'Whole clip',
      durationSeconds: 10,
      prompt: SCREEN_REACTION_TV,
    })],
  }),
  Object.freeze({
    id: 'screen-reaction-phone-h3',
    idea: 'screen-reaction',
    section: 'video',
    family: 'minimax',
    format: 'h3-reference',
    name: 'Watching a show on a phone',
    summary: 'Vertical 9:16 over-the-shoulder, clip on the phone in hand',
    requires: 'One reference video with its sound on',
    note: 'Same reference setup as the TV version — reference video with “sound” on — but framed 9:16 for a vertical feed, with the clip letterboxed on an upright phone. Set the aspect ratio to 9:16. Replace every [BRACKET] with your own clip before generating.',
    parts: [Object.freeze({
      label: 'Whole clip',
      durationSeconds: 10,
      prompt: SCREEN_REACTION_PHONE,
    })],
  }),
  Object.freeze({
    id: 'korean-home-video-ltx',
    idea: 'korean-home-video',
    section: 'video',
    family: 'ltx',
    format: 'paragraph',
    name: 'Korean neighbourhood home video',
    summary: 'Same day as three LTX paragraphs',
    note: 'LTX workflows top out at 10s here, so the scene is three clips joined with the Extend task. Greetings are described, not quoted — dialogue text does not belong in LTX visual conditioning.',
    parts: [
      Object.freeze({
        label: 'Beats 1-2',
        durationSeconds: 10,
        prompt: KOREAN_HOME_VIDEO_LTX_A,
        note: 'Set duration to 10s and generate.',
      }),
      Object.freeze({
        label: 'Beats 3-4',
        durationSeconds: 10,
        continuation: true,
        prompt: KOREAN_HOME_VIDEO_LTX_B,
        note: 'Switch the task to Extend with the part 1 clip as the video to extend, then paste this.',
      }),
      Object.freeze({
        label: 'Beats 5-6',
        durationSeconds: 10,
        continuation: true,
        prompt: KOREAN_HOME_VIDEO_LTX_C,
        note: 'Extend again from the part 2 clip, then paste this.',
      }),
    ],
  }),
]);

/**
 * Which starter-prompt family a studio setup (or catalog model entry) belongs
 * to, or '' for a model no starter is written for.
 *
 * H3 and LTX are asked through the same registry-family predicates the rest of
 * the studio uses, so every workflow in those families matches. Seedance is a
 * CLOUD model with no registry family at all, so it is matched on its id prefix
 * — deliberately not on the cloud catalog's own `family` field, which is a
 * colliding namespace (see videoTasks.js). 2.5 is its own family because it is
 * the only one that renders the full 30s in a single generation.
 *
 * 10Eros is excluded from `ltx`: it shares the registry family but wants the
 * scene-script style rather than LTX 2.3's paragraph (see prompt_profiles.py),
 * so no starter here is written for it.
 */
export function promptFamilyOf(source) {
  if (!source) return '';
  const id = String(source.modelId ?? source.id ?? '');
  if (isMinimaxFamilyModel(source)) return 'minimax';
  if (isLtxFamilyModel(source)) return /eros/i.test(id) ? '' : 'ltx';
  if (/^seedance-2\.5-/.test(id)) return 'seedance-2.5';
  return /^seedance-/.test(id) ? 'seedance' : '';
}

/** How long the whole idea runs once every part has been generated. */
export function defaultPromptTotalSeconds(entry) {
  return (entry?.parts || []).reduce((total, part) => total + (Number(part.durationSeconds) || 0), 0);
}

/**
 * The starters written for the model currently selected, and nothing else.
 *
 * Filtered, not ranked. A starter is a finished prompt in one model's format —
 * H3's three fields pasted into a Seedance box is not a rough draft, it is
 * garbage with field names in it — so an entry for another model is noise at
 * best and a broken generation at worst. A model no starter targets shows no
 * starter section at all.
 */
export function defaultPromptsFor(section, source) {
  const family = promptFamilyOf(source);
  if (!family) return [];
  return DEFAULT_PROMPTS.filter((entry) => entry.section === section && entry.family === family);
}

/** "Seedance 2.5 · 30s · Candid early-2000s camcorder day" for the menu row. */
export function describeDefaultPrompt(entry) {
  const parts = entry?.parts?.length || 0;
  const seconds = defaultPromptTotalSeconds(entry);
  return [
    PROMPT_FAMILIES[entry.family] || entry.family,
    parts > 1 ? `${seconds}s in ${parts} parts` : `${seconds}s`,
    entry.summary,
  ].filter(Boolean).join(' · ');
}

/** "Part 2 · Beats 4-6 · 15s" for a part button. */
export function describeDefaultPromptPart(part, index) {
  return [`Part ${index + 1}`, part.label, `${part.durationSeconds}s`].filter(Boolean).join(' · ');
}
