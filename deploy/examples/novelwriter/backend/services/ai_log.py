"""Central AI interaction log service.

Every AI call flows through this service for:
- Database audit logging (AILog table)
- WebSocket real-time broadcast to frontend AiLogPanel
"""

import json
import logging
from datetime import datetime, timezone
from sqlalchemy.orm import Session
from models import AILog
from utils.helpers import new_id
from websocket.manager import manager

logger = logging.getLogger(__name__)

_utcnow = lambda: datetime.now(timezone.utc)


class AILogService:
    """Per-request AI log service tied to a user and DB session."""

    def __init__(self, db: Session, user_id: str):
        self.db = db
        self.user_id = user_id

    async def log_start(
        self,
        interaction_id: str,
        task_id: str,
        novel_id: str,
        provider: str,
        model: str,
        prompt: str,
        session_id: str = "",
    ) -> None:
        """Write a 'running' AILog entry and broadcast via WebSocket."""
        entry = AILog(
            id=new_id(),
            task_id=task_id,
            novel_id=novel_id or "",
            interaction_id=interaction_id,
            type="llm",
            status="running",
            provider=provider,
            model=model,
            prompt=prompt[:2000] if prompt else "",
        )
        self.db.add(entry)
        self.db.commit()

        await manager.send_to_user(self.user_id, {
            "event": "ai_log:status",
            "data": {
                "interactionId": interaction_id,
                "taskId": task_id,
                "sessionId": session_id,
                "status": "running",
                "provider": provider,
                "model": model,
                "timestamp": _utcnow().isoformat(),
            },
        })

    async def log_chunk(self, interaction_id: str, task_id: str, chunk_type: str, content: str) -> None:
        """Broadcast a streaming chunk to the frontend via WebSocket."""
        try:
            await manager.send_to_user(self.user_id, {
                "event": "ai_log:chunk",
                "data": {
                    "interactionId": interaction_id,
                    "taskId": task_id,
                    "type": chunk_type,
                    "chunk": content,
                },
            })
        except Exception:
            pass  # WS delivery is best-effort; don't break the stream

    async def log_complete(
        self,
        interaction_id: str,
        task_id: str,
        full_response: str,
        status: str = "completed",
        error: str = "",
    ) -> None:
        """Update AILog entry to completed/failed and broadcast status."""
        entry = self.db.query(AILog).filter(AILog.interaction_id == interaction_id).first()
        if entry:
            entry.status = status
            entry.response = full_response[:10000] if full_response else ""
            entry.error = error[:2000] if error else ""
            self.db.commit()

        try:
            await manager.send_to_user(self.user_id, {
                "event": "ai_log:status",
                "data": {
                    "interactionId": interaction_id,
                    "taskId": task_id,
                    "status": status,
                    "error": error,
                    "responseLength": len(full_response) if full_response else 0,
                },
            })
        except Exception:
            pass

    @staticmethod
    def get_history(db: Session, user_id: str, novel_id: str = "", limit: int = 50):
        """Query historical AI log entries for a user, newest first."""
        q = db.query(AILog).filter(AILog.id.isnot(None))
        if novel_id:
            q = q.filter(AILog.novel_id == novel_id)
        return q.order_by(AILog.created_at.desc()).limit(limit).all()
