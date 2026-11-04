from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from schemas import TaskResponse
from middleware.auth import get_current_user
from models import User, Task, Novel, Volume, Chapter
from services.ai_service import AIService
from services.agent import Orchestrator
from services.task_service import update_task, notify_task, create_task
from utils.helpers import new_id

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.get("/{task_id}", response_model=TaskResponse)
def get_task(
    task_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = db.query(Task).filter(Task.id == task_id, Task.user_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task


@router.post("/{task_id}/cancel")
async def cancel_task(
    task_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    task = db.query(Task).filter(Task.id == task_id, Task.user_id == current_user.id).first()
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    if task.status not in ("running", "queued"):
        raise HTTPException(status_code=400, detail=f"任务当前状态为 {task.status}，无法取消")
    update_task(db, task, status="cancelled", message="用户已取消", progress=task.progress)
    await notify_task(task, "task:cancelled")
    return {"ok": True, "id": task.id, "status": "cancelled"}


@router.post("/{task_id}/retry")
async def retry_task(
    task_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retry a failed/cancelled generation task by re-running the same type when possible."""
    old = db.query(Task).filter(Task.id == task_id, Task.user_id == current_user.id).first()
    if not old:
        raise HTTPException(status_code=404, detail="任务不存在")
    if old.status not in ("failed", "cancelled"):
        raise HTTPException(status_code=400, detail="仅失败或已取消的任务可重试")
    if not old.novel_id:
        raise HTTPException(status_code=400, detail="任务缺少小说上下文，无法重试")

    novel = db.query(Novel).filter(Novel.id == old.novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")

    ai = AIService()
    orch = Orchestrator(ai)
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")

    task = create_task(
        db, user_id=current_user.id, novel_id=old.novel_id,
        task_type=old.type, message=f"重试：{old.type}",
    )
    try:
        if old.type == "generate_volumes":
            planned = await orch.Outline.generate_volumes(
                config, novel.title, novel.background, novel.outline or "", 5,
            )
            saved = []
            for v in planned:
                vol = Volume(
                    id=new_id(), novel_id=novel.id,
                    title=v["title"], summary=v.get("summary", ""), order=v.get("order", 0),
                )
                db.add(vol)
                saved.append(vol)
            db.commit()
            result = {"volumes": [{"id": v.id, "title": v.title} for v in saved]}
        elif old.type == "generate_chapters":
            volume_id = (old.result or {}).get("volumeId") if isinstance(old.result, dict) else None
            vol = None
            if volume_id:
                vol = db.query(Volume).filter(Volume.id == volume_id, Volume.novel_id == novel.id).first()
            if not vol:
                vol = db.query(Volume).filter(Volume.novel_id == novel.id).order_by(Volume.order).first()
            if not vol:
                raise HTTPException(status_code=400, detail="没有可重试的分卷")
            planned = await orch.Outline.generate_chapters(
                config, novel.title, vol.title, novel.outline or vol.summary or "", 10,
            )
            saved = []
            for c in planned:
                ch = Chapter(
                    id=new_id(), novel_id=novel.id, volume_id=vol.id,
                    title=c["title"], outline=c.get("outline", ""),
                    order=c.get("order", 0), status="draft",
                )
                db.add(ch)
                saved.append(ch)
            db.commit()
            result = {"volumeId": vol.id, "chapters": [{"id": c.id, "title": c.title} for c in saved]}
        else:
            raise HTTPException(status_code=400, detail=f"任务类型 {old.type} 暂不支持自动重试")

        update_task(db, task, status="completed", progress=100, message="重试完成", result=result)
        await notify_task(task, "task:completed")
        return {"id": task.id, "status": "completed", "result": result, "retriedFrom": old.id}
    except HTTPException:
        update_task(db, task, status="failed", message="重试失败", error="请求错误")
        raise
    except Exception as e:
        update_task(db, task, status="failed", message="重试失败", error=str(e))
        await notify_task(task, "task:failed")
        raise HTTPException(status_code=500, detail=f"重试失败: {e}")
