import json
import logging
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from database import get_db
from schemas import (
    CreateAgentSessionRequest, AgentProcessRequest, AgentConfirmRequest,
    AgentSessionResponse, AgentMessageResponse,
)
from middleware.auth import get_current_user
from models import User, Novel, AgentSession, AgentMessage
from services.ai_service import AIService
from services.agent import Orchestrator
from utils.helpers import new_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/agent", tags=["agent"])


def _get_ai_and_orch():
    ai = AIService()
    orch = Orchestrator(ai)
    return ai, orch


@router.post("/session", response_model=AgentSessionResponse)
def create_session(
    req: CreateAgentSessionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = AgentSession(
        id=new_id(),
        user_id=current_user.id,
        novel_id=req.novel_id,
        title=req.title or "新对话",
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


@router.get("/skills")
def get_skills():
    return {"skills": Orchestrator.get_skills()}


@router.get("/conversations")
def get_conversations(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(AgentSession).filter(
        AgentSession.user_id == current_user.id
    ).order_by(AgentSession.updated_at.desc()).all()


@router.get("/sessions")
def list_sessions(
    novelId: str = "",
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = db.query(AgentSession).filter(AgentSession.user_id == current_user.id)
    if novelId:
        q = q.filter(AgentSession.novel_id == novelId)
    return q.order_by(AgentSession.updated_at.desc()).all()


@router.get("/session/{session_id}/messages", response_model=list[AgentMessageResponse])
def get_messages(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.query(AgentSession).filter(AgentSession.id == session_id, AgentSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    return db.query(AgentMessage).filter(AgentMessage.session_id == session_id).order_by(AgentMessage.created_at).all()


@router.post("/session/{session_id}/process")
async def process(
    session_id: str,
    req: AgentProcessRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.query(AgentSession).filter(AgentSession.id == session_id, AgentSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")

    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")

    novel = None
    if session.novel_id:
        novel = db.query(Novel).filter(Novel.id == session.novel_id).first()

    message = req.user_input or req.message or ""
    result = await orch.process(db, session, message, current_user.id, config, novel)
    return result


@router.post("/session/{session_id}/process/stream")
async def process_stream(
    session_id: str,
    req: AgentProcessRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.query(AgentSession).filter(AgentSession.id == session_id, AgentSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")

    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")

    novel = None
    if session.novel_id:
        novel = db.query(Novel).filter(Novel.id == session.novel_id).first()

    message = req.user_input or req.message or ""

    async def event_stream():
        async for chunk in orch.process_stream(db, session, message, current_user.id, config, novel):
            if chunk.type == "content" and chunk.content.startswith("__META__"):
                meta_json = chunk.content.replace("__META__", "").replace("__ENDMETA__", "")
                yield f"event: meta\ndata: {meta_json}\n\n"
            elif chunk.type == "reasoning":
                yield f"event: reasoning\ndata: {json.dumps({'content': chunk.content}, ensure_ascii=False)}\n\n"
            elif chunk.type == "content":
                yield f"data: {json.dumps({'content': chunk.content}, ensure_ascii=False)}\n\n"
            elif chunk.type == "error":
                yield f"event: error\ndata: {json.dumps({'message': chunk.content}, ensure_ascii=False)}\n\n"
            elif chunk.type == "done":
                break
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/session/{session_id}/confirm")
async def confirm(
    session_id: str,
    req: AgentConfirmRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.query(AgentSession).filter(AgentSession.id == session_id, AgentSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")

    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")

    plan = req.plan or {"choice": req.choice, "modifications": req.modifications or []} or (session.plan or {})
    skill_id = plan.get("skill", "chat")

    msg = AgentMessage(
        id=new_id(),
        session_id=session_id,
        role="user",
        content=f"确认执行: {json.dumps(plan, ensure_ascii=False)}",
        extra={"type": "confirm", "plan": plan},
    )
    db.add(msg)
    db.commit()

    novel = None
    if session.novel_id:
        novel = db.query(Novel).filter(Novel.id == session.novel_id).first()

    result = await orch.process(
        db, session,
        f"请执行以下计划：{json.dumps(plan, ensure_ascii=False)}",
        current_user.id, config, novel
    )
    return result


@router.post("/session/{session_id}/confirm/stream")
async def confirm_stream(
    session_id: str,
    req: AgentConfirmRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.query(AgentSession).filter(AgentSession.id == session_id, AgentSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")

    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")

    plan = req.plan or {"choice": req.choice, "modifications": req.modifications or []} or (session.plan or {})

    msg = AgentMessage(
        id=new_id(),
        session_id=session_id,
        role="user",
        content=f"确认执行: {json.dumps(plan, ensure_ascii=False)}",
        extra={"type": "confirm", "plan": plan},
    )
    db.add(msg)
    db.commit()

    novel = None
    if session.novel_id:
        novel = db.query(Novel).filter(Novel.id == session.novel_id).first()

    async def event_stream():
        try:
            async for chunk in orch.process_stream(
                db, session,
                f"请执行以下计划：{json.dumps(plan, ensure_ascii=False)}",
                current_user.id, config, novel
            ):
                if chunk.type == "content" and chunk.content.startswith("__META__"):
                    meta_json = chunk.content.replace("__META__", "").replace("__ENDMETA__", "")
                    yield f"event: meta\ndata: {meta_json}\n\n"
                elif chunk.type == "reasoning":
                    yield f"event: reasoning\ndata: {json.dumps({'content': chunk.content}, ensure_ascii=False)}\n\n"
                elif chunk.type == "content":
                    yield f"data: {json.dumps({'content': chunk.content}, ensure_ascii=False)}\n\n"
                elif chunk.type == "error":
                    yield f"event: error\ndata: {json.dumps({'message': chunk.content}, ensure_ascii=False)}\n\n"
                elif chunk.type == "done":
                    break
        except Exception as e:
            logger.error(f"confirm_stream error: {e}")
            yield f"event: error\ndata: {json.dumps({'message': str(e)}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/session/{session_id}/history")
def get_history(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    messages = db.query(AgentMessage).filter(AgentMessage.session_id == session_id).order_by(AgentMessage.created_at).all()
    return {"messages": messages}


@router.delete("/session/{session_id}")
def close_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.query(AgentSession).filter(AgentSession.id == session_id, AgentSession.user_id == current_user.id).first()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    session.status = "closed"
    db.commit()
    return {"ok": True}
