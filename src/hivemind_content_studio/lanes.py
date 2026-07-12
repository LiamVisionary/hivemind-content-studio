"""Typed content-lane catalog shared by agents, API routes, and the studio UI."""

from __future__ import annotations

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class LaneDefinition:
    id: str
    label: str
    eyebrow: str
    description: str
    steps: tuple[str, ...]
    default_aspect_ratio: str
    default_runtime_seconds: int
    supports: dict[str, bool]

    def as_dict(self) -> dict:
        value = asdict(self)
        value["steps"] = list(self.steps)
        return value


LANE_MATRIX: tuple[LaneDefinition, ...] = (
    LaneDefinition(
        "first-frame-animation-ad",
        "First-frame ad",
        "Performance animation",
        "Plan consistent scene anchors, animate each beat, add exact voice, then assemble and evaluate.",
        ("script", "keyframes", "motion", "voice", "assembly", "evaluation", "approval", "publish", "metrics"),
        "9:16",
        15,
        {"scenes": True, "voice": True, "source": False, "media_source": False},
    ),
    LaneDefinition(
        "stickman-performance-ad",
        "Stickman ad",
        "Low-cost creative",
        "Build a restrained black-line ad with one argument per scene and optional product cut-ins.",
        ("script", "keyframes", "voice", "assembly", "evaluation", "approval", "publish", "metrics"),
        "9:16",
        12,
        {"scenes": True, "voice": True, "source": False, "media_source": False},
    ),
    LaneDefinition(
        "static-text-ad",
        "Static text ad",
        "Fast control variant",
        "Turn one clear message into a cheap, legible creative for rapid testing.",
        ("script", "keyframes", "evaluation", "approval", "publish", "metrics"),
        "4:5",
        6,
        {"scenes": True, "voice": False, "source": False, "media_source": False},
    ),
    LaneDefinition(
        "animation",
        "Animation",
        "Scene-led production",
        "Create explainers, narrative shorts, training content, and launch films from a structured scene plan.",
        ("script", "keyframes", "motion", "voice", "assembly", "evaluation", "approval", "publish", "metrics"),
        "16:9",
        60,
        {"scenes": True, "voice": True, "source": False, "media_source": False},
    ),
    LaneDefinition(
        "faceless",
        "Faceless video",
        "Stock or owned media",
        "Generate a narrated short from a topic or script using stock footage, local media, subtitles, and music.",
        ("script", "render", "evaluation", "approval", "publish", "metrics"),
        "9:16",
        30,
        {"scenes": False, "voice": True, "source": False, "media_source": True},
    ),
    LaneDefinition(
        "clip",
        "Clip long-form",
        "Rights-aware repurposing",
        "Find and render strong moments from owned or approved long-form source media.",
        ("clip", "evaluation", "approval", "publish", "metrics"),
        "9:16",
        45,
        {"scenes": False, "voice": False, "source": True, "media_source": False},
    ),
    LaneDefinition(
        "social-post",
        "Publish existing media",
        "Distribution workflow",
        "Evaluate, approve, schedule, and measure an existing asset without regenerating it.",
        ("evaluation", "approval", "publish", "metrics"),
        "9:16",
        15,
        {"scenes": False, "voice": False, "source": True, "media_source": False},
    ),
)

LANE_BY_ID = {lane.id: lane for lane in LANE_MATRIX}
LANE_STEPS = {lane.id: list(lane.steps) for lane in LANE_MATRIX}

