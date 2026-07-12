"""Validated browser-studio drafts converted into canonical provider-neutral briefs."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from .lanes import LANE_BY_ID
from .providers import providers_for


class LenientDraft(BaseModel):
    """LLM brains emit null for fields they leave empty; treat null as absent so
    field defaults apply instead of failing the whole production draft."""

    @model_validator(mode="before")
    @classmethod
    def drop_null_fields(cls, value: object) -> object:
        if isinstance(value, dict):
            return {key: item for key, item in value.items() if item is not None}
        return value


class SceneDraft(LenientDraft):
    title: str = Field(default="", max_length=120)
    beat: str = Field(default="", max_length=3000)
    voice: str = Field(default="", max_length=3000)
    overlay: str = Field(default="", max_length=500)
    duration_seconds: float = Field(default=4, ge=0.5, le=300)
    image_prompt: str = Field(default="", max_length=5000)
    motion_prompt: str = Field(default="", max_length=5000)


class VoiceDraft(LenientDraft):
    enabled: bool = True
    provider: str = Field(default="universal-tts", max_length=80)
    delivery: str = Field(default="", max_length=300)
    voice_id: str = Field(default="", max_length=200)


class SubtitleDraft(LenientDraft):
    enabled: bool = True
    position: Literal["top", "center", "bottom"] = "bottom"
    font_size: int = Field(default=56, ge=20, le=140)


PLATFORM_ALIASES = {
    "instagram_reels": "instagram",
    "reels": "instagram",
    "ig": "instagram",
    "twitter": "x",
    "x_twitter": "x",
    "youtube_shorts": "youtube",
    "shorts": "youtube",
    "tik_tok": "tiktok",
}
ALLOWED_PLATFORMS = ("instagram", "tiktok", "youtube", "facebook", "x", "linkedin")


class PublishDraft(LenientDraft):
    platforms: list[Literal["instagram", "tiktok", "youtube", "facebook", "x", "linkedin"]] = Field(default_factory=list)
    caption: str = Field(default="", max_length=5000)
    cta: str = Field(default="", max_length=500)

    @field_validator("platforms", mode="before")
    @classmethod
    def normalize_platforms(cls, value: object) -> object:
        """Brains invent platform aliases (instagram_reels, shorts); a bad publish
        target should be normalized or dropped, never fail the whole production."""
        if not isinstance(value, list):
            return value
        normalized: list[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            slug = item.strip().lower().replace(" ", "_").replace("-", "_")
            slug = PLATFORM_ALIASES.get(slug, slug)
            if slug in ALLOWED_PLATFORMS and slug not in normalized:
                normalized.append(slug)
        return normalized


class FacelessDraft(LenientDraft):
    script: str = Field(default="", max_length=20_000)
    search_terms: list[str] = Field(default_factory=list, max_length=100)
    media_source: Literal["pexels", "pixabay", "local"] = "pexels"
    count: int = Field(default=1, ge=1, le=20)
    clip_duration_seconds: int = Field(default=5, ge=1, le=30)

    @field_validator("search_terms")
    @classmethod
    def validate_search_terms(cls, value: list[str]) -> list[str]:
        terms = [term.strip() for term in value if term.strip()]
        if any(len(term) > 300 for term in terms):
            raise ValueError("Search terms must be 300 characters or shorter")
        return terms


class StudioRunDraft(LenientDraft):
    lane: str
    title: str = Field(min_length=1, max_length=180)
    concept: str = Field(default="", max_length=5000)
    audience: str = Field(default="", max_length=1000)
    goal: str = Field(default="", max_length=1000)
    tone: str = Field(default="", max_length=500)
    source: str = Field(default="", max_length=4000)
    creator: str = Field(default="", max_length=300)
    aspect_ratio: Literal["9:16", "4:5", "1:1", "16:9"] | None = None
    runtime_seconds: int | None = Field(default=None, ge=1, le=7200)
    privacy: Literal["local-only", "local-first", "cloud-allowed"] = "local-first"
    max_cost_usd: float = Field(default=0, ge=0, le=10000)
    scenes: list[SceneDraft] = Field(default_factory=list, max_length=100)
    voice: VoiceDraft = Field(default_factory=VoiceDraft)
    subtitles: SubtitleDraft = Field(default_factory=SubtitleDraft)
    providers: dict[str, str] = Field(default_factory=dict)
    provider_options: dict[str, dict] = Field(default_factory=dict)
    publish: PublishDraft = Field(default_factory=PublishDraft)
    faceless: FacelessDraft = Field(default_factory=FacelessDraft)

    @model_validator(mode="before")
    @classmethod
    def normalize_provider_options(cls, value: object) -> object:
        if not isinstance(value, dict):
            return value
        raw_options = value.get("provider_options")
        if not isinstance(raw_options, dict):
            return value
        providers = value.get("providers") if isinstance(value.get("providers"), dict) else {}
        normalized = {str(key): dict(item) for key, item in raw_options.items() if isinstance(item, dict)}
        planning: dict[str, object] = {}
        role_aliases = {"video": "motion", "tts": "voice"}
        for raw_key, item in raw_options.items():
            if isinstance(item, dict) or item is None:
                continue
            key = str(raw_key)
            role = key.removesuffix("_model") if key.endswith("_model") else ""
            role = role_aliases.get(role, role)
            provider = providers.get(role) if role else None
            if isinstance(provider, str) and provider:
                normalized.setdefault(provider, {}).setdefault("model", item)
            else:
                planning[key] = item
        if planning:
            planning_options = normalized.setdefault("_planning", {})
            for key, item in planning.items():
                planning_options.setdefault(key, item)
        return {**value, "provider_options": normalized}

    @field_validator("lane")
    @classmethod
    def validate_lane(cls, value: str) -> str:
        if value not in LANE_BY_ID:
            raise ValueError("Unsupported content lane")
        return value

    @field_validator("providers")
    @classmethod
    def validate_providers(cls, value: dict[str, str]) -> dict[str, str]:
        for role, provider_id in value.items():
            available_ids = {provider.id for provider in providers_for(role)}
            if not available_ids or provider_id not in available_ids:
                raise ValueError(f"Provider {provider_id!r} does not support role {role!r}")
        return value

    @model_validator(mode="after")
    def validate_source(self) -> "StudioRunDraft":
        if LANE_BY_ID[self.lane].supports["source"] and not self.source.strip():
            raise ValueError(f"The {self.lane} lane requires a source")
        return self

    def to_brief(self) -> dict:
        lane = LANE_BY_ID[self.lane]
        scenes = [scene.model_dump(exclude_defaults=True) for scene in self.scenes]
        if lane.supports["scenes"] and not scenes:
            scenes = [{"title": "Opening", "beat": self.concept or self.goal or self.title, "duration_seconds": 4}]
        brief = {
            "id": self.title,
            "lane": self.lane,
            "title": self.title,
            "concept": self.concept,
            "audience": self.audience,
            "goal": self.goal,
            "tone": self.tone,
            "source": self.source or None,
            "creator": self.creator or None,
            "aspect_ratio": self.aspect_ratio or lane.default_aspect_ratio,
            "runtime_seconds": self.runtime_seconds or lane.default_runtime_seconds,
            "scenes": scenes,
            "voice": self.voice.model_dump(exclude_defaults=True),
            "subtitles": self.subtitles.model_dump(),
            "providers": self.providers,
            "provider_options": self.provider_options,
            "publish": self.publish.model_dump(),
        }
        if self.lane == "faceless":
            brief.update(self.faceless.model_dump())
        return brief

    def to_script_markdown(self) -> str:
        """Render the brain-approved draft as a vendor-neutral production script."""
        lines = [f"# {self.title}"]
        overview = (
            ("Concept", self.concept),
            ("Audience", self.audience),
            ("Goal", self.goal),
            ("Tone", self.tone),
        )
        for label, value in overview:
            if value.strip():
                lines.extend(("", f"**{label}:** {value.strip()}"))
        if self.faceless.script.strip():
            lines.extend(("", "## Narration", "", self.faceless.script.strip()))
        scenes = self.scenes or [SceneDraft(title="Opening", beat=self.concept or self.goal or self.title)]
        lines.extend(("", "## Scenes"))
        for index, scene in enumerate(scenes, start=1):
            lines.extend(("", f"### Scene {index}: {scene.title.strip() or f'Scene {index}'}"))
            if scene.duration_seconds:
                lines.append(f"- Duration: {scene.duration_seconds:g} seconds")
            for label, value in (
                ("Beat", scene.beat),
                ("Voice", scene.voice),
                ("On-screen text", scene.overlay),
                ("Image direction", scene.image_prompt),
                ("Motion direction", scene.motion_prompt),
            ):
                if value.strip():
                    lines.append(f"- {label}: {value.strip()}")
        if self.publish.caption.strip() or self.publish.cta.strip():
            lines.extend(("", "## Distribution copy"))
            if self.publish.caption.strip():
                lines.extend(("", self.publish.caption.strip()))
            if self.publish.cta.strip():
                lines.extend(("", f"CTA: {self.publish.cta.strip()}"))
        return "\n".join(lines).rstrip() + "\n"
