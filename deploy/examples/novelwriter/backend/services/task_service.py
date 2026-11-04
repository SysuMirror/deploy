"""Lightweight task lifecycle helpers (sync generation + cancel/retry markers)."""
from __future__ import annotations

from datetime import datetime, timezone
from sqlalchemy.orm import Session

from models import Task
from utils.helpers import new_id
from websocket.manager import manager


def _utcnow():
    return datetime.now(timezone.utc)


def create_task(
    db: Session,
    *,
    user_id: str,
    novel_id: str | None,
    task_type: str,
    message: str = "任务进行中",
) -> Task:
    task = Task(
        id=new_id(),
        user_id=user_id,
        novel_id=novel_id,
        type=task_type,
        status="running",
        progress=0,
        message=message,
        result=None,
        error="",
        created_at=_utcnow(),
        updated_at=_utcnow(),
    )
    db.add(task)
    db.commit()
    db.refresh(task)
    return task


def update_task(
    db: Session,
    task: Task,
    *,
    status: str | None = None,
    progress: int | None = None,
    message: str | None = None,
    result: dict | None = None,
    error: str | None = None,
) -> Task:
    if status is not None:
        task.status = status
    if progress is not None:
        task.progress = progress
    if message is not None:
        task.message = message
    if result is not None:
        task.result = result
    if error is not None:
        task.error = error
    task.updated_at = _utcnow()
    db.commit()
    db.refresh(task)
    return task


async def notify_task(task: Task, event_type: str = "task:updated"):
    await manager.notify_task(
        task.id,
        {
            "type": event_type,
            "taskId": task.id,
            "status": task.status,
            "progress": task.progress,
            "message": task.message,
            "error": task.error,
            "result": task.result,
        },
    )
    if task.status == "completed":
        await manager.notify_task(
            task.id,
            {"type": "task:completed", "taskId": task.id, "result": task.result},
        )
    elif task.status == "failed":
        await manager.notify_task(
            task.id,
            {"type": "task:failed", "taskId": task.id, "error": task.error},
        )
    elif task.status == "cancelled":
        await manager.notify_task(
            task.id,
            {"type": "task:cancelled", "taskId": task.id},
        )
