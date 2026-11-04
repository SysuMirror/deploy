import json
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from database import get_db
from schemas import (
    CreateChapterRequest, UpdateChapterRequest, ChapterResponse,
    BatchChapterRequest, BatchVolumeRequest, CreateVolumeRequest,
    UpdateVolumeRequest, VolumeResponse, CreateSnapshotRequest,
    SnapshotResponse, ReadThroughRequest, OOCCheckRequest,
    ExtractPlotThreadsRequest, InferTimelineRequest,
    ExtractKnowledgeRequest, RewriteParagraphRequest,
    GenerateVolumesRequest, GenerateChaptersRequest, GenerateChapterContentRequest,
)
from middleware.auth import get_current_user
from models import User, Novel, Volume, Chapter, ChapterSnapshot
from services.ai_service import AIService
from services.agent import Orchestrator
from utils.helpers import new_id

router = APIRouter(prefix="/api", tags=["chapters"])


def _get_ai_and_orch():
    ai = AIService()
    orch = Orchestrator(ai)
    return ai, orch


# ── Volume routes ──
@router.post("/novels/{novel_id}/volumes/batch")
def save_batch_volumes(
    novel_id: str,
    req: BatchVolumeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    volumes = []
    for v in req.volumes:
        vol = Volume(id=new_id(), novel_id=novel_id, title=v.title, summary=v.summary, order=v.order)
        db.add(vol)
        volumes.append(vol)
    db.commit()
    return {"volumes": [{"id": v.id, "title": v.title} for v in volumes]}


@router.patch("/novels/{novel_id}/volumes/{volume_id}", response_model=VolumeResponse)
def update_volume(
    novel_id: str,
    volume_id: str,
    req: UpdateVolumeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    vol = db.query(Volume).filter(Volume.id == volume_id, Volume.novel_id == novel_id).first()
    if not vol:
        raise HTTPException(status_code=404, detail="分卷不存在")
    for key, val in req.model_dump(exclude_unset=True).items():
        setattr(vol, key, val)
    db.commit()
    db.refresh(vol)
    return vol


@router.delete("/novels/{novel_id}/volumes/{volume_id}")
def delete_volume(
    novel_id: str,
    volume_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    vol = db.query(Volume).filter(Volume.id == volume_id, Volume.novel_id == novel_id).first()
    if not vol:
        raise HTTPException(status_code=404, detail="分卷不存在")
    db.delete(vol)
    db.commit()
    return {"ok": True}


# ── Chapter routes ──
@router.get("/chapters/{chapter_id}", response_model=ChapterResponse)
def get_chapter(
    chapter_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ch = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")
    return ch


@router.patch("/chapters/{chapter_id}", response_model=ChapterResponse)
def update_chapter(
    chapter_id: str,
    req: UpdateChapterRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ch = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")
    for key, val in req.model_dump(exclude_unset=True).items():
        setattr(ch, key, val)
    db.commit()
    db.refresh(ch)
    return ch


@router.delete("/chapters/{chapter_id}")
def delete_chapter(
    chapter_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ch = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")
    db.delete(ch)
    db.commit()
    return {"ok": True}


# ── Snapshots ──
@router.get("/chapters/{chapter_id}/snapshots", response_model=list[SnapshotResponse])
def list_snapshots(
    chapter_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(ChapterSnapshot).filter(ChapterSnapshot.chapter_id == chapter_id).order_by(ChapterSnapshot.created_at.desc()).all()


@router.post("/chapters/{chapter_id}/snapshots", response_model=SnapshotResponse)
def create_snapshot(
    chapter_id: str,
    req: CreateSnapshotRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ch = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")
    snap = ChapterSnapshot(
        id=new_id(),
        chapter_id=chapter_id,
        title=ch.title,
        content=ch.content,
        label=req.label,
        word_count=ch.word_count,
    )
    db.add(snap)
    db.commit()
    db.refresh(snap)
    return snap


@router.get("/chapters/{chapter_id}/snapshots/{snapshot_id}", response_model=SnapshotResponse)
def get_snapshot(
    chapter_id: str,
    snapshot_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    snap = db.query(ChapterSnapshot).filter(ChapterSnapshot.id == snapshot_id, ChapterSnapshot.chapter_id == chapter_id).first()
    if not snap:
        raise HTTPException(status_code=404, detail="快照不存在")
    return snap


@router.post("/chapters/{chapter_id}/snapshots/{snapshot_id}/restore")
def restore_snapshot(
    chapter_id: str,
    snapshot_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    snap = db.query(ChapterSnapshot).filter(ChapterSnapshot.id == snapshot_id, ChapterSnapshot.chapter_id == chapter_id).first()
    if not snap:
        raise HTTPException(status_code=404, detail="快照不存在")
    ch = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    ch.title = snap.title
    ch.content = snap.content
    ch.word_count = snap.word_count
    db.commit()
    return {"ok": True}


@router.delete("/chapters/{chapter_id}/snapshots/{snapshot_id}")
def delete_snapshot(
    chapter_id: str,
    snapshot_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    snap = db.query(ChapterSnapshot).filter(ChapterSnapshot.id == snapshot_id, ChapterSnapshot.chapter_id == chapter_id).first()
    if not snap:
        raise HTTPException(status_code=404, detail="快照不存在")
    db.delete(snap)
    db.commit()
    return {"ok": True}


# ── Volume/Chapter generation ──
@router.post("/novels/{novel_id}/generate/volumes")
async def generate_volumes(
    novel_id: str,
    req: GenerateVolumesRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from services.task_service import create_task, update_task, notify_task

    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    outline = req.outline or novel.outline or ""
    if not outline.strip():
        raise HTTPException(status_code=400, detail="请先填写大纲")

    task = create_task(
        db, user_id=current_user.id, novel_id=novel_id,
        task_type="generate_volumes", message="正在生成分卷…",
    )
    try:
        planned = await orch.Outline.generate_volumes(
            config, novel.title, novel.background, outline, req.count,
            additional_requirements=req.additional_requirements or "",
        )
        saved = []
        for v in planned:
            vol = Volume(
                id=new_id(), novel_id=novel_id,
                title=v["title"], summary=v.get("summary", ""), order=v.get("order", 0),
            )
            db.add(vol)
            saved.append(vol)
        db.commit()
        volumes_out = [{"id": v.id, "title": v.title, "summary": v.summary, "order": v.order} for v in saved]
        update_task(
            db, task, status="completed", progress=100, message="分卷生成完成",
            result={"volumes": volumes_out},
        )
        await notify_task(task, "task:completed")
        return {"id": task.id, "status": "completed", "volumes": volumes_out}
    except Exception as e:
        update_task(db, task, status="failed", message="分卷生成失败", error=str(e))
        await notify_task(task, "task:failed")
        raise HTTPException(status_code=500, detail=f"分卷生成失败: {e}")


@router.post("/novels/{novel_id}/generate/chapters")
async def generate_chapters(
    novel_id: str,
    req: GenerateChaptersRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from services.task_service import create_task, update_task, notify_task

    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    if not req.volume_id:
        raise HTTPException(status_code=400, detail="请选择分卷")
    vol = db.query(Volume).filter(Volume.id == req.volume_id, Volume.novel_id == novel_id).first()
    if not vol:
        raise HTTPException(status_code=404, detail="分卷不存在")
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    outline = req.outline or novel.outline or vol.summary or ""

    task = create_task(
        db, user_id=current_user.id, novel_id=novel_id,
        task_type="generate_chapters", message="正在生成章节…",
    )
    try:
        planned = await orch.Outline.generate_chapters(
            config, novel.title, vol.title, outline, req.count,
            additional_requirements=req.additional_requirements or "",
        )
        saved = []
        for c in planned:
            ch = Chapter(
                id=new_id(), novel_id=novel_id, volume_id=vol.id,
                title=c["title"], content="", outline=c.get("outline", ""),
                order=c.get("order", 0), status="draft",
            )
            db.add(ch)
            saved.append(ch)
        db.commit()
        chapters_out = [
            {"id": c.id, "title": c.title, "outline": c.outline, "order": c.order, "status": c.status}
            for c in saved
        ]
        update_task(
            db, task, status="completed", progress=100, message="章节生成完成",
            result={"volumeId": vol.id, "chapters": chapters_out},
        )
        await notify_task(task, "task:completed")
        return {"id": task.id, "status": "completed", "chapters": chapters_out, "volumeId": vol.id}
    except Exception as e:
        update_task(db, task, status="failed", message="章节生成失败", error=str(e))
        await notify_task(task, "task:failed")
        raise HTTPException(status_code=500, detail=f"章节生成失败: {e}")


@router.post("/novels/{novel_id}/chapters/{chapter_id}/generate")
async def generate_chapter_content(
    novel_id: str,
    chapter_id: str,
    req: GenerateChapterContentRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    from services.task_service import create_task, update_task, notify_task

    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    ch = db.query(Chapter).filter(Chapter.id == chapter_id, Chapter.novel_id == novel_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")

    task = create_task(
        db, user_id=current_user.id, novel_id=novel_id,
        task_type="generate_chapter_content", message=f"正在生成《{ch.title}》正文…",
    )
    try:
        prev_chapters = (
            db.query(Chapter)
            .filter(Chapter.novel_id == novel_id, Chapter.order < ch.order)
            .order_by(Chapter.order.desc())
            .limit(3)
            .all()
        )
        prev_content = "\n".join(f"{c.title}: {(c.content or '')[:500]}" for c in reversed(prev_chapters))
        result = await orch.Author.draft_chapter(
            config, novel.title, novel.background, novel.style or [],
            ch.outline or "", prev_content, req.prompt_hint or "开始创作",
        )
        ch.content = result
        ch.word_count = len(result or "")
        ch.status = "draft"
        db.commit()
        update_task(
            db, task, status="completed", progress=100, message="正文生成完成",
            result={"chapterId": ch.id, "content": result, "wordCount": ch.word_count},
        )
        await notify_task(task, "task:completed")
        return {"id": task.id, "status": "completed", "content": result, "chapterId": ch.id}
    except Exception as e:
        update_task(db, task, status="failed", message="正文生成失败", error=str(e))
        await notify_task(task, "task:failed")
        raise HTTPException(status_code=500, detail=f"正文生成失败: {e}")


# ── Chapter batch save ──
@router.post("/novels/{novel_id}/volumes/{volume_id}/chapters/batch")
def save_batch_chapters(
    novel_id: str,
    volume_id: str,
    req: BatchChapterRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    chapters = []
    for c in req.chapters:
        ch = Chapter(
            id=new_id(), novel_id=novel_id, volume_id=volume_id,
            title=c.title, content=c.content, outline=c.outline,
            order=c.order, status=c.status,
        )
        db.add(ch)
        chapters.append(ch)
    db.commit()
    return {"chapters": [{"id": c.id, "title": c.title} for c in chapters]}


# ── AI analysis endpoints ──
@router.post("/novels/{novel_id}/chapters/read-through")
async def read_through(
    novel_id: str,
    req: ReadThroughRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    chapters = db.query(Chapter).filter(Chapter.id.in_(req.chapter_ids)).all() if req.chapter_ids else []
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    result = await orch.Reader.read_through(config, novel.title, [
        {"order": c.order, "title": c.title, "content": c.content} for c in chapters
    ])
    return {"report": result}


@router.post("/chapters/{chapter_id}/ooc-check")
async def ooc_check(
    chapter_id: str,
    req: OOCCheckRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    char_name = req.character_name or "角色"
    result = await orch.Character.check_ooc(config, char_name, "", req.content)
    return {"report": result}


@router.post("/chapters/{chapter_id}/extract-plot-threads")
async def extract_plot_threads(
    chapter_id: str,
    req: ExtractPlotThreadsRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ch = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    result = await orch.Foreshadowing.extract_plot_threads(config, ch.content, [])
    return {"threads": result}


@router.post("/chapters/{chapter_id}/infer-timeline")
async def infer_timeline(
    chapter_id: str,
    req: InferTimelineRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ch = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    result = await orch.Foreshadowing.infer_timeline(config, ch.content, [])
    return {"timeline": result}


@router.post("/chapters/{chapter_id}/extract-knowledge")
async def extract_knowledge(
    chapter_id: str,
    req: ExtractKnowledgeRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ch = db.query(Chapter).filter(Chapter.id == chapter_id).first()
    if not ch:
        raise HTTPException(status_code=404, detail="章节不存在")
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    result = await orch.Knowledge.extract_knowledge(config, ch.content)
    return {"knowledge": result}


@router.post("/chapters/{chapter_id}/rewrite-paragraph")
async def rewrite_paragraph(
    chapter_id: str,
    req: RewriteParagraphRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    paragraph = req.paragraph_text or req.paragraph or ""
    instruction = req.additional_instructions or req.instruction or ""
    result = await orch.Author.rewrite_paragraph(config, paragraph, instruction)
    return {"content": result}
