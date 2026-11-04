import json
from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


def _snake_to_camel(name: str) -> str:
    parts = name.split("_")
    return parts[0] + "".join(p.capitalize() for p in parts[1:])


def camel_config(extra: dict | None = None) -> dict:
    cfg = {"alias_generator": _snake_to_camel, "populate_by_name": True}
    if extra:
        cfg.update(extra)
    return cfg


# ── Auth ──
class RegisterRequest(BaseModel):
    model_config = camel_config()
    email: str = Field(..., max_length=255)
    password: str = Field(..., min_length=6, max_length=128)
    name: str = Field(default="", max_length=100)

class LoginRequest(BaseModel):
    email: str
    password: str

class UpdateUserRequest(BaseModel):
    model_config = camel_config()
    name: Optional[str] = None
    email: Optional[str] = None

class UserResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; email: str; name: str; avatar: str
    created_at: datetime; updated_at: datetime

class AuthResponse(BaseModel):
    model_config = camel_config()
    user: UserResponse
    token: str

# ── Novel ──
class WorldSettingsSchema(BaseModel):
    model_config = camel_config()
    time_background: str = ""
    world_rules: list[str] = []
    power_system: str = ""
    forbidden_rules: list[str] = []

class CreateNovelRequest(BaseModel):
    model_config = camel_config()
    title: str = Field(..., max_length=255)
    background: str = ""
    genre: list[str] = []
    style: list[str] = []
    target_words: int = 200000
    min_chapter_words: int = 3000
    world_settings: Optional[WorldSettingsSchema] = None
    writing_style_rules: str = ""
    outline: str = ""

class UpdateNovelRequest(BaseModel):
    model_config = camel_config()
    title: Optional[str] = None
    background: Optional[str] = None
    genre: Optional[list[str]] = None
    style: Optional[list[str]] = None
    target_words: Optional[int] = None
    min_chapter_words: Optional[int] = None
    world_settings: Optional[WorldSettingsSchema] = None
    writing_style_rules: Optional[str] = None
    outline: Optional[str] = None

class NovelResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; user_id: str; title: str; background: str
    genre: list; style: list
    target_words: int; min_chapter_words: int
    world_settings: Optional[dict] = None
    writing_style_rules: str; outline: str; cover: str
    created_at: datetime; updated_at: datetime

# ── Volume ──
class CreateVolumeRequest(BaseModel):
    model_config = camel_config()
    title: str; summary: str = ""; order: int = 0

class BatchVolumeRequest(BaseModel):
    model_config = camel_config()
    volumes: list[CreateVolumeRequest]

class UpdateVolumeRequest(BaseModel):
    model_config = camel_config()
    title: Optional[str] = None; summary: Optional[str] = None; order: Optional[int] = None

class VolumeResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; novel_id: str; title: str; summary: str; order: int
    created_at: datetime; updated_at: datetime
    chapters: list["ChapterResponse"] = []

# ── Chapter ──
class CreateChapterRequest(BaseModel):
    model_config = camel_config()
    title: str = ""; content: str = ""; outline: str = ""
    order: int = 0; volume_id: Optional[str] = None; status: str = "draft"

class BatchChapterRequest(BaseModel):
    model_config = camel_config()
    chapters: list[CreateChapterRequest]

class UpdateChapterRequest(BaseModel):
    model_config = camel_config()
    title: Optional[str] = None; content: Optional[str] = None; outline: Optional[str] = None
    order: Optional[int] = None; word_count: Optional[int] = None
    status: Optional[str] = None; volume_id: Optional[str] = None

class ChapterResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; novel_id: str; volume_id: Optional[str] = None
    title: str; content: str; outline: str
    word_count: int; order: int; status: str
    created_at: datetime; updated_at: datetime

# ── Snapshot ──
class CreateSnapshotRequest(BaseModel):
    model_config = camel_config()
    label: str = ""

class SnapshotResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; chapter_id: str; title: str; content: str
    label: str; word_count: int; created_at: datetime

# ── Character ──
class CreateCharacterRequest(BaseModel):
    model_config = camel_config()
    name: str; role: str = "配角"
    personality: list[str] = []; abilities: list = []
    current_state: str = ""; relationships: list = []
    appearance: str = ""; background: str = ""

class UpdateCharacterRequest(BaseModel):
    model_config = camel_config()
    name: Optional[str] = None; role: Optional[str] = None
    personality: Optional[list[str]] = None; abilities: Optional[list] = None
    current_state: Optional[str] = None; relationships: Optional[list] = None
    appearance: Optional[str] = None; background: Optional[str] = None

class CharacterResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; novel_id: str; name: str; role: str
    personality: list; abilities: list
    current_state: str; relationships: list; appearance: str; background: str
    created_at: datetime; updated_at: datetime

# ── Plot Thread ──
class CreatePlotThreadRequest(BaseModel):
    model_config = camel_config()
    title: str; content: str = ""; status: str = "open"; chapter_id: str = ""

class UpdatePlotThreadRequest(BaseModel):
    model_config = camel_config()
    title: Optional[str] = None; content: Optional[str] = None
    status: Optional[str] = None; chapter_id: Optional[str] = None

class PlotThreadResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; novel_id: str; title: str; content: str
    status: str; chapter_id: str
    created_at: datetime; updated_at: datetime

# ── Timeline ──
class CreateTimelineEventRequest(BaseModel):
    model_config = camel_config()
    title: str; description: str = ""; time_label: str = ""
    order: int = 0; chapter_id: str = ""

class UpdateTimelineEventRequest(BaseModel):
    model_config = camel_config()
    title: Optional[str] = None; description: Optional[str] = None
    time_label: Optional[str] = None; order: Optional[int] = None; chapter_id: Optional[str] = None

class TimelineEventResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; novel_id: str; title: str; description: str
    time_label: str; order: int; chapter_id: str
    created_at: datetime; updated_at: datetime

# ── AI Config ──
class CreateAIConfigRequest(BaseModel):
    model_config = camel_config()
    provider: str; model: str; api_key: str
    base_url: str = ""; parameters: dict = {}; purpose: str = "default"

class UpdateAIConfigRequest(BaseModel):
    model_config = camel_config()
    provider: Optional[str] = None; model: Optional[str] = None
    api_key: Optional[str] = None; base_url: Optional[str] = None
    parameters: Optional[dict] = None; purpose: Optional[str] = None

class AIConfigResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; user_id: str; provider: str; model: str
    base_url: str; parameters: dict; is_default: bool; purpose: str
    created_at: datetime; updated_at: datetime

# ── Knowledge Base ──
class CreateKnowledgeBaseRequest(BaseModel):
    model_config = camel_config()
    name: str; description: str = ""; type: str = "general"

class UpdateKnowledgeBaseRequest(BaseModel):
    model_config = camel_config()
    name: Optional[str] = None; description: Optional[str] = None; type: Optional[str] = None

class KnowledgeBaseResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; novel_id: str; name: str; description: str; type: str
    created_at: datetime; updated_at: datetime

class KnowledgeDocumentResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; knowledge_base_id: str; title: str; content: str
    file_type: str; file_path: str; created_at: datetime

class KnowledgeSearchRequest(BaseModel):
    model_config = camel_config()
    query: str; limit: int = 5; top_k: int = 5

# ── Task ──
class TaskResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; type: str; status: str; progress: int; message: str
    result: Optional[dict] = None; error: str
    created_at: datetime; updated_at: datetime

# ── Sandbox ──
class CreateSandboxRequest(BaseModel):
    model_config = camel_config()
    title: str; premise: str = ""

class UpdateSandboxRequest(BaseModel):
    model_config = camel_config()
    title: Optional[str] = None; premise: Optional[str] = None
    content: Optional[str] = None; status: Optional[str] = None

class SandboxResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; novel_id: str; title: str; premise: str
    content: str; status: str
    created_at: datetime; updated_at: datetime

# ── Outline ──
class SaveOutlineVersionRequest(BaseModel):
    model_config = camel_config()
    content: str; context: Optional[dict] = None; mode: str = "manual"

class OutlineVersionResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; novel_id: str; content: str; context: Optional[dict] = None
    mode: str; is_locked: bool; version: int; created_at: datetime

# ── Agent ──
class CreateAgentSessionRequest(BaseModel):
    model_config = camel_config()
    novel_id: Optional[str] = None; title: str = ""

class AgentProcessRequest(BaseModel):
    model_config = camel_config()
    user_input: str = ""
    message: str = ""

class AgentConfirmRequest(BaseModel):
    model_config = camel_config()
    choice: str = ""
    modifications: Optional[list] = None
    plan: Optional[dict] = None

class AgentSessionResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; user_id: Optional[str] = None; novel_id: Optional[str] = None
    title: str; status: str
    context: Optional[dict] = None; plan: Optional[dict] = None
    created_at: datetime; updated_at: datetime

class AgentMessageResponse(BaseModel):
    model_config = camel_config({"from_attributes": True})
    id: str; session_id: str; role: str; content: str
    extra: Optional[dict] = None; created_at: datetime

    def model_dump(self, **kwargs):
        data = super().model_dump(**kwargs)
        data["metadata"] = data.pop("extra", None)
        return data

    def model_dump_json(self, **kwargs):
        data = super().model_dump(**kwargs)
        data["metadata"] = data.pop("extra", None)
        return json.dumps(data, **kwargs)

# ── Suggest/Generate ──
class SuggestTitlesRequest(BaseModel):
    model_config = camel_config()
    background: str; genre: list[str] = []; count: int = 5

class ExpandBackgroundRequest(BaseModel):
    model_config = camel_config()
    title: str; background: str; genre: list[str] = []

class CondenseOutlineRequest(BaseModel):
    model_config = camel_config()
    outline: str

class ExtractStyleRequest(BaseModel):
    model_config = camel_config()
    content: str = ""
    sample_text: str = ""

class ReadThroughRequest(BaseModel):
    model_config = camel_config()
    chapter_ids: list[str] = []

class OOCCheckRequest(BaseModel):
    model_config = camel_config()
    character_name: str = ""; content: str = ""

class ExtractPlotThreadsRequest(BaseModel):
    pass

class InferTimelineRequest(BaseModel):
    pass

class ExtractKnowledgeRequest(BaseModel):
    pass

class RewriteParagraphRequest(BaseModel):
    model_config = camel_config()
    paragraph_text: str = ""; rest_of_chapter_content: str = ""
    additional_instructions: str = ""
    paragraph: str = ""; instruction: str = ""

class GenerateVolumesRequest(BaseModel):
    model_config = camel_config()
    count: int = 5
    outline: str = ""
    additional_requirements: str = ""

class GenerateChaptersRequest(BaseModel):
    model_config = camel_config()
    volume_id: str = ""
    count: int = 10
    outline: str = ""
    additional_requirements: str = ""

class GenerateChapterContentRequest(BaseModel):
    model_config = camel_config()
    prompt_hint: str = ""

class GenerateCharactersRequest(BaseModel):
    model_config = camel_config()
    count: int = 3

class GenerateSandboxRequest(BaseModel):
    pass

class ImportNovelRequest(BaseModel):
    model_config = camel_config()
    title: str; content: str
