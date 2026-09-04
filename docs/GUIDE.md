# Hivemind Content Studio — the guide

Hivemind Content Studio makes pictures, video and finished social clips on your
own Mac, and reaches out to a rented or hosted machine only when you ask it to.
It is one app: the same prompt box, the same library and the same "where does
this run and what does it cost" answer, whichever kind of thing you are making.

This guide is for the person using the app. It never asks you to open a
terminal. If you are running the studio from a checkout instead of the packaged
app, [OPERATIONS.md](OPERATIONS.md) is the operator's half.

---

## 1. The first run

However you started the studio — by opening the app, or by having someone start
it for you — the first thing you see is the same setup card, and everything from
here is the same.

### Name your studio and set a passphrase

The first screen you see is **Name your studio and set a passphrase**. There is
no default password — you choose both, here, on this machine.

* **Studio name** is what the sign-in screen shows from now on.
* **Passphrase** does two jobs. It signs you in, and it is the key that encrypts
  your library. The card says it plainly: *"keep it somewhere safe — nobody can
  reset it for you."* That is not a policy, it is arithmetic. No copy of it
  exists anywhere, so there is nothing for anyone to reset from.

Press **Open the studio**.

### Add a passkey (offered right away)

You are signed in, and the card offers: *"Signed in. Add a passkey so next time
this workspace opens with Touch ID or Face ID instead of a password."* Press
**Add a passkey** and approve it, or press **Not now** — the password keeps
working either way, and you can add one later.

Password sign-in can never be removed, because it is the only thing that can
unwrap the vault on a new device. Passkeys are per device and additive.

### Step 2 of 2 — save your recovery key

The studio then loads and immediately creates your encrypted vault, showing its
recovery key once, in a window titled **Step 2 of 2 — save your recovery key**.
It cannot show it again.

> *"This is your recovery key. If you forget your passphrase, it is the only
> thing that opens your encrypted media and drafts."*

**Copy key** puts it on the clipboard; **Save as .txt** writes it to a file. Put
it in a password manager, or print it. Then tick *"I stored this key somewhere
safe"* and press **Continue to the studio**.

If you lose the passphrase *and* the key, the sealed media stays sealed. Nobody
— not the app, not whoever owns the Mac — can open it for you.

### Every launch after that

A studio with one workspace and a passkey goes straight to the Touch ID prompt,
with **Choose a different workspace** still on the card. Without a passkey it is
**Sign in** and your password. If you ever need it, **Forgot your password?** is
there too — see [Troubleshooting](TROUBLESHOOTING.md#i-forgot-the-passphrase).

### What runs on this Mac, and what costs money

Every studio has the same chip in its prompt bar: **Runs on**. It reads out
where the next press will land, like *"This Mac · Z-Image Turbo — free, stays
here"*. Open it and you get one list in three groups, because there are exactly
three bills:

| Group | What it means |
|---|---|
| **This Mac** | Free, private, and as fast as the hardware — nothing leaves the machine. |
| **HivemindOS credits** | One balance of HivemindOS credits — the same one the HivemindOS app spends. |
| **Your accounts** | Billed by the provider to an account you already pay for. No HivemindOS credits spent. |

At the top of the list is **Automatic**, which is where you start. Automatic
prefers free and local, and the readout carries the reason with it — the *"free,
stays here"* half of the line is why, not decoration. Picking a row by hand
overrides Automatic for this tab only; **Automatic** stays in the list so you
can go back to it.

Each row in the list carries its own fit label — **Good fit**, **Workable**,
**Untried here**, **Poor fit**, **Cannot run this** — and a row that cannot run
says why on hover instead of failing after the press.

A rented GPU is not a fourth group. When you have one attached, it shows up as
the place name on the readout, with its hourly price — *"RTX 5090 · $0.42/hr"*.

### Connecting ComfyUI (optional)

The local model lanes run on ComfyUI. You do not need it: cloud and rented
models work without it. If you want the free local lanes, open **Rented GPUs**
in the Advanced group and find the **Connect ComfyUI** card. It will list
anything already answering on this machine with a **Use this one** button, let
you paste the address ComfyUI shows in its own window, and — when there is
nothing — link to **How to install it**.

The card is read-only about your install: *"This studio only reads — it never
changes a ComfyUI you installed yourself."*

---

## 2. Your first picture

Open **Image** (it is the first thing under **Create**, and ⌘1 goes there).

1. **Type what you want** in the big box. One line is enough to start.
2. Optional — press **Improve** and choose *Refine with the prompt helper*. It
   rewrites what is in the box rather than replacing your idea. Its entries are
   greyed out until you have typed something, and hovering one says why:
   *"Type an idea below first — the helper refines what is in the box."*
   *Add style tags* in the same menu is the other route.
3. Optional — press **Starters** for quick starters, the UGC block, and any
   prompt you have saved before.
4. Check the **Runs on** chip. Leave it on Automatic unless you have a reason.
5. Press **Generate** (or ⌘↵).

While it runs, the button shows *Generating…* and a **Cancel** button appears
beside it. If you have generated at these settings before, an estimate like
*~40 s* or *~3 min* sits to the left of the button, titled *"Estimated from your
own past runs at these settings"* — measured, not promised.

The result opens in a viewer. Along the bottom:

* **Download** — saves the file.
* **Regenerate** — same settings, new roll.
* **Upscale** and **Upscale (max quality)** — bigger, with more or less patience.
* **Compare** — appears when the picture has an original to sit beside (an
  upscale, an expansion, a masked edit).
* **Expand**, **Edit area**, **Angles**, **Steps** — appear when the model you
  used can do them.
* **Use as video starting frame** — the door to section 3.
* **Back to setup** — returns to the composer with everything still set.

### The settings panel

Everything else lives in the panel beside the canvas: **Aspect ratio**,
**Resolution**, **How many** (*"Pictures per press — each one costs the same
time again"*), and, under **Advanced options**, **Steps**, **Guidance scale**,
**Seed**, **Sampler**, **Scheduler** and the negative prompt. Each field carries
its own one-line hint — **Seed**, for instance, says *"The same seed and the
same settings make the same picture again — leave it at -1 for a new one every
press."*

**Attach** is how you give the model pictures to work from. It holds the
picker, the thumbnails, a way to say which reference is which, and **Clear**. If
the model you have chosen does not read references, the Attach popover says so
rather than silently ignoring them: *"This model does not read reference pictures —
they stay attached but are not sent."*

**Camera** writes one camera sentence into your prompt (this is where the old
Cinema studio went). It replaces its own sentence rather than stacking, so
arming it twice does not compound.

**Start fresh** clears the prompt for the next idea.

---

## 3. Your first video

The shortest path is to start from the picture you just made.

1. In the image viewer, press **Use as video starting frame**. The app seals the
   picture as a reference and drops you in the Video studio with it already set.
2. In **Video**, the mode is **Generate** (the other two are **Extend** and
   **Head swap**).
3. Write what should move. Press **Refine** if you want the helper to rewrite it
   knowing the model's own prompting guide, the cast, the lane and the clip
   length.
4. Set **Duration**, **Aspect ratio** and **Resolution** in the panel. Some
   models add **Quality** (*Draft* / *High* / *Best quality*) or **Refinement**.
5. Check **Runs on**, then press **Generate**.

You can leave the tab. The run keeps going, and coming back to the studio picks
it up.

Other things in the video composer, in the order you are likely to want them:

* **Source video** / **Continue from clip** — one chip whose label tells you
  which it currently means. When a clip seeds the next shot's opening frames it
  says *Continue from clip*; when a clip is an input to the run it says *Source
  video*.
* **References** — pictures, clips and voices the model should hold onto.
  Sub-kinds include a person, **A place**, **Staging** and **Motion**.
* **Camera** — camera-motion presets, composed into the prompt.
* **Prompts** — save the current prompt with every setting, or load one back.
* On MiniMax H3 only: **UGC** (a ready-made cast and beat plan), **Style**
  (restyle presets), **Shots** (lay out several shots inside one generation —
  cuts, camera, timed beats and dialogue) and **Check** (reads the prompt back
  and offers the one fix it can make). All four write H3's own prompt grammar,
  which is why they appear on nothing else.

### Stitching several shots

The Video studio has a timeline. Each generation becomes a segment card you can
reorder, replace or delete, with an **Auto-continue** option that seeds the next
segment from the last one. The strip's **Shot** / **Full cut** switch flips
between the segment you are working on and the whole thing joined end to end.
The full cut is built in the browser — the clips never leave the machine to be
joined.

---

## 4. The studios

Everything under **Create** in the sidebar.

### Image

Stills. Covered above. Also holds the local LoRA controls, mask editing, canvas
expansion, angle variations and edit sequences, when the model supports them.

### Video

Clips, from text or from a picture. Covered above.

### Story

A character-led short, produced one decision at a time, in four stages shown on
a rail down the side:

1. **The story** — a producer (a local model, HivemindOS, or your own accounts)
   drafts options; you lock one. What survives is a contract every later stage
   quotes.
2. **Cast & place** — character sheets and the plate, drawn here and promoted
   straight to references, so they turn up in the Video studio's reference
   picker with no exporting.
3. **What happens** — the beats, and what moves in each.
4. **Sign-off** — the checks in the order they are cheapest to fix, each with a
   repair naming one layer to change.

The stage rail lets you go back; nothing is thrown away when you do.

### Restore

Restoration and upscaling for footage you already have, with SeedVR2.

1. **Load a clip**.
2. Press **Test 2s** first. It renders one chunk from wherever the marker is —
   the cheap way to find out whether this model helps this footage.
3. Look at the result four ways: **Restored**, **Original**, **Compare** (drag a
   divider across the frame) and **Side by side**.
4. Then press **Restore** — the button says how many chunks that will be, and
   the price when the machine is a paid one.

Every finished chunk is a checkpoint, so closing the tab or losing the machine
costs you the chunk in flight and nothing else. When you come back, the button
reads **Resume from chunk N**.

The panel is explicit about which of three machines it is about to use:

* **This computer** — free. Chunks are kept losslessly here, so seams dissolve
  and the finish can be redone any time.
* **Rented GPU** — billed by the hour for as long as it is rented. Chunks come
  back sealed and are joined here in the browser, so its seams are hard cuts.
* **Hosted GPU** — billed per render in your HivemindOS credits, quoted before
  anything is sent. This is the one machine your footage leaves this computer to
  reach.

### Labs

Two working studios folded away because each needs something this Mac may not
have.

* **Sprite** — a sprite, animated, sampled for its distinct poses, cut out of its
  background, and packed into a sheet. Five separate resumable steps with their
  own output on screen, because each one can be wrong in a way you only see by
  looking at it.
* **Lip sync** — pairs a portrait or a source video with an audio track and
  produces a lipsynced clip.

---

## 5. Produce

### Planner

The agent-directed way in: say what you want in plain words and let the studio
plan it. Four modes across the top:

| Mode | It asks | It gives you |
|---|---|---|
| **Create** | *What do you want to make?* | The studio picks the model, makes it, and keeps it in your Library. |
| **Edit** | *What should change?* | Add the pictures to work from, say what should change, and every version lands in your Library. |
| **Animate** | *What should move?* | A clip, on the same video models the Video studio uses. |
| **Workflow** | *Build the complete workflow* | Scenes, voice, the edit and where it goes — planned before anything is spent. |

The **Templates** chip beside the box holds ready-made production prompts — the
UGC character-and-ad system, eight proven short-form ad formats, and the brand
explainer arc — with `[SLOT]` blanks for you to fill.

The plan comes back for you to read before anything runs; **Confirm & create
production** is what actually starts it.

### Library

Everything the studios and Canvas have made, encrypted with your key. Filter it
by **All**, **Prompts**, **Outputs** or **Favorites**, and search it. Thumbnails
decrypt as they scroll into view, which is why a locked tab shows locks instead
of pictures (see [Troubleshooting](TROUBLESHOOTING.md#the-vault-is-locked)).

Deleting is behind a confirmation, and a delete that fails leaves the dialog
open rather than pretending.

### Productions

The durable runs — the pieces the Planner created. Filter **All** / **Active** /
**Complete**, then read a run's scenes, its steps, its artifacts and its one
bounded next action. Resume, retry and cancel live here too; they are protected
actions, so the run detail asks for the operator token before it will send one.
Reading a run never does.

### Inspo

Browse what other people made on Civitai and take the prompt — with the steps,
guidance, seed and size that came with it — straight into the studio it belongs
in. Roughly half of any page has no usable prompt, so a thin page is Civitai
being thin, not a fault here.

### Models

Four tabs:

* **Models** — the local workflows the studios can generate with.
* **Engine** — the store: the inference engine and the models you can install.
* **Installed** — every weight file on disk, searchable.
* **Discover** — search Civitai and install from it.

This page is the only place models are installed or removed.

---

## 6. Advanced

Collapsed by default, because none of it is needed to make something.

* **Rented GPUs** — rent a prepared box by the hour from your own account, and
  attach or detach it. Also home to the **Connect ComfyUI** card.
* **Providers** — which capabilities are ready, and the **Connect** button for
  each account. Sign-in happens in a browser tab; the tokens stay server-side
  and never reach the page.
* **PassBook** — this machine's shared credential store. A key added here works
  in every app on the machine that speaks PassBook. It never shows a value.
* **Canvas** — the node workflow editor, for when you want to build the graph
  yourself.
* **Agents & API** — how to point an agent at the studio.
* **Settings** — grouped as General, Generation defaults, **Folders**, **Local
  engines**, Workspace, **Privacy & vault**, Network and Rented GPUs. Each row
  names where its current value came from, so a value pinned elsewhere on the
  machine is visible rather than mysterious. Turning a local engine off *"is a
  working studio with one fewer local lane, never an error."*
* **About** — version, licence, source and third-party notices.

---

## 7. Where your work goes

Nothing you make is uploaded anywhere by this app unless you press something
that says it will.

* **Your library, generated media, references and personas** are sealed with
  your key. Another workspace on the same Mac cannot open them.
* **Working files** — the brief, the script, the prompt lists — are encrypted
  with a key held by this Mac, so any program running as you can read them, and
  the studio's owner can see runs from every workspace.
* **Settings → Privacy & vault** spells out which is which, in the app.

Files land in a folder you can change on the **Settings** page, under
**Folders**. The **Download** button in any viewer writes a copy wherever you
like.

Two things that do leave the machine, and say so at the button: **Post to
Civitai** (which publishes unencrypted), and anything you have set **Runs on**
to a machine that is not this one.

---

## 8. Getting around

| Shortcut | What it does |
|---|---|
| ⌘K | The command palette — pages, tabs, saved prompts, installed models |
| ⌘, | Settings |
| ⌘1 – ⌘4 | Image, Video, Story, Restore |
| ⌘↵ | Generate, in any composer |
| ⌘T / ⌘W | New studio tab / close it |

The status chip at the top right is the studio's own health, in three words:
**Ready**, **Starting**, **Not running**. If it goes red, open it — the menu
carries the sentence and the fix together.

**Lock** signs the vault out of this browser without quitting the app. **Unlock
vault** appears next to it when a tab is signed in but has never received the
passphrase — a second browser tab, usually.

---

## 9. When something fails

Failures in this app arrive as a callout with three parts: one sentence you can
act on, a button that repairs it, and a **Details** disclosure holding the raw
technical text. The button is the point — a rejected key opens the key field,
not a settings page with no field on it.

Every failure sentence the app can show, with what to do about it, is in
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).
