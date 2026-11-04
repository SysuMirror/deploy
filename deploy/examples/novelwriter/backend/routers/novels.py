import json
import os
from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from database import get_db
from schemas import (
    CreateNovelRequest, UpdateNovelRequest, NovelResponse,
    SuggestTitlesRequest, ExpandBackgroundRequest, CondenseOutlineRequest,
    ExtractStyleRequest, ImportNovelRequest,
)
from middleware.auth import get_current_user
from models import User, Novel, Volume, Chapter, Character
from services.ai_service import AIService
from services.agent import Orchestrator
from utils.helpers import new_id
from config import settings

router = APIRouter(prefix="/api/novels", tags=["novels"])


def _get_ai_and_orch():
    ai = AIService()
    orch = Orchestrator(ai)
    return ai, orch


@router.get("", response_model=list[NovelResponse])
def list_novels(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(Novel).filter(Novel.user_id == current_user.id).order_by(Novel.updated_at.desc()).all()


@router.post("", response_model=NovelResponse)
def create_novel(
    req: CreateNovelRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = Novel(
        id=new_id(),
        user_id=current_user.id,
        title=req.title,
        background=req.background,
        genre=req.genre,
        style=req.style,
        target_words=req.target_words,
        min_chapter_words=req.min_chapter_words,
        world_settings=req.world_settings.model_dump() if req.world_settings else None,
        writing_style_rules=req.writing_style_rules,
        outline=req.outline,
    )
    db.add(novel)
    db.commit()
    db.refresh(novel)
    return novel


@router.get("/{novel_id}")
def get_novel(
    novel_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    base = NovelResponse.model_validate(novel).model_dump(by_alias=True)
    volumes = (
        db.query(Volume)
        .filter(Volume.novel_id == novel_id)
        .order_by(Volume.order)
        .all()
    )
    chapters = (
        db.query(Chapter)
        .filter(Chapter.novel_id == novel_id)
        .order_by(Chapter.order)
        .all()
    )
    characters = db.query(Character).filter(Character.novel_id == novel_id).all()
    vol_payload = []
    for v in volumes:
        vol_chapters = [
            {
                "id": c.id,
                "novelId": c.novel_id,
                "volumeId": c.volume_id,
                "title": c.title,
                "content": c.content,
                "outline": c.outline,
                "wordCount": c.word_count,
                "order": c.order,
                "status": c.status,
            }
            for c in chapters
            if c.volume_id == v.id
        ]
        vol_payload.append({
            "id": v.id,
            "novelId": v.novel_id,
            "title": v.title,
            "summary": v.summary,
            "order": v.order,
            "chapters": vol_chapters,
        })
    orphan = [
        {
            "id": c.id,
            "novelId": c.novel_id,
            "volumeId": c.volume_id,
            "title": c.title,
            "content": c.content,
            "outline": c.outline,
            "wordCount": c.word_count,
            "order": c.order,
            "status": c.status,
        }
        for c in chapters
        if not c.volume_id
    ]
    if orphan:
        vol_payload.append({
            "id": "",
            "novelId": novel_id,
            "title": "未分卷",
            "summary": "",
            "order": 9999,
            "chapters": orphan,
        })
    base["volumes"] = vol_payload
    base["chapters"] = [
        {
            "id": c.id,
            "novelId": c.novel_id,
            "volumeId": c.volume_id,
            "title": c.title,
            "content": c.content,
            "outline": c.outline,
            "wordCount": c.word_count,
            "order": c.order,
            "status": c.status,
        }
        for c in chapters
    ]
    base["characters"] = [
        {
            "id": ch.id,
            "novelId": ch.novel_id,
            "name": ch.name,
            "role": ch.role,
            "personality": ch.personality,
            "abilities": ch.abilities,
            "currentState": ch.current_state,
            "relationships": ch.relationships,
            "appearance": ch.appearance,
            "background": ch.background,
        }
        for ch in characters
    ]
    return base


@router.patch("/{novel_id}", response_model=NovelResponse)
def update_novel(
    novel_id: str,
    req: UpdateNovelRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    for key, val in req.model_dump(exclude_unset=True).items():
        if key == "world_settings" and val is not None:
            setattr(novel, key, val.model_dump() if hasattr(val, "model_dump") else val)
        else:
            setattr(novel, key, val)
    db.commit()
    db.refresh(novel)
    return novel


@router.delete("/{novel_id}")
def delete_novel(
    novel_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    db.delete(novel)
    db.commit()
    return {"ok": True}


@router.post("/suggestions/titles")
async def suggest_titles(
    req: SuggestTitlesRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    try:
        result = await orch.Author.suggest_titles(config, req.background, req.genre, req.count)
        return {"titles": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI调用失败: {str(e)}")


@router.post("/suggestions/expand-background")
async def expand_background(
    req: ExpandBackgroundRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    try:
        result = await orch.Author.expand_background(config, req.title, req.background, req.genre)
        return {"background": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI调用失败: {str(e)}")


@router.post("/import", response_model=NovelResponse)
def import_novel(
    req: ImportNovelRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = Novel(
        id=new_id(),
        user_id=current_user.id,
        title=req.title,
        background="",
    )
    db.add(novel)
    db.flush()
    # Create first chapter with imported content
    chapter = Chapter(
        id=new_id(),
        novel_id=novel.id,
        title="第一章",
        content=req.content,
        order=0,
    )
    db.add(chapter)
    db.commit()
    db.refresh(novel)
    return novel


@router.patch("/{novel_id}/cover")
async def update_cover(
    novel_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="请上传图片文件")
    ext = os.path.splitext(file.filename or "")[1].lower() or ".jpg"
    if ext not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
        ext = ".jpg"
    cover_dir = os.path.join(settings.upload_dir, "covers")
    os.makedirs(cover_dir, exist_ok=True)
    filename = f"{novel_id}{ext}"
    path = os.path.join(cover_dir, filename)
    content = await file.read()
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="封面文件不能超过 10MB")
    with open(path, "wb") as f:
        f.write(content)
    novel.cover = f"/uploads/covers/{filename}"
    db.commit()
    return {"ok": True, "cover": novel.cover}


@router.patch("/{novel_id}/outline")
def update_outline(
    novel_id: str,
    body: dict,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    if "outline" in body:
        novel.outline = body["outline"]
    db.commit()
    return {"ok": True}


@router.post("/{novel_id}/condense-outline")
async def condense_outline(
    novel_id: str,
    req: CondenseOutlineRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    try:
        result = await orch.Outline.condense_outline(config, req.outline)
        return {"outline": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI调用失败: {str(e)}")


@router.get("/{novel_id}/export")
def export_novel(
    novel_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    chapters = db.query(Chapter).filter(Chapter.novel_id == novel_id).order_by(Chapter.order).all()
    content = f"# {novel.title}\n\n"
    for ch in chapters:
        content += f"## {ch.title}\n\n{ch.content}\n\n"
    return {"title": novel.title, "content": content}


@router.post("/{novel_id}/extract-style")
async def extract_style(
    novel_id: str,
    req: ExtractStyleRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    text = req.content or req.sample_text or ""
    try:
        result = await orch.Author.extract_style(config, text)
        return {"style": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"AI调用失败: {str(e)}")


@router.get("/{novel_id}/generate/outline/stream")
async def generate_outline_stream(
    novel_id: str,
    mode: str = Query("initial"),
    existingOutline: str = Query(""),
    token: str = Query(""),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # `token` query kept for EventSource clients that cannot set Authorization header.
    _ = token
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")

    if mode == "continue" and existingOutline:
        user_prompt = f"书名：{novel.title}\n背景：{novel.background}\n类型：{', '.join(novel.genre) if novel.genre else '未指定'}\n风格：{', '.join(novel.style) if novel.style else '未指定'}\n\n现有大纲：\n{existingOutline}\n\n请续写上述大纲。"
    else:
        user_prompt = f"书名：{novel.title}\n背景：{novel.background}\n类型：{', '.join(novel.genre) if novel.genre else '未指定'}\n风格：{', '.join(novel.style) if novel.style else '未指定'}"

    async def event_stream():
        try:
            async for chunk in ai.chat_stream(config, [
                {"role": "system", "content": "你是一位专业的小说结构设计师，请生成完整的小说大纲。"},
                {"role": "user", "content": user_prompt},
            ]):
                if chunk.type == "reasoning":
                    yield f"event: reasoning\ndata: {json.dumps({'type': 'reasoning', 'content': chunk.content}, ensure_ascii=False)}\n\n"
                elif chunk.type == "content":
                    yield f"data: {json.dumps({'type': 'chunk', 'content': chunk.content}, ensure_ascii=False)}\n\n"
                elif chunk.type == "error":
                    yield f"data: {json.dumps({'type': 'error', 'error': chunk.content, 'message': chunk.content}, ensure_ascii=False)}\n\n"
                    return
                elif chunk.type == "done":
                    break
            yield f"data: {json.dumps({'type': 'done'}, ensure_ascii=False)}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'type': 'error', 'error': str(e), 'message': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
