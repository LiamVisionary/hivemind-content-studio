# Troubleshooting

Every entry below is keyed to a sentence the app actually shows. Failures arrive
as a callout with three parts — one sentence, one button that repairs it, and a
**Details** disclosure holding the raw technical text — so if you are reading a
traceback, you have opened Details. The sentence above it is the one this page
indexes.

If your problem is not here, open **Details** and copy that text into an issue;
it is the evidence, and it is deliberately never the headline.

---

## The vault is locked

**You see:** *"Your saved items are encrypted with your key and this tab's vault
is locked."* Or, on a thumbnail, a lock instead of a picture. Or the **Unlock
vault** button appearing in the top bar.

**Why:** you are signed in — the app knows who you are — but *this browser tab*
never received the passphrase. A second tab, or a tab that outlived a lock, is
the usual cause. The key lives only in an unlocked tab, by design; there is no
copy of it on disk that the studio can read.

**Fix:** press **Unlock vault** (in the callout, or in the top bar) and enter
your **Studio password**. The dialog says what happens next: *"Sealed media in
this tab opens as soon as you unlock — nothing you have open is lost."*

### I forgot the passphrase

Sign out, then on the sign-in card press **Forgot your password?**. That opens
**Use your recovery key** — the key you were shown once, at *Step 2 of 2*, when
the workspace was created. Paste it, choose a new password, press **Set the new
password**. Everything you have made stays exactly where it is; only the
password changes.

### I lost the passphrase and the recovery key

The sealed library stays sealed. There is nothing to recover from and nobody who
can do it for you — that is what "end-to-end" means here. Working files (briefs,
scripts, prompt lists) use this Mac's own key rather than your account's, so
those are unaffected.

### "Your saved library is there but could not be decrypted with this key"

The blob was sealed under an earlier vault. The list shows empty but the library
is not, so saving over it will ask first.

---

## A model will not fit

**You see, on a model row:** *"Needs … — turn on "Unload others first" to make
room."*, with the model's own size where the ellipsis is.

**Fix:** exactly that. **Unload others first** is the toggle above the model
list; it frees the other loaded models before it loads this one.

**You see instead:** *"Needs …, which is more than this machine can free right
now."*

**Fix:** the model is bigger than this Mac. Pick a smaller one, or change **Runs
on** to **HivemindOS credits** or **Your accounts**, where the machine is
somebody else's. The **Models** page's fit labels — **Good fit**, **Workable**,
**Untried here**, **Poor fit**, **Cannot run this** — say which is which before
you commit.

**You see:** *"Still loading — it will be ready in a moment."*

Not a memory problem. A large local model can take a few minutes to come up.

### A generation fails partway with a memory error

**You see:** *"Not enough memory for this size"*, with a **Lower resolution**
button when the studio you are in has a size dial.

**Fix:** press it, or drop the resolution and the batch count by hand. The same
picture at a smaller size is usually the difference.

In **Restore**, the same class of failure reads *"That machine ran out of memory
on this chunk."* with *"Lower the temporal batch or the output size in Advanced,
then resume — the finished chunks are kept."* Nothing already rendered is lost.

---

## A rented machine went away mid-render

**You see, in Restore:** *"The rented machine is no longer there."* with
*"Attach it again on the Rented GPUs page, or switch the machine and resume."*

**Fix:** open **Rented GPUs** in the Advanced group. If the rental is still
alive, **Reconnect** it; if it is gone, rent another or switch the run back to
this computer. Then press **Resume from chunk N** — every chunk that finished
before the machine vanished is still on disk and is not rendered again.

**You see instead:** *"That machine stopped answering."* with *"Check it is
still running, then resume — the finished chunks are kept."*

The machine still exists but is not responding. Same repair: check it on the
**Rented GPUs** page, then resume.

**Related sentences from the same page**, all with the same shape:

* *"That machine could not download the model weights."* — check the connection
  and resume, or pick a model this machine already has.
* *"That machine does not have this restore model."* — pick another model, or
  another machine, and resume.
* *"This project's source clip is no longer on this machine."* — load the
  original clip again and start it; the finished chunks are still reused.
* *"That project is no longer on this machine."* — working files are cleared
  once they age out. Any master it produced is still in your **Library**.
* *"Stopped. Every finished chunk is still here."* — you pressed **Stop**.
  Resume continues from the next one.

In the **Video** studio, a run promised to a rented box that is no longer
reachable blocks **Generate** with the tooltip *"Rent a machine (or switch the
source to Local) to generate."*

---

## A provider account has no credit

### HivemindOS credits

**You see:** *"This model is paid, and no HivemindOS account is connected to
this studio."* with a **Connect account** button.

**Fix:** press it. The studio spends the same HivemindOS balance the HivemindOS
app spends — it is not a second wallet. With the HivemindOS app running on this
machine the studio uses it directly; without it, connecting your own HivemindOS
account reaches the same balance.

**You see:** *"The free allowance for today is used up."* with **Add credits**.

**Fix:** **Add credits** opens a checkout in a new tab. Finish it, come back and
press **Try again** — the app says so in a toast rather than leaving you
guessing.

**You see:** *"These credits were not accepted."*, or any message mentioning
credits or a wallet, also with **Add credits**. Same repair.

**You see:** *"This studio is not authorised to reach HivemindOS on this
machine."* with **Open HivemindOS**.

**Fix:** the app on this machine is what holds the machine's account key. Start
it, then try again. If HivemindOS is not installed at all, use **Connect
account** instead and paste your own HivemindOS account key — "install
HivemindOS first" is not an answer for someone who does not have it.

The **Runs on** picker shows the balance before you press anything: the
HivemindOS group's header reads the balance with the word *left* after it, or —
when there is no balance to read — *"No credits added yet"* if the HivemindOS
app on this machine is answering, and *"Account not connected"* if it is not.

### Your own provider accounts

**You see:** *"MUAPI key missing — add one to continue"* or *"MUAPI key rejected
— check it and try again"*, with an **Add key** button.

**Fix:** press **Add key**. It opens the key field right where you are, not a
settings page. The dialog — **Connect your cloud account** — asks for a **MUAPI
access key**, and warns *"Do not enter the key name or label; paste the
generated key value from MUAPI."* The key is saved to this machine's shared
store, so every app here can use it and it never stays in the browser.

**You see:** *"MUAPI refused the request: …"* (a 4xx), or *"MUAPI request failed
(…) — try again in a moment"* with the 5xx status in the brackets, or *"MUAPI
could not be reached — check the connection and try again"*.

The first is the provider disagreeing with the request — the sentence after the
colon is theirs. The other two are transient; try again.

**You see:** a **Sign in** button on a failure. That account uses a browser
sign-in rather than a key. The tab opens; finish the sign-in there, come back
and press **Try again**.

**You see:** **Connect account** with no provider named. Nothing is connected
at all yet. Open **Providers** in the Advanced group and connect whichever one
you want to pay.

---

## The app cannot find ComfyUI

**You see, in a studio:** *"The local engine is not running"* with a **Check
again** button. Or, in a local section: *"ComfyUI is not connected."*

**Why:** the free local model lanes run on ComfyUI, which the studio attaches to
rather than installing or managing. Cloud and rented models keep working
without it.

**Fix:** open **Rented GPUs** in the Advanced group and find the **Connect
ComfyUI** card.

1. If something is already answering, it is listed under **Answering right
   now** — press **Use this one**.
2. Otherwise paste the address ComfyUI shows in its own window and press
   **Connect**.
3. If the card says *"No ComfyUI found on this machine"*, follow its **How to
   install it** link, then come back and connect it.

**You see:** *"That address did not answer"* after pressing Connect. Nothing is
serving ComfyUI at the address you gave. Check ComfyUI's own window for the
address it prints, and press **Try again**.

The card never modifies an install you made yourself: *"This studio only reads —
it never changes a ComfyUI you installed yourself."*

---

## The studio itself is not answering

**You see:** the status chip at the top right turns red and reads **Not
running**, or a studio says *"The studio is not answering"* / *"The studio is
not running"*, and **Generate** is disabled.

**Fix:** open the chip. Its menu carries the sentence and the way out together.
In the desktop app that is a **Restart studio** button, which stops the local
services the app started and brings them back; in a browser tab, which cannot
start anything, it says so and you start the studio the way you started it
before. Either way **Try again** is there for when it has already come back on
its own.

---

## A production says its record is missing

**You see:** a card in **Productions** with a red **Record missing** tag, and
opening it shows *"This production's record file is missing, so the studio
cannot read it."* Everything else in the list is normal.

**Fix:** press **Open storage settings** on the card. The workspace section
shows the folder this studio reads and writes; if that is not the folder the
production was made in, the record is in the other one. Moving or renaming the
studio folder no longer orphans a production — runs are recorded relative to
that folder — so this now means the file itself is gone.

One broken record only ever costs you that one card. The rest of the list, and
everything the studio knows about the broken run itself (its steps, its status,
its history), is still there.

---

## Smaller things

**A ten-second toast after loading a starter** — `Loaded "…"` followed by one
instruction. The starter needs that step before its prompt makes sense (arm the
chain, attach the reference clip, fill in the brackets). It stays up longer than
a normal toast because the hover text it came from disappears with the menu.

**"Not saved — download to keep"** on a result — a cloud result the studio could
not store locally. It exists on screen and on a link that expires. **Download**
it now.

**"Those settings could not be restored — the model may no longer be
installed."** — the saved prompt's settings point at a model that is gone.
Install it from **Models**, or load just the prompt text instead.

**"This model does not read reference pictures — they stay attached but are not
sent."** — not an error. Switch to a model that takes references if you need
them read.

**"Couldn't open your library."** with a **Retry** — a read that failed rather
than an empty library. Retry before saving anything, so a save does not replace
a library the app has not managed to read.

---

## Reporting something

Open **Details** on the callout and copy the raw text. If the app is running,
**About** in the Advanced group has the version and commit. Nothing in either
place contains a credential — provider errors are sanitised before they are
shown or logged.
