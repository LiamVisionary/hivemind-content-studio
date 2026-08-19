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

// Verbatim from Liam's Seedance 2.5 travel-vlog prompt (2026-08-11). Kept as
// written, including the "No cinematic commercial aesthetic / No face changes"
// block: Seedance takes prohibitions in the prompt, unlike H3 where "no X" is
// documented not to work. Prompt style is not portable between models, so the
// H3 rule is deliberately NOT applied here.
//
// It is reference-driven ("the woman from the reference image"), which means it
// runs on an image tier, not plain text-to-video — see the entry note for the
// two ways to supply her.
const TRAVEL_VLOG_SEEDANCE_25 = `An ultra-realistic handheld travel vlog filmed by a friend following the main character throughout the day. Use the woman from the reference image as the main subject. Maintain her exact facial identity, hairstyle, facial features, and body proportions consistently throughout the entire video.

The camera should feel like a genuine personal vlog camera rather than a commercial production. Use natural handheld movement, casual framing, subtle imperfections in human camera operation, and an authentic everyday atmosphere. Avoid scripted acting. The woman behaves naturally, interacting with her surroundings as she would in a real travel vlog.

0–5s: Morning departure. The woman leaves a cozy apartment carrying a small backpack. She checks her phone, smiles toward the camera, adjusts her hair, and begins walking outside. The camera follows her from behind with slight natural shakiness, as if a friend is casually filming her. Morning sunlight fills the scene, with quiet neighborhood streets and people beginning their day.

5–12s: Exploring the city. The camera follows her through local streets. She visits a small café, buys a drink, briefly talks to the camera, and laughs naturally. She continues through a street market, looks around at small shops, and takes casual photos. The camera remains close to her, capturing spontaneous everyday moments.

12–20s: Arriving at the beach. She takes public transportation or walks toward the coast. The environment gradually transitions from busy city streets into a peaceful seaside town. The ocean breeze naturally moves her hair. She becomes visibly excited when she sees the ocean for the first time. The camera follows her along the beach as she picks up a seashell, watches the waves, and naturally interacts with people nearby.

20–27s: Summer beach afternoon. She meets friends at the beach. Everyone chats, laughs, and plays casually near the water. The camera naturally moves between the group, capturing genuine candid moments rather than staged performances. She eventually looks back toward the camera and smiles naturally.

27–30s: Ending moment. Golden-hour sunset. She sits near the ocean holding a drink while quietly watching the sunset. The camera slowly moves backward, gradually revealing the beach, waves, and peaceful evening atmosphere. The final moment should feel like a genuine personal travel memory captured spontaneously.

Visual style: Ultra-realistic authentic travel-vlog footage. Ultra-realistic smartphone or mirrorless-camera appearance. Natural daylight and believable environmental lighting. Casual handheld movement with subtle camera shake and imperfect human operation. Genuine human reactions and spontaneous interactions. Documentary-level realism with highly detailed skin, hair, clothing, environments, and natural textures.

No cinematic commercial aesthetic. No dramatic posing. No artificial transitions. No text overlays. No logos. No face changes. No identity changes.

The entire 30-second generation should feel like one continuous, coherent day captured by a real friend-not a collection of disconnected AI-generated scenes.`;

// The same travel vlog for H3, which holds a scene for ~15s — so 30 seconds is
// two chained clips. Written in REFERENCE format rather than the three-field
// one, because the Seedance original gets its subject from a photograph and
// text alone will not hold one face across two separate generations: the same
// pictures stay attached for both parts and anchor her in each.
//
// Chaining and references compose — an armed motion context and attached
// references are both accepted on the same request (videoTasks.videoRequestPlan)
// — so part 2 keeps the pictures AND pins part 1's tail. Part 2 therefore obeys
// the chain rules on top of the reference format: it re-describes the whole
// scene, opens on a hold with no dialogue, and starts its first real beat at 1s,
// because the opening ~0.9s is part 1's carried-over tail.
const TRAVEL_VLOG_H3_SUBJECT = `<Subject 1> is the young woman shown in <Picture 1>: [DESCRIBE HER FROM YOUR OWN PICTURE — face, skin, hair colour and style, build, and the clothes she wears for the day]. She is the only person the camera follows, and her face, hair, build and outfit stay exactly the same in every shot.
<Picture 1> is a photograph of her used as the identity source only. Its background, framing and pose are not reproduced; the clip opens on its own action somewhere else.`;

const TRAVEL_VLOG_H3_A = `subject_definitions:
${TRAVEL_VLOG_H3_SUBJECT}

summary:
A handheld personal travel vlog filmed by a friend walking with her: <Subject 1> leaves her apartment in the morning, walks through the city, stops for a coffee and drifts through a street market, in one continuous fifteen-second stretch. <Picture 1> drives who she is; every place and action is new.

retention_analysis:
<Subject 1>: fully_preserved — her face, hair, build and outfit stay exactly as the picture shows them, in every shot and at every distance.
<Picture 1>: attribute_transfer — used as the identity source only, with its own background, framing and pose left behind.

detailed_description:
Ultra-realistic handheld travel-vlog footage, shot by a friend on a phone or a small mirrorless camera: natural daylight, believable everyday exposure, casual framing that sits slightly off-centre, subtle camera shake and the small imperfections of a person operating a camera while walking. No cinematic grading, no dramatic posing, no artificial transitions. [Shot 1] Morning. <Subject 1> steps out of a cosy apartment doorway with a small backpack over one shoulder, glances down at her phone, looks up and smiles toward the camera, tucks her hair back and starts walking down the quiet residential street; the camera follows a step or two behind her, drifting and correcting as the operator walks, with low morning sun across the pavement and a few neighbours beginning their day in the background. [Shot 2] At 00:05.000, the camera follows her along a narrow city street and into a small café, where she orders and takes a paper cup with both hands, turns back toward the lens and laughs at something the person filming says. (S1) says: <d>[English] okay — coffee first, then I swear we're actually going.</d> The camera stays close and hand-held, dipping slightly as the operator laughs. [Shot 3] At 00:10.000, she moves through a street market, glancing over stalls of fruit and small goods, lifting her phone to take a casual photo of something off to the side, then turning to walk on with the cup still in her hand; the camera swings a little late to keep her in frame and the clip ends with her mid-stride, still walking.

overall_soundscape:
Ordinary morning street tone — distant traffic, birds, a scooter passing, the clatter and chatter of a café, an espresso machine, market voices and footsteps on pavement. Close handling noise from the camera and the operator's breathing as they walk. Her laugh, and the small ambient movement of a city getting going.

non_diegetic_music:
N/A`;

const TRAVEL_VLOG_H3_B = `subject_definitions:
${TRAVEL_VLOG_H3_SUBJECT}

summary:
The same handheld travel vlog continuing without a cut: <Subject 1> reaches the coast, sees the ocean, meets friends on the beach and ends the day sitting by the water at sunset, in one continuous fifteen-second stretch. <Picture 1> drives who she is; the day carries on from where the previous clip stopped.

retention_analysis:
<Subject 1>: fully_preserved — the same face, hair, build and outfit as the previous clip and as the picture, unchanged by the new location and light.
<Picture 1>: attribute_transfer — still the identity source only; its background, framing and pose are not reproduced.

detailed_description:
Ultra-realistic handheld travel-vlog footage continuing from the previous clip with no cut, filmed by the same friend on the same phone or small mirrorless camera: natural daylight, casual off-centre framing, subtle shake and the imperfections of walking while filming. No cinematic grading, no dramatic posing, no artificial transitions. [Shot 1] The held framing from the end of the previous clip: <Subject 1> mid-stride with her cup, the camera a step behind her, nothing yet changing — she breathes, shifts the backpack strap on her shoulder and a strand of hair moves across her face. Nobody speaks. [Shot 2] At 00:01.000, the street opens out and the city gives way to a quiet seaside town; she walks toward the water with the sea breeze pulling at her hair, and her face lifts into real surprise and delight the moment the ocean comes into view. (S1) says: <d>[English] oh my god — look at it.</d> She crouches on the sand, picks up a seashell, turns it over and watches the waves come in, the camera following loose and low behind her. [Shot 3] At 00:06.000, she reaches a group of friends on the beach; they talk over each other and laugh, someone kicks water at someone else, and the camera moves naturally between them rather than settling on anyone, catching half-finished gestures and people walking through frame. She glances back at the lens and smiles. [Shot 4] At 00:11.000, golden hour: she sits near the water holding a drink, watching the sun go down with the wind still moving her hair, and the camera drifts slowly backward to reveal the beach, the waves and the evening light before the clip ends on that wide, quiet frame.

overall_soundscape:
Coast tone taking over from the town — waves breaking and drawing back, wind across the microphone, gulls, distant voices along the beach and the crunch of sand underfoot. Her friends' overlapping talk and laughter, her own breathing and laugh, the camera handling close to the mic, and the wind settling into a calmer evening as the shot pulls back.

non_diegetic_music:
N/A`;

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
// Two fighters in one 8s take: one from YOUR reference pictures and voice clip,
// one a character H3 already knows. Compiled by lib/castPrompt.js — the same
// module the studio's Cast control runs — so the starter is literally what that
// button produces, rather than a hand-copy that drifts away from it.
//
// Every rule visible here was bought with a failed take (2026-08-12/13):
// the subject who owns <Audio 1> speaks FIRST so <Subject 1> is also S1
// (crossing those swapped the fighters' lines); each punch says its fist
// REBOUNDS (an un-retracted arm followed the opponent around); the reaction is
// on the frame of contact (a taunt in the gap read as a pause); the cartoon's
// face and voice are both described AND told what they must not be (it grinned
// through a punch, then spoke as an older man); and every character noise is
// in a beat rather than the soundscape, where nothing carries a speaker id.
const FIGHT_TWO_HANDED_H3 = `subject_definitions:
<Subject 1> is the character shown in <Picture 1>, <Picture 2>, <Picture 3>: [DESCRIBE THE PERSON IN YOUR REFERENCE PICTURES — hair, build, wardrobe, footwear].
<Subject 1> is rendered as photoreal live-action, real human skin texture and hair, shot on camera — not illustrated, not stylised.
<Subject 1> speaks as S1.
<Audio 1> is the voice-timbre reference for <Subject 1> (S1). It is not the voice of any other subject in this clip.
<Subject 2> is SpongeBob SquarePants from the animated series SpongeBob SquarePants (1999).
<Subject 2> is rendered as 3D CGI character animation with soft subsurface shading and cinematic lighting — semi-realistic and physically present in the scene, NOT flat 2D animation and NOT pixel art.
<Subject 2> speaks as S2, in SpongeBob SquarePants' voice from SpongeBob SquarePants as voiced by Tom Kenny.
<Subject 2>'s voice is high-pitched, nasal, squeaky and childlike, with a bright excitable delivery — never deep, gravelly or adult-sounding.

summary:
[audio reference] Live-action photoreal footage of a one-on-one fight between <Subject 1> and <Subject 2>, filmed side-on with a single locked camera, both fighters head to toe and filling the frame height throughout.

retention_analysis:
<Subject 1>: fully_preserved — the same face, hair, build and wardrobe in every shot and at every distance.
<Picture 1>: fully_preserved — <Subject 1>'s face, hair and wardrobe carry into the clip.
<Picture 2>: fully_preserved — <Subject 1>'s face, hair and wardrobe carry into the clip.
<Picture 3>: fully_preserved — <Subject 1>'s face, hair and wardrobe carry into the clip.
<Audio 1>: reference — only the timbre carries. Its words do NOT carry.

detailed_description:
The entire clip is one continuous live-action photoreal take with no cuts and no camera move: a single locked side-on camera at hip height, as if filming a fight from the sidelines. The location is a real neon-lit back street at night, wet asphalt underfoot, brick wall behind, signage glow reflecting in the puddles. The image is photographic throughout — real depth of field, real motion blur on fast limbs, real skin texture, real fabric movement. Both fighters stay in full view from head to toe for every frame; at no point does the framing crop above the knee.
[Shot 1] <Subject 1> stands on the left in profile in a boxing stance, weight forward on the balls of <Subject 1>'s feet, both fists raised. <Subject 2> stands facing <Subject 1> on the right in profile, guard up, knees bent. Both fighters are in full view from head to toe, their shoes flat on the wet asphalt, filling the frame from top to bottom with only a hand of headroom. Neither speaks.
At 00:00.800, <Subject 1> drives off the back foot and throws a fast straight right. The punch CONNECTS for a single frame only: <Subject 1>'s fist strikes <Subject 2>, and in the SAME instant it rebounds off <Subject 2> and snaps all the way back to guard. The fist does not stay on <Subject 2>, does not press into <Subject 2> and does not travel with <Subject 2> — the contact is one sharp blow and the hand is immediately gone. <Subject 2> is driven backwards by it, heels skidding on the wet ground. <Subject 2>'s recoil begins on the very frame of contact with NO pause of any kind: <Subject 2> is already reeling as the hand comes back, staggering with arms flailing wide for balance, face instantly contorted in pain — eyes screwed tightly shut, eyebrows pushed high and pinched together, mouth stretched wide open and pulled down at the corners. <Subject 2> is NOT smiling and NOT grinning at any point after the blow lands.
At 00:01.800, guard already back up at the chin and weight settling, <Subject 1> lifts <Subject 1>'s chin and looks straight at <Subject 2>, who is still staggering backwards. <Subject 1> (S1) says: <d>[English] [THE LINE THEY SAY AFTER LANDING THE FIRST HIT]</d>
At 00:02.700, <Subject 2> catches balance at the end of the stagger, doubled over with both hands on the knees and face still screwed up in pain, and cries out. Both of <Subject 2>'s legs stay in frame throughout. <Subject 2> (S2) says: <d>[English in SpongeBob SquarePants' voice from SpongeBob SquarePants as voiced by Tom Kenny] Ouch! That really hurt!</d>
At 00:04.200, <Subject 2> plants both feet, recovers balance and swings a wide spinning kick at head height. The kick MISSES: <Subject 1> drops into a deep crouch, bending fully at the knees with both feet flat, and <Subject 2>'s leg passes over <Subject 1>'s head through empty air. <Subject 2> is left off balance with their back half turned.
At 00:05.300, from the bottom of that crouch <Subject 1> drives upward, extending through both legs, and lands a second clean hit on <Subject 2>. It CONNECTS square and the fist rebounds instantly back to guard — again the contact is one blow and the hand does not linger. <Subject 2> is knocked backwards, both feet leaving the ground for an instant before landing hard on the heels and rocking on the spot, face still screwed up in pain.
At 00:06.300, <Subject 1> rises smoothly out of the crouch to a standing guard, feet set shoulder width apart and flat on the wet asphalt, fists back up at the chin, breathing hard. <Subject 2> sways unsteadily opposite, arms hanging, and keeps their mouth closed for the rest of the clip. <Subject 1> (S1) says: <d>[English] [THE LINE THEY SAY AFTER LANDING THE SECOND HIT]</d>

overall_soundscape:
Night street room tone with distant traffic and a faint electrical hum from the signage. Two blunt impact thuds where the punches connect, a low whoosh where the kick misses, shoes scuffing and skidding on wet asphalt, fabric rustle on fast limbs. No crowd, no announcer, and no speech from anyone other than the lines written above.

non_diegetic_music:
none`;

// An arcade match where BOTH fighters and the arena come from your own
// pictures. Liam's brief (2026-08-15), rewritten into reference mode's six
// sections: it arrived in the three-field format with "@image 1 as the first
// fighter's identity" notes bolted on in front, and a picture-driven brief that
// never writes <Picture N> conditions on nothing — the labels ARE how the
// attachments reach the graph.
//
// Three things the brief left implicit that the format does not let you leave
// implicit. The arena is a <Subject> exactly like the fighters are, because a
// place is reusable content and only a retention marker holds its architecture
// and palette through a shot change. The announcer is a subject with a speaker
// id, because a voice written with no id is unbound and comes back as a generic
// male read that has nothing to do with the one described. And the HUD is
// stated to be an overlay composited on top of the picture, or health bars get
// built into the set as signage.
//
// The rebound clause is carried over from the fight starter above, where it was
// bought with a failed take: a fist that never retracts follows its target
// around the frame.
const VERSUS_FIGHT_H3 = `subject_definitions:
<Subject 1> is the fighter shown in <Picture 1>: [DESCRIBE FIGHTER 1 FROM YOUR OWN PICTURE — face, skin, hair, build, wardrobe, footwear]. <Subject 1> fights from the left of frame and never speaks.
<Subject 2> is the fighter shown in <Picture 2>: [DESCRIBE FIGHTER 2 FROM YOUR OWN PICTURE — face, skin, hair, build, wardrobe, footwear]. <Subject 2> fights from the right of frame and never speaks.
Both fighters are rendered as photoreal live-action, real human skin texture and hair, shot on camera — not illustrated, not stylised, not a game engine render.
<Subject 3> is the fighting arena shown in <Picture 3>: [DESCRIBE THE ARENA FROM YOUR OWN PICTURE — architecture and materials, what stands at its edges, the light sources and their direction, the colour palette, the air and weather in it]. It is the only location the fight happens in.
<Subject 4> is an off-screen arcade announcer, never seen and heard only: a deep, resonant, energetic male voice with the clipped attack of a fighting-game callout. <Subject 4> speaks as S1 and is the only voice in the clip.

summary:
A cinematic live-action arcade fighting-game match in one continuous fifteen-second stretch: a versus card introduces <Subject 1> and <Subject 2>, the picture wipes through into <Subject 3>, a health-bar HUD drops in, the announcer counts the match in, and the two fight a real exchange in the arena. <Picture 1> and <Picture 2> drive who the fighters are and <Picture 3> drives where they fight; every pose, angle and action is new.

retention_analysis:
<Subject 1>: fully_preserved — the same face, hair, build and wardrobe in every shot and at every distance, unchanged by the versus card, the arena light or the motion blur.
<Subject 2>: fully_preserved — the same face, hair, build and wardrobe in every shot and at every distance.
<Subject 3>: fully_preserved — the arena's architecture, materials, edges, light sources, colour palette and atmosphere stay as the picture shows them for every frame after the wipe.
<Picture 1>: fully_preserved — <Subject 1>'s face, hair and wardrobe carry into the clip; its own background, framing and pose do not.
<Picture 2>: fully_preserved — <Subject 2>'s face, hair and wardrobe carry into the clip; its own background, framing and pose do not.
<Picture 3>: fully_preserved — the environment carries into the clip as the place the fight happens, and the camera is free to shoot it from angles the picture never shows.

detailed_description:
Cinematic live-action photoreal footage throughout, shot on camera with real depth of field, real motion blur on fast limbs, real skin texture and real fabric movement. The fighting-game graphics — the versus card, the word plates and the health-bar HUD — are clean overlays composited ON TOP of the photographic image, never signage or structures built into the set.
[Shot 1] A symmetrical versus card: <Subject 1> stands in the left half of the frame turned toward the centre and <Subject 2> stands in the right half turned toward the centre, both head to toe against a dark graphic backdrop with hard rim light down their near edges. Each holds a controlled aggressive stance, chest rising and falling, eyes locked across the gap on the other. The camera pushes in slowly and steadily along the centre line. A large glowing "VS" sits exactly between them and flares in sharp bursts that throw light across both fighters.
[Shot 2] At 00:03.000, a fast directional wipe crosses the frame on a white impact flash and the versus card is gone: a wide establishing shot of <Subject 3>, the whole arena readable from edge to edge with its own depth, haze and light. <Subject 1> stands on the left of the arena and <Subject 2> on the right, a clear fighting distance apart, both settling into convincing ready stances on the arena floor.
[Shot 3] At 00:05.000, the HUD drops in along the top of the frame: a horizontal health bar above <Subject 1> on the left and a matching one above <Subject 2> on the right, both full. The fighters hold their marks while the camera tracks laterally between them at a steady walking pace, holding the symmetry. A large centred "READY" plate lands between them. <Subject 4> (S1) says: <d>[English] Ready!</d> Both fighters tense and shift their weight forward onto the front foot.
[Shot 4] At 00:07.000, the "READY" plate snaps into a larger "FIGHT" plate on one hard graphic hit, the camera shakes briefly and both fighters break from their marks and charge for the centre. <Subject 4> (S1) says: <d>[English] Fight!</d>
[Shot 5] At 00:07.700, a low-angle tracking shot runs with them as the distance closes. <Subject 1> throws the first attack at <Subject 2>'s head and chest. <Subject 2> blocks it clean on a raised forearm and the force visibly travels through the blocking arm and shoulder, driving <Subject 2> back half a step.
[Shot 6] At 00:09.000, a fast three-quarter close shot. <Subject 2> turns the blocked arm over and counters immediately; <Subject 1> leans and steps off the line so the strike passes through empty air, then pivots straight back to face <Subject 2>. The camera arcs a long way around the pair, fast, keeping both faces and both full bodies readable.
[Shot 7] At 00:10.500, the exchange accelerates into a compact combination: <Subject 1> attacks in a rapid run of punches and kicks while <Subject 2> blocks, parries and gives ground across the arena floor. Every strike that connects rebounds instantly back to guard rather than resting on the other fighter, and every one changes the spacing between them. The camera cuts precisely on the impacts, alternating wide, medium and close.
[Shot 8] At 00:12.500, <Subject 2> takes the momentum and lands a heavy counter that drives <Subject 1> back several steps, the fist snapping back to guard on the frame of contact. The camera tracks <Subject 1> back fast, then swings around to hold both fighters in profile. <Subject 1>'s health bar drops by a short visible amount.
[Shot 9] At 00:14.000, both fighters re-engage at once and rush the centre. The camera pushes hard toward the collision point as their attacks meet in the middle of the frame; a fraction of a second of slow motion holds the contact, then normal speed resumes. The clip ends with both still standing in <Subject 3>, facing each other in stance, shoulders heaving, the HUD still on screen.

overall_soundscape:
The arena tone of <Subject 3> under everything — the ambience the place implies and the hum of its own light sources. Sharp electronic impacts and a rising synthetic sweep across the versus card and the wipe, and a hard graphic hit as each HUD element lands. Footsteps and skidding on the arena floor, fabric snapping on fast limbs, the dull slap of a blocked strike and the deeper crack of one that lands, a low whoosh where an attack misses, and a short concussive thump under the camera shake.

non_diegetic_music:
A high-energy cinematic fighting-game score: deep percussion and tense electronic pulses under the versus card, building fast through the count-in, then breaking into driving drums, aggressive bass, electronic percussion and dramatic orchestral accents on the call to fight. It holds a fast tempo across the combat and intensifies into the final exchange.`;

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
    id: 'travel-vlog-seedance-25',
    idea: 'travel-vlog',
    section: 'video',
    family: 'seedance-2.5',
    format: 'prose',
    name: 'Friend-filmed travel vlog',
    summary: 'Apartment to sunset in one 30s take, five beats',
    requires: 'a photo of the subject',
    note: 'One 30s generation (~$10.20 at 720p, ~$5.10 on the 480p tier). She comes from a picture, so pick a tier that takes one: attach a start frame and the studio switches to Seedance 2.5 I2V, where the photo becomes frame zero — or choose Seedance 2.5 Omni Reference and attach several photos of her, which steers identity without deciding the opening shot.',
    parts: [Object.freeze({
      label: 'Whole clip',
      durationSeconds: 30,
      prompt: TRAVEL_VLOG_SEEDANCE_25,
    })],
  }),
  Object.freeze({
    id: 'travel-vlog-h3',
    idea: 'travel-vlog',
    section: 'video',
    family: 'minimax',
    format: 'h3-reference',
    name: 'Friend-filmed travel vlog',
    summary: 'Same day as two chained H3 clips, identity from a photo',
    requires: 'a photo of the subject, attached as a reference picture',
    note: 'H3 holds a scene for ~15s, so the day is two chained clips. Attach her photo in References (reference picture) and leave it attached for both parts — text alone will not hold one face across two generations. Fill in [DESCRIBE HER…] from your own picture.',
    parts: [
      Object.freeze({
        label: 'Morning to market',
        durationSeconds: 15,
        prompt: TRAVEL_VLOG_H3_A,
        note: 'Set duration to 15s, attach her reference picture, and generate.',
      }),
      Object.freeze({
        label: 'Coast to sunset',
        durationSeconds: 15,
        continuation: true,
        prompt: TRAVEL_VLOG_H3_B,
        note: 'Press Continue scene on the part 1 result, keep her reference picture attached, then paste this over the armed prompt.',
      }),
    ],
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
    requires: 'one reference video with its sound on',
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
    requires: 'one reference video with its sound on',
    note: 'Same reference setup as the TV version — reference video with “sound” on — but framed 9:16 for a vertical feed, with the clip letterboxed on an upright phone. Set the aspect ratio to 9:16. Replace every [BRACKET] with your own clip before generating.',
    parts: [Object.freeze({
      label: 'Whole clip',
      durationSeconds: 10,
      prompt: SCREEN_REACTION_PHONE,
    })],
  }),
  Object.freeze({
    id: 'fight-cast-h3',
    idea: 'fight-cast',
    section: 'video',
    family: 'minimax',
    format: 'h3-reference',
    name: 'Fight a cartoon character',
    summary: 'Your character vs SpongeBob, one locked 8s take, seven timed beats',
    requires: 'three or more reference pictures of your character, plus a voice clip of them',
    note: 'Reference mode: attach your pictures and ONE voice clip in References — that gives the prompt <Picture 1-3> and <Audio 1>. Set duration to 8s. Fill in the appearance bracket from your own pictures and write the two lines. The beats are timed to 8.0s exactly, so if you add or cut action, adjust the At MM:SS.mmm stamps to match — overrunning the clip makes the model compress, and compressing reorders. Swap SpongeBob for any name from the Character menu, and use the Cast control to rebuild the whole thing for a different cast.',
    parts: [Object.freeze({
      label: 'Whole clip',
      durationSeconds: 8,
      prompt: FIGHT_TWO_HANDED_H3,
    })],
  }),
  Object.freeze({
    id: 'versus-fight-h3',
    idea: 'versus-fight',
    section: 'video',
    family: 'minimax',
    format: 'h3-reference',
    name: 'Arcade versus match',
    summary: 'Versus card into a real fight, both fighters and the arena from photos',
    requires: 'a photo of each fighter and a photo of the arena, attached as reference pictures',
    note: 'Reference mode: attach the three pictures IN THIS ORDER — fighter 1, fighter 2, arena — which is what makes them <Picture 1>, <Picture 2> and <Picture 3>. Set duration to 15s and the aspect ratio to 16:9, and fill in the three [DESCRIBE …] brackets from your own pictures; the model is looking at what you attached. The beats are timed to 15.0s exactly, so if you add or cut action, adjust the At MM:SS.mmm stamps to match — overrunning the clip makes the model compress, and compressing reorders.',
    parts: [Object.freeze({
      label: 'Whole clip',
      durationSeconds: 15,
      prompt: VERSUS_FIGHT_H3,
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
