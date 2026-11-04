from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from schemas import CreatePlotThreadRequest, UpdatePlotThreadRequest, PlotThreadResponse
from middleware.auth import get_current_user
from models import User, PlotThread
from utils.helpers import new_id

router = APIRouter(prefix="/api/novels", tags=["plot_threads"])


@router.get("/{novel_id}/threads", response_model=list[PlotThreadResponse])
def list_threads(
    novel_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(PlotThread).filter(PlotThread.novel_id == novel_id).order_by(PlotThread.updated_at.desc()).all()


@router.post("/{novel_id}/threads", response_model=PlotThreadResponse)
def create_thread(
    novel_id: str,
    req: CreatePlotThreadRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = PlotThread(id=new_id(), novel_id=novel_id, **req.model_dump())
    db.add(thread)
    db.commit()
    db.refresh(thread)
    return thread


@router.patch("/{novel_id}/threads/{thread_id}", response_model=PlotThreadResponse)
def update_thread(
    novel_id: str,
    thread_id: str,
    req: UpdatePlotThreadRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = db.query(PlotThread).filter(PlotThread.id == thread_id, PlotThread.novel_id == novel_id).first()
    if not thread:
        raise HTTPException(status_code=404, detail="情节线不存在")
    for key, val in req.model_dump(exclude_unset=True).items():
        setattr(thread, key, val)
    db.commit()
    db.refresh(thread)
    return thread


@router.delete("/{novel_id}/threads/{thread_id}")
def delete_thread(
    novel_id: str,
    thread_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    thread = db.query(PlotThread).filter(PlotThread.id == thread_id, PlotThread.novel_id == novel_id).first()
    if not thread:
        raise HTTPException(status_code=404, detail="情节线不存在")
    db.delete(thread)
    db.commit()
    return {"ok": True}
