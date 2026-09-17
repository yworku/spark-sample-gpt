from __future__ import annotations

import re
from typing import Annotated, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

Id = Annotated[str, Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")]
Short = Annotated[str, Field(max_length=200)]
Color = Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$")]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ClipSettings(StrictModel):
    trim_start: float = Field(default=0, ge=0, le=1200)
    trim_end: float | None = Field(default=None, gt=0, le=1200)
    speed: float = Field(default=1, ge=0.25, le=4)
    volume: float = Field(default=1, ge=0, le=2)
    offset: float = Field(default=0, ge=0, le=120)
    loop: bool = False
    end_behavior: Literal["hold", "image"] = "hold"

    @model_validator(mode="after")
    def valid_trim(self):
        if self.trim_end is not None and self.trim_end <= self.trim_start:
            raise ValueError("Trim end must be after trim start.")
        return self


class CaptionWord(StrictModel):
    text: str = Field(max_length=200)
    start: float = Field(ge=0, le=120)
    end: float = Field(gt=0, le=120)
    hidden: bool = False

    @model_validator(mode="after")
    def valid_time(self):
        if self.end <= self.start:
            raise ValueError("Caption word end must follow its start.")
        return self


class CaptionSettings(StrictModel):
    enabled: bool = False
    text: str = Field(default="", max_length=10000)
    style: Literal["plain", "bubble", "highlight"] = "plain"
    position: Literal["top", "center", "bottom"] = "bottom"
    font: str = Field(default="sans", max_length=80)
    size: float = Field(default=40, ge=8, le=160)
    color: Color = "#ffffff"
    background: Color = "#00000080"
    words: list[CaptionWord] = Field(default_factory=list, max_length=2000)


class Effect(StrictModel):
    type: Literal["none", "zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down", "ken_burns", "drift", "pulse", "rotate", "tilt", "bounce"] = "none"
    intensity: float = Field(default=0.1, ge=0, le=1)


class Transition(StrictModel):
    type: Literal["none", "fade", "crossfade", "dissolve", "slide_left", "slide_right", "slide_up", "slide_down", "wipe_left", "wipe_right", "wipe_up", "wipe_down", "zoom"] = "none"
    duration: float = Field(default=0.5, ge=0, le=5)


class Layer(StrictModel):
    id: Id = Field(default_factory=lambda: str(uuid4()))
    kind: Literal["text", "image"]
    text: str = Field(default="", max_length=5000)
    asset_id: Id | None = None
    x: float = Field(default=0.1, ge=0, le=1)
    y: float = Field(default=0.1, ge=0, le=1)
    width: float = Field(default=0.8, gt=0, le=1)
    height: float = Field(default=0.2, gt=0, le=1)
    start: float = Field(default=0, ge=0, le=120)
    end: float | None = Field(default=None, gt=0, le=120)
    font_size: float = Field(default=40, ge=8, le=160)
    color: Color = "#ffffff"
    opacity: float = Field(default=1, ge=0, le=1)

    @model_validator(mode="after")
    def valid_layer(self):
        if self.x + self.width > 1.000001 or self.y + self.height > 1.000001:
            raise ValueError("Layers must fit inside the frame.")
        if self.end is not None and self.end <= self.start:
            raise ValueError("Layer end must follow its start.")
        if self.kind == "image" and self.asset_id is None:
            raise ValueError("Image layers require an image asset.")
        return self


class Scene(StrictModel):
    id: Id = Field(default_factory=lambda: str(uuid4()))
    title: Short = "Untitled scene"
    script: str = Field(default="", max_length=10000)
    image_prompt: str = Field(default="", max_length=12000)
    video_prompt: str = Field(default="", max_length=12000)
    character_ids: list[Id] = Field(default_factory=list, max_length=20)
    image_id: Id | None = None
    video_id: Id | None = None
    voice_id: Id | None = None
    visual: Literal["image", "video"] = "image"
    duration_mode: Literal["manual", "voice", "video"] = "manual"
    duration: float = Field(default=5, ge=0.1, le=120)
    video: ClipSettings = Field(default_factory=ClipSettings)
    voice: ClipSettings = Field(default_factory=ClipSettings)
    caption: CaptionSettings = Field(default_factory=CaptionSettings)
    effect: Effect = Field(default_factory=Effect)
    transition: Transition = Field(default_factory=Transition)
    layers: list[Layer] = Field(default_factory=list, max_length=20)


class Character(StrictModel):
    id: Id = Field(default_factory=lambda: str(uuid4()))
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=10000)
    asset_id: Id | None = None


class MusicSettings(StrictModel):
    asset_id: Id | None = None
    volume: float = Field(default=0.2, ge=0, le=2)
    trim_start: float = Field(default=0, ge=0, le=1200)
    trim_end: float | None = Field(default=None, gt=0, le=1200)
    loop: bool = True
    fade_in: float = Field(default=0, ge=0, le=60)
    fade_out: float = Field(default=1, ge=0, le=60)
    ducking: bool = True

    @model_validator(mode="after")
    def valid_trim(self):
        if self.trim_end is not None and self.trim_end <= self.trim_start:
            raise ValueError("Music trim end must follow trim start.")
        return self


class ProjectDocument(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["video"] = "video"
    ratio: Literal["16:9", "9:16", "1:1"] = "16:9"
    style: str = Field(default="cinematic", max_length=100)
    language: str = Field(default="English", min_length=1, max_length=80)
    scenes: list[Scene] = Field(default_factory=list, max_length=50)
    characters: list[Character] = Field(default_factory=list, max_length=30)
    music: MusicSettings = Field(default_factory=MusicSettings)

    @model_validator(mode="after")
    def unique_ids(self):
        ids = [s.id for s in self.scenes] + [c.id for c in self.characters]
        ids.extend(layer.id for scene in self.scenes for layer in scene.layers)
        if len(ids) != len(set(ids)):
            raise ValueError("Scene, character, and layer IDs must be unique.")
        known = {c.id for c in self.characters}
        if any(not set(scene.character_ids).issubset(known) for scene in self.scenes):
            raise ValueError("A scene references a character outside this project.")
        return self


class CreateProject(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["video"] = "video"
    ratio: Literal["16:9", "9:16", "1:1"] = "16:9"
    style: str = Field(default="cinematic", max_length=100)
    language: str = Field(default="English", min_length=1, max_length=80)
    script: str = Field(default="", max_length=100000)
    scene_count: int = Field(default=1, ge=1, le=50)
    mode: Literal["blank", "paste"] = "blank"


class UpdateProject(StrictModel):
    base_revision: int = Field(ge=1)
    document: ProjectDocument


class CreateJob(StrictModel):
    kind: Literal["story", "image", "image_edit", "voice", "caption_align", "video", "music", "character", "export"]
    scene_id: Id | None = None
    character_id: Id | None = None
    prompt: str | None = Field(default=None, max_length=12000)
    settings: dict = Field(default_factory=dict)
    base_revision: int = Field(ge=1)
    idempotency_key: str = Field(min_length=8, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")


class Login(StrictModel):
    password: str = Field(min_length=1, max_length=1024)


class ImportCharacter(StrictModel):
    source_project_id: Id
    source_character_id: Id
    base_revision: int = Field(ge=1)


class ImportAsset(StrictModel):
    source_asset_id: Id
    scene_id: Id | None = None
    character_id: Id | None = None


def initial_document(body: CreateProject) -> ProjectDocument:
    values = body.model_dump(exclude={"script", "scene_count", "mode"})
    if body.mode == "paste":
        paragraphs = [part.strip() for part in re.split(r"\n\s*\n", body.script.strip()) if part.strip()]
        if not paragraphs:
            raise ValueError("Paste a script to create scenes.")
        if len(paragraphs) > 50 or any(len(p) > 10000 for p in paragraphs):
            raise ValueError("Use at most 50 paragraphs, each no longer than 10,000 characters.")
        scenes = [Scene(title=f"Scene {i + 1}", script=text) for i, text in enumerate(paragraphs)]
    else:
        scenes = [Scene(title=f"Scene {i + 1}") for i in range(body.scene_count)]
    return ProjectDocument(**values, scenes=scenes)
