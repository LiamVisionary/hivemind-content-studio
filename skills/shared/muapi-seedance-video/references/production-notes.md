# Production Notes

These notes capture practical lessons from iterative MUAPI/Seedance short-form video work.

## Identity Consistency

- Prefer a character sheet or Soul-style identity reference over raw selfies in every prompt.
- Do not use user photos as starting frames unless the request is explicitly "animate this exact photo."
- If the generated person looks too old, regenerate the character sheet with explicit age, youthful descriptors, and the strongest 1-3 photos. Remove noisy photos.
- Keep wardrobe fixed in the character sheet prompt and in every shot prompt.
- Reuse the same character id or sheet URL across the entire video.

## Set And Prop Consistency

- Use a single set anchor image for repeated desk/background shots.
- Repeat physical set details in each prompt: material, color, height, position in frame, background tone, lighting.
- For a desk talking shot, specify the desk composition: "desk visible, real tabletop surface, occupies the lower third, subject fully seated behind it."
- Reject outputs where the desk becomes a gray slab, changes material, disappears, or blocks the subject.

## Lip-Synced Talking Shots

- Generate and approve TTS before the video shot.
- Prompt the exact line and include `audio_files`.
- Add "no extra words after the provided line" when the model invents speech.
- If the spoken text is wrong, regenerate audio/video rather than forcing an obvious audio splice.
- For lines shorter than 4 seconds, pad silence or keep the shot duration at 4 seconds and specify that the subject stays silent afterward.

## Humanoid Robot Partner

- If the user asks for a robot woman who is mostly human, avoid metallic full-robot bodies unless requested.
- Prompt for humanlike face, synthetic skin, subtle panel seams, soft android eyes, clean futuristic clothing, and a few visible robotic details.
- For affectionate framing, specify contact and body language: leaning on shoulder, arms around waist, cheek near shoulder, looking attached to the main character.
- Generate both people in the same shot when interaction matters. Do not split-screen or stitch two separate clips.

## Money, Bees, And Cash Inserts

- For robot/cyber bee money shots, describe small mechanical bees carrying strapped money bundles toward the subject or desk.
- For close-ups of cash, avoid printable counterfeiting outputs:
  - partial angled bundles
  - moving hands
  - no serial numbers
  - no flat isolated bill layout
  - no full front/back banknote reproduction
- If the insert is only hands at the desk, mention sleeve/watch/bracelet only as continuity details; do not require the face.

## Replacement Shot Discipline

- Never reuse the same generated clip for two different shot slots unless explicitly intended.
- Name replacement clips by shot purpose, not just version number.
- Generate standalone inserts for cutaways: face closeup, hands, cash, bees, reaction, robot partner.
- Keep the previous good full cut as a backup before replacing a shot.

## Prompt Template

```text
@image1 is the character identity reference. @image2 is the fixed set reference.
Vertical 9:16 cinematic social-video shot. Same 30-year-old subject, same outfit,
same [desk/set/lighting]. Camera: [framing]. Action: [specific motion].
If speaking: he/she says exactly the supplied audio and no extra words.
Continuity: [prop positions]. Avoid: [known failure from prior output].
```
