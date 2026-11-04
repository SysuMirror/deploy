"""AI chat router — single streaming endpoint.

POST /api/ai/stream
  Body: { message, sessionId?, novelId? }
  Response: SSE stream (meta, reasoning, content, tool_call, tool_result, question, done, error)

Session = conversation. Memory is persisted in agent_messages table.
Every request loads full history to maintain context.
"""

import json, logging, re
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from database import get_db
from middleware.auth import get_current_user
from models import User, AgentSession, AgentMessage
from services.ai_service import AIService
from services.agent.agent import ToolCallingAgent
from utils.helpers import new_id

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ai", tags=["ai"])


def _sse(event: str | None, data: dict) -> str:
    prefix = f"event: {event}\n" if event else ""
    return prefix + f"data: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/stream")
async def chat_stream(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    body = await request.json()
    message = (body.get("message", "") or "").strip()
    session_id = body.get("sessionId", "") or body.get("sid", "")
    novel_id = body.get("novelId", "")

    if not message:
        raise HTTPException(status_code=400, detail="消息不能为空")

    # ── Get or create session ────────────────────────────────────────────
    if session_id:
        session = db.query(AgentSession).filter(
            AgentSession.id == session_id,
            AgentSession.user_id == current_user.id,
        ).first()
        if not session:
            raise HTTPException(status_code=404, detail="会话不存在")
    else:
        session = AgentSession(
            id=new_id(),
            user_id=current_user.id,
            novel_id=novel_id or "",
            title="",
        )
        db.add(session)
        db.commit()
        session_id = session.id

    session.updated_at = datetime.now(timezone.utc)
    db.commit()

    # ── Get AI config ────────────────────────────────────────────────────
    from models import AIConfig
    config = db.query(AIConfig).filter(AIConfig.user_id == current_user.id).first()
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")

    # ── Auto-title ───────────────────────────────────────────────────────
    if not session.title or session.title in {"新对话", "对话", ""}:
        clean = re.sub(r'[，。！？；：【】\s"\']+', ' ', message).strip()
        session.title = (clean[:30] + '…') if len(clean) > 30 else clean
        db.commit()

    # ── Resolve novel ────────────────────────────────────────────────────
    novel = None
    nid = novel_id or session.novel_id
    if nid and db:
        from models import Novel
        novel = db.query(Novel).filter(Novel.id == nid).first()

    # ── Stream ───────────────────────────────────────────────────────────
    ai = AIService()

    async def event_stream():
        try:
            yield _sse("meta", {"sessionId": session_id, "title": session.title})

            agent = ToolCallingAgent(ai)
            async for chunk in agent.run(
                config=config,
                message=message,
                db=db,
                user_id=current_user.id,
                session_id=session_id,
                novel=novel,
            ):
                if chunk.type == "content":
                    if chunk.metadata:
                        key = None
                        if "tool_call" in chunk.metadata:
                            key = "tool_call"
                        elif "tool_result" in chunk.metadata:
                            key = "tool_result"
                        elif "question" in chunk.metadata:
                            key = "question"
                        elif "action" in chunk.metadata:
                            key = "action"
                        if key:
                            yield _sse(key, chunk.metadata[key])
                        if chunk.content:
                            yield _sse(None, {"content": chunk.content})
                    else:
                        yield _sse(None, {"content": chunk.content})
                elif chunk.type == "reasoning":
                    yield _sse("reasoning", {"content": chunk.content})
                elif chunk.type == "error":
                    yield _sse("error", {"message": chunk.content})
                    return
                elif chunk.type == "done":
                    yield _sse("done", dict(sessionId=session_id, **chunk.metadata))
                    return

        except Exception as e:
            logger.error(f"[AI] stream error: {e}")
            yield _sse("error", {"message": str(e)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── Session management ────────────────────────────────────────────────────────

@router.get("/sessions")
def list_sessions(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    novel_id: str = Query(default=""),
):
    q = db.query(AgentSession).filter(AgentSession.user_id == current_user.id)
    if novel_id:
        q = q.filter(AgentSession.novel_id == novel_id)
    return q.order_by(AgentSession.updated_at.desc()).all()


@router.delete("/sessions/{session_id}")
def delete_session(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.query(AgentSession).filter(
        AgentSession.id == session_id,
        AgentSession.user_id == current_user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    # Delete messages first, then session
    db.query(AgentMessage).filter(AgentMessage.session_id == session_id).delete()
    db.delete(session)
    db.commit()
    return {"ok": True}


@router.get("/sessions/{session_id}/history")
def get_history(
    session_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    session = db.query(AgentSession).filter(
        AgentSession.id == session_id,
        AgentSession.user_id == current_user.id,
    ).first()
    if not session:
        raise HTTPException(status_code=404, detail="会话不存在")
    messages = (
        db.query(AgentMessage)
        .filter(AgentMessage.session_id == session_id)
        .order_by(AgentMessage.created_at)
        .all()
    )
    return {"session": session, "messages": messages}
