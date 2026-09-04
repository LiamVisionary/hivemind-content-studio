"""Every request body the control API accepts.

Moved out of control_api.py unchanged (2026-09-04): these are declarations, and
holding them in the same file as the routes was most of what made that file
6,227 lines. ``control_api`` re-exports the handful that tests, the MCP and the
route modules import by their old name.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field


class CancelBody(BaseModel):
    reason: str


class RetryBody(BaseModel):
    step_id: str


class DecisionBody(BaseModel):
    decided_by: str = "owner"


class FavoriteBody(BaseModel):
    favorite: bool


class PassBookBody(BaseModel):
    """Credentials the owner is adding to the machine's shared store.

    Deliberately not a general key-value write: only names the studio actually
    uses are accepted, so a bug or a hostile page cannot turn this into a way to
    plant arbitrary environment variables into every Hive app on the machine.
    """

    values: dict[str, str] = Field(default_factory=dict)
    overwrite: bool = False


class PassBookRevokeBody(BaseModel):
    """Which machine to stop lending to, named by its DID."""

    did: str = Field(min_length=1, max_length=200)


class AccountUnlockBody(BaseModel):
    account_id: int
    password: str


class AccountSetupBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1)


class AccountCreateBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)
    password: str = ""


class VaultPassphraseWrap(BaseModel):
    """The passphrase half of a vault identity, re-wrapped in the browser.

    Nothing here is a secret the server can spend: `salt` is public PBKDF2
    input and `wrapped_mk_pass` is the master key sealed under a key derived
    from a passphrase this process never sees.
    """

    salt: str = Field(min_length=1, max_length=8192)
    wrapped_mk_pass: str = Field(min_length=1, max_length=8192)
    kdf: str = Field(default="", max_length=128)


class AccountRecoveryChallengeBody(BaseModel):
    account_id: int


class AccountRecoveryResetBody(BaseModel):
    account_id: int
    challenge: str = Field(min_length=1, max_length=128)
    # The nonce this browser decrypted with the recovered vault private key.
    nonce: str = Field(min_length=1, max_length=128)
    password: str = Field(min_length=1)
    wrap: VaultPassphraseWrap


class AccountPasswordChangeBody(BaseModel):
    current_password: str = Field(min_length=1)
    password: str = Field(min_length=1)
    wrap: VaultPassphraseWrap


class AccountRenameBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class PasskeyChallengeBody(BaseModel):
    # Absent for a discoverable sign-in, where the passkey itself names the
    # workspace and the browser picks which one to offer.
    account_id: int | None = None


class PasskeyRegisterBody(BaseModel):
    credential_id: str = Field(max_length=1024)
    # SPKI DER from the browser's own PublicKeyCredential.getPublicKey(), which
    # is why this server needs no CBOR/COSE parser (see accounts.py).
    public_key: str = Field(max_length=4096)
    algorithm: int
    client_data_json: str = Field(max_length=8192)
    label: str = Field(default="", max_length=60)
    # Whether this credential can produce a PRF secret, i.e. whether it is able
    # to unlock the vault itself rather than only prove who is at the keyboard.
    prf: bool = False


class VaultPrfWrapBody(BaseModel):
    # None removes the enrolment (the passkey still signs you in, it just no
    # longer carries a copy of the wrapped master key).
    wrapped_mk: str | None = Field(default=None, max_length=4096)


class PasskeyAssertionBody(BaseModel):
    credential_id: str = Field(max_length=1024)
    client_data_json: str = Field(max_length=8192)
    authenticator_data: str = Field(max_length=8192)
    signature: str = Field(max_length=4096)


class PassBookUnlockBody(BaseModel):
    """Hold access open for a stated period."""

    duration: str = Field(default="1h", max_length=16)
    keys: list[str] = Field(default_factory=list, max_length=64)
    app: str = Field(default="", max_length=128)
    reason: str = Field(default="", max_length=200)


class PassBookResolveBody(BaseModel):
    """Answer a request that is waiting on a person.

    The passkey fields are optional here and required by policy in the route: a
    machine that has enrolled a passkey should not be able to approve a
    credential release with a bare click, because then the passkey is decoration.
    """

    id: str = Field(min_length=1, max_length=64)
    approve: bool = True
    remember: str = Field(default="", max_length=16)
    credential_id: str = Field(default="", max_length=1024)
    client_data_json: str = Field(default="", max_length=8192)
    authenticator_data: str = Field(default="", max_length=8192)
    signature: str = Field(default="", max_length=4096)


class PassBookModeBody(BaseModel):
    """How one key, or one app, is answered."""

    app: str = Field(default="", max_length=128)
    key: str = Field(default="", max_length=128)
    mode: str = Field(max_length=16)
    window: dict[str, Any] | None = None


class ConfirmDeleteBody(BaseModel):
    confirm: bool = False


class RemoteAccessBody(BaseModel):
    enabled: bool = False


class CanvasProvenanceBody(BaseModel):
    models: list[str] = []
    seeds: list[dict[str, Any]] = []


class SettingsBody(BaseModel):
    # An allow-list on the way in as well as on the way out: settings.py refuses
    # a key it does not know, so a typo is a sentence rather than a stray row in
    # the document.
    values: dict[str, Any] = {}
    reset: list[str] = []


class VaultIdentityBody(BaseModel):
    identity: dict[str, Any]
    allow_replace: bool = False


class VaultRecoveryWrapBody(BaseModel):
    """A freshly minted recovery key's copy of the master key.

    Replaces only `wrapped_mk_recovery`, which is what makes "show me a new
    recovery key" different from rotating the vault: the master key is
    unchanged, so nothing already sealed has to be re-encrypted.
    """

    wrapped_mk_recovery: str = Field(min_length=1, max_length=8192)


class VaultBlobBody(BaseModel):
    ciphertext: str


class PromptHelperLoadBody(BaseModel):
    modelId: str
    unloadOthers: bool = True


class PromptHelperUnloadBody(BaseModel):
    modelId: str


class LaneFreeBody(BaseModel):
    lane: str


class ComfyAttachBody(BaseModel):
    """Point a lane at a ComfyUI the user is already running."""

    url: str
    lane: str = "default"


class ComfyDetachBody(BaseModel):
    lane: str = "default"


class StudioImageBody(BaseModel):
    """One still, from the provider the studio's picker actually selected.

    ``provider`` is the media catalog's provider id and is REQUIRED: a model id
    alone is ambiguous (gpt-image-2 exists under an OpenAI API key, an OpenAI
    OAuth grant and MUAPI, on three different accounts), and guessing which one
    is a charge on someone else's bill.
    """

    provider: str
    model: str = ""
    prompt: str
    aspect_ratio: str = "1:1"
    quality: str = ""
    seed: int | None = None


class CloudOutputAdoptBody(BaseModel):
    """A finished cloud result the studio wants kept like a local render.

    The URL is the provider's own, and it expires: MUAPI hands back a CDN link
    that is gone within the day, which is why every Cinema, Lip Sync and cloud
    Image result used to exist only until the tab closed.
    """

    url: str = Field(..., max_length=4096)
    kind: Literal["image", "video", "audio"] = "image"
    model: str = Field(default="", max_length=200)
    provider: str = Field(default="", max_length=100)


class HivemindosLinkCallbackBody(BaseModel):
    """What the HivemindOS app posts back: the link it is answering, and the key."""

    nonce: str = Field(default="", max_length=256)
    token: str = Field(default="", max_length=512)


class HivemindosConnectBody(BaseModel):
    """The owner's HivemindOS account key, or an empty string to disconnect."""

    token: str = Field(default="", max_length=512)


class HivemindosMergeBody(BaseModel):
    """Two or more account keys whose balances should become one."""

    tokens: list[str] = Field(default_factory=list, max_length=8)


class HivemindosTopUpBody(BaseModel):
    """How much to put on the studio's own HivemindOS credit balance.

    Bounded here rather than only at the gateway: an owner cannot mistype a
    zero into a checkout this studio opened.
    """

    amountUsd: float = Field(default=5.0, ge=5.0, le=100.0)


class StoryProducerBody(BaseModel):
    """One question the Story studio asks its producer.

    ``task`` is one of story_producer.TASKS. ``brief`` is what the director
    just typed; ``context`` is everything already locked (the contract, the
    characters, the location, the board), sent so the answer preserves it
    instead of quietly inventing a second version of the same character.
    """

    modelId: str
    task: str
    brief: str = ""
    context: dict | None = None


class PromptHelperGenerateBody(BaseModel):
    modelId: str
    idea: str
    targetModel: str = ""
    mediaType: Literal["video", "image"] = "video"
    # A start image is a different documented task for MiniMax H3 (I2VA vs
    # T2VA), which opens with an anchor line the model was trained on.
    hasFirstFrame: bool = False
    # A last frame turns the same request into FL2VA (with a start frame) or
    # L2VA (without) — each has its own anchor line.
    hasLastFrame: bool = False
    # A scene chain is armed: this prompt is the next shot of a running scene,
    # not a new one. Without it the helper answers a line of new dialogue by
    # inventing a fresh scene, which makes the chained render cut away.
    isContinuation: bool = False
    # How the shot being continued was written. The clause above says to keep
    # the established scene; this is what says WHAT it is. Local-only, like
    # every other prompt here — it goes to a llama-server on this machine.
    previousPrompt: str | None = None
    # What reference mode will condition on: how many pictures, which motion
    # clips carry their own soundtrack, how many voice clips. The profile
    # explains the label SCHEME; this says how many of each label exist, so the
    # helper writes the ones the graph will actually carry.
    references: dict | None = None
    # UGC mode is armed in the composer. It layers onto whichever profile the
    # target model selects rather than replacing it — the format stays, the
    # judgements inside it invert (speech becomes required, polish becomes the
    # failure mode).
    ugc: bool = False
    # The loaded Hive Persona's gender — "female" / "male" / "nonbinary" — so
    # the helper writes "the woman"/"her" or "the man"/"his" instead of
    # guessing. Only the gender: the persona's name is sealed to the owner's
    # vault and never reaches this host.
    personaGender: str | None = None
    # Who is in the shot, one entry per <Subject N>, as the studio's cast
    # compiler sees it: {"subject": 1, "kind": "persona" | "character",
    # "gender": "", "name": "", "voice": bool, "look": ""}. A persona's name
    # is vault-sealed and is discarded unread; a character's is public. When
    # present this supersedes personaGender, which only knew about one person.
    # Validated defensively in prompt_profiles.normalize_cast (it lands inside
    # an instruction), so the field is a plain list here.
    cast: list | None = None
    # The clip length the studio is set to, so the written timeline fits inside it.
    durationSeconds: float | None = None
    # The start frame itself, as a data URL, for models with a projector: an
    # I2VA prompt describes the first frame, and describing one it has never
    # seen is guesswork.
    imageBase64: str | None = None
    # Verified character facts (name / casting / work / year) the client's H3
    # character catalog matched in the idea, one line per character.
    characterNotes: list[str] | None = None
    # Revise an existing prompt instead of writing a new one: the prompt to
    # change, and what the owner wants different about it.
    currentPrompt: str | None = None
    revision: str | None = None
    # Refine currentPrompt into the model's perfect shape: {"detail":
    # "keep"|"enrich", "shots": "keep"|"more"|"single", "guidance": "..."}.
    # Validated in prompt_profiles.normalize_refine (advisory knobs, never a
    # 422); requires currentPrompt like revision does.
    refine: dict | None = None


class PromptHelperDescribeLookBody(BaseModel):
    """Ask the loaded helper to write a Hive Persona's LOOK from its pictures."""

    # One to three reference pictures of the SAME person, as data URLs. Like a
    # start frame, they go only to the llama-server this process spawned on
    # 127.0.0.1 and are never written anywhere. Counted and checked in the
    # route (not a validator) so a refusal does not echo the pictures back.
    images: list[str]
    # The persona's saved gender — "female" / "male" / "nonbinary" — so the
    # description says "a woman with …" instead of reading one off the
    # pictures; '' / absent writes "a person with …".
    gender: str | None = None
    # Which loaded helper to ask. Absent → whichever one is loaded, because the
    # persona editor does not own the picker the way the composer's helper does.
    modelId: str | None = None


class MediaStudioLoraBody(BaseModel):
    id: str
    strength: float = 1.0


# Generous ceilings, stated once. A prompt the MCP would refuse for length
# used to fail LATE with a gateway message; a 422 here names the field, and
# the validation handler below turns it into a sentence.
_MAX_PROMPT_CHARS = 20_000


_MAX_DESCRIPTION_CHARS = 1_000


_MAX_ID_CHARS = 64


class MediaStudioIngredientImageBody(BaseModel):
    image_base64: str | None = None
    image_reference: str | None = None
    # Bounded like a prompt; the runner's own 1,000-character cut is reported
    # in the response's warnings rather than applied in silence.
    description: str = Field(default="", max_length=_MAX_PROMPT_CHARS)


@dataclass(slots=True)
class _StagedVideoInputs:
    """Every media file a video request decoded onto disk. Named rather than a
    positional tuple: staging grew from one image to nine kinds of input, and
    each has to be handed to the runner AND deleted afterwards."""

    image: Path | None = None
    middle: Path | None = None
    end: Path | None = None
    video: Path | None = None
    motion_context: Path | None = None
    ingredient_images: list[dict[str, Any]] = field(default_factory=list)
    reference_images: list[Path] = field(default_factory=list)
    reference_audios: list[Path] = field(default_factory=list)
    reference_videos: list[dict[str, Any]] = field(default_factory=list)
    # Head replacement: the clip being rewritten, and the painted mask.
    inpaint_source: Path | None = None
    inpaint_mask: Path | None = None
    inpaint_mask_video: Path | None = None
    # Anything staging changed about the request on the owner's behalf (a
    # shortened note), so the response can say so instead of cutting silently.
    warnings: list[str] = field(default_factory=list)

    def paths(self) -> list[Path]:
        return [
            source
            for source in [
                self.image, self.middle, self.end, self.video, self.motion_context,
                self.inpaint_source, self.inpaint_mask, self.inpaint_mask_video,
                *(item["image_path"] for item in self.ingredient_images),
                *self.reference_images,
                *self.reference_audios,
                *(item["video_path"] for item in self.reference_videos),
            ]
            if source is not None
        ]


class MediaStudioReferenceAudioBody(BaseModel):
    audio_base64: str | None = None
    audio_reference: str | None = None


class MediaStudioReferenceVideoBody(BaseModel):
    video_base64: str | None = None
    video_reference: str | None = None
    # Condition on the clip's own soundtrack too. Off by default: a downloaded
    # motion reference usually carries audio nobody wants in the shot, and an
    # unwanted soundtrack silently spends one of the model's <Audio N> labels.
    use_audio: bool = False
    # How the clip is staged for the node. "full" keeps MiniMax H3's own
    # 768-short-edge reference canvas; "compact" fits it inside 384x1152, never
    # upscaled — about 3.3x fewer sequence rows and half the step time for the
    # same motion (same-seed A/B on a rented 5090, 2026-08-21). Measured for
    # MOTION references only, so it is a per-clip opt-in; the studio holds it
    # off while the clip is the character reference (no picture attached).
    canvas: Literal["full", "compact"] = "full"


class MediaStudioInpaintBody(BaseModel):
    """The head-replacement dials. Every one is optional and an unset dial keeps
    the workflow's own default — the studio does not restate them, so there is
    one place to change a default rather than two that can drift."""

    sam3_prompt: str = Field(default="", max_length=200)
    sam3_detection_threshold: float | None = Field(default=None, ge=0.05, le=0.95)
    sam3_max_objects: int | None = Field(default=None, ge=0, le=64)
    sam3_detect_interval: int | None = Field(default=None, ge=1, le=64)
    sam3_object_indices: str = Field(default="", max_length=100)
    mask_expand: int | None = Field(default=None, ge=-512, le=512)
    mask_feather: int | None = Field(default=None, ge=0, le=256)
    mask_despeckle: int | None = Field(default=None, ge=0, le=256)
    mask_temporal_expand: int | None = Field(default=None, ge=0, le=64)
    crop_mode: Literal["", "combined", "tracked", "zoomed"] = ""
    # 0 is "no crop, the whole frame". Between 0 and 1 would be a window smaller
    # than the subject; media_studio refuses it there, where the message can
    # explain what the number means.
    crop_scale: float | None = Field(default=None, ge=0, le=4)
    crop_megapixels: float | None = Field(default=None, ge=0.1, le=2)
    paste_expand: int | None = Field(default=None, ge=-512, le=512)
    paste_feather: int | None = Field(default=None, ge=0, le=256)
    paste_edge_feather: int | None = Field(default=None, ge=0, le=256)


class MediaStudioVideoBody(BaseModel):
    prompt: str = Field(default="", max_length=_MAX_PROMPT_CHARS)
    workflow_id: str = Field(default="", max_length=256)
    studio_lane: str = Field(default="", max_length=512)
    # The studio's per-tab "Run on" pin (a rental id such as "vast:48352597").
    run_on: str = Field(default="", max_length=128)
    reference_description: str = Field(default="", max_length=_MAX_PROMPT_CHARS)
    ingredient_images: list[MediaStudioIngredientImageBody] = []
    # MiniMax H3 Reference mode: discrete character/subject pictures carried into
    # the clip in order (reference N is the prompt's <Picture N>). Distinct from
    # ingredient_images, which LTX composes into one conditioning sheet.
    reference_images: list[MediaStudioIngredientImageBody] = []
    # Voice/timbre clips (<Audio N>) and motion references (<Video N>) for the
    # same H3 Reference mode. All three reference kinds are optional and mix
    # freely; only audio may never be the sole reference.
    reference_audios: list[MediaStudioReferenceAudioBody] = []
    reference_videos: list[MediaStudioReferenceVideoBody] = []
    image_base64: str | None = None
    image_reference: str | None = None
    middle_image_base64: str | None = None
    end_image_base64: str | None = None
    video_base64: str | None = None
    video_reference: str | None = None
    # Scene chaining (MiniMax H3): the PREVIOUS clip, decrypted in-browser and
    # sent inline; its last ~22 frames + audio tail seed the new shot.
    # Head replacement (MiniMax H3 inpainting): the clip being REWRITTEN, and
    # the painted region that says which pixels may change. Neither is a source
    # video (that means "extend this shot") nor a reference (that is
    # conditioning) — this clip's own pixels and soundtrack are the result.
    source_video_base64: str | None = None
    source_video_reference: str | None = None
    mask_image_base64: str | None = None
    # A tracked mask CLIP — one white-on-black frame per source frame. What
    # the hosted masking service returns, and how a lane with no SAM3
    # checkpoint still gets a tracked mask.
    mask_video_base64: str | None = None
    mask_source: Literal["", "manual", "sam3", "sequence"] = ""
    inpaint: "MediaStudioInpaintBody | None" = None
    motion_context_base64: str | None = None
    video_mode: Literal["extend"] = "extend"
    # THE task. Decided once in the studio (src/lib/videoTasks.js) and forwarded
    # verbatim; nothing downstream re-derives the job from which media arrived.
    task: Literal["generate", "extend", "head-swap"] = "generate"
    # Bounded here, not only in the estimate: NaN, a negative or 1e9 used to
    # reach the runner untouched and fail a minute later in its own words.
    duration_seconds: float = Field(default=4, gt=0, le=60)
    aspect_ratio: str = Field(default="", max_length=16)
    # "max" is the ~1.0MP native-canvas tier (MiniMax H3's trained 768px short
    # edge); the studio only offers it for minimax-family workflows.
    resolution: Literal["", "standard", "high", "max"] = ""
    # -1 (or omitted) lets the runner pick a random seed; >= 0 is a fixed seed.
    seed: int | None = None
    # Optional post-generation grain cleanup on the native MLX LTX path.
    denoise: Literal["", "light", "strong"] = ""
    # Negative prompt. On the distilled local lanes this is applied through NAG
    # (guidance inside cross-attention); those run cfg=1, where a CFG-style
    # negative prompt does nothing at all.
    negative_prompt: str = Field(default="", max_length=_MAX_PROMPT_CHARS)
    # NAG strength. Omitted uses the runner default; <=1 disables guidance.
    nag_scale: float | None = Field(default=None, ge=0, le=100)
    head_swap_lora_strength: float | None = Field(default=None, ge=-10, le=10)
    head_swap_backend: str | None = Field(default=None, max_length=_MAX_ID_CHARS)
    head_swap_face_enhancer: bool = False
    # None = leave the workflow's own default alone; only an explicit choice
    # overrides the registered graph.
    spectrum: bool | None = None
    # Fast high-res: MiniMax H3's two-pass latent upscale (sample small, refine
    # at full size). Same tri-state — None leaves the registered graph alone.
    fast_high_res: bool | None = None
    # Sampling-steps override for workflows whose registry maps a steps slot
    # (MiniMax H3's refinement setting). None keeps the workflow default.
    steps: int | None = Field(default=None, ge=1, le=100)
    loras: list[MediaStudioLoraBody] = []


class HostedSam3QuoteBody(BaseModel):
    """What one hosted mask would cost. Measured by the browser, which has
    already decoded the clip — the price is quoted from these three numbers."""

    frames: int = Field(default=121, ge=1, le=400)
    width: int = Field(default=1280, ge=16, le=8192)
    height: int = Field(default=720, ge=16, le=8192)


class HostedSam3MaskBody(HostedSam3QuoteBody):
    # The clip to track, decrypted in-browser and sent inline like every other
    # reference. This is the one masking path where footage leaves the machine,
    # which the dialog says beside the button rather than in a policy.
    video_base64: str
    prompt: str = Field(default="head", max_length=200)
    detection_threshold: float = Field(default=0.5, ge=0.05, le=0.95)
    max_objects: int = Field(default=1, ge=0, le=64)
    detect_interval: int = Field(default=1, ge=1, le=64)
    # What the owner approved on the dialog's own price line. The client sends
    # back the figure it SHOWED, so a price that moved between the quote and the
    # submit is refused rather than silently charged.
    maximum_debit_usd: float = Field(default=0.5, gt=0, le=2)


class RestorePlanBody(BaseModel):
    """What the browser measured off the file it is holding.

    Bounded rather than trusted: these numbers only ever come from a local
    <video> element, but they decide how many chunks the gateway will plan, and
    a nonsense frame count should be a 422 rather than a ten-thousand-chunk
    project."""

    frames: int = Field(ge=1, le=10_000_000)
    fps: float = Field(default=24.0, gt=0, le=480)
    width: int = Field(ge=16, le=16384)
    height: int = Field(ge=16, le=16384)
    options: dict[str, Any] = Field(default_factory=dict)


class MediaStudioIngredientPreviewBody(BaseModel):
    ingredient_images: list[MediaStudioIngredientImageBody] = []
    aspect_ratio: str = "16:9"


class SpritePointBody(BaseModel):
    x: float = 0.0
    y: float = 0.0
    include: bool = True


class SpriteMatteBody(BaseModel):
    """One extracted frame plus what to keep in it.

    The frame arrives inline and decrypted — the browser pulled it out of a
    clip it was already playing — so nothing here reads the vault, and nothing
    is written down: the mask goes back in the same response.
    """

    image_base64: str = ""
    subject: str = ""
    points: list[SpritePointBody] = []
    confidence: float | None = None


class SimplePlanBody(BaseModel):
    prompt: str
    provider: str
    model: str
    auth: str | None = None
    promptHelper: bool = True
    walkthrough: bool = False
    confirmed: bool = False
    history: list[dict[str, Any]] = []
    attachments: list[dict[str, Any]] = []
    imageSelection: dict[str, str] = {}
    videoSelection: dict[str, str] = {}
    seed: int | None = None
    seedMode: Literal["fixed", "randomize", "increment", "decrement"] | None = None
    studioMode: Literal["create", "edit", "animate", "workflow"] = "create"
