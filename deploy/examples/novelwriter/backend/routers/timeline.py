from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from schemas import CreateTimelineEventRequest, UpdateTimelineEventRequest, TimelineEventResponse
from middleware.auth import get_current_user
from models import User, TimelineEvent
from utils.helpers import new_id

router = APIRouter(prefix="/api/novels", tags=["timeline"])


@router.get("/{novel_id}/timeline", response_model=list[TimelineEventResponse])
def list_events(
    novel_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(TimelineEvent).filter(TimelineEvent.novel_id == novel_id).order_by(TimelineEvent.order).all()


@router.post("/{novel_id}/timeline", response_model=TimelineEventResponse)
def create_event(
    novel_id: str,
    req: CreateTimelineEventRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    event = TimelineEvent(id=new_id(), novel_id=novel_id, **req.model_dump())
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


@router.patch("/{novel_id}/timeline/{event_id}", response_model=TimelineEventResponse)
def update_event(
    novel_id: str,
    event_id: str,
    req: UpdateTimelineEventRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    event = db.query(TimelineEvent).filter(TimelineEvent.id == event_id, TimelineEvent.novel_id == novel_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="时间线事件不存在")
    for key, val in req.model_dump(exclude_unset=True).items():
        setattr(event, key, val)
    db.commit()
    db.refresh(event)
    return event


@router.delete("/{novel_id}/timeline/{event_id}")
def delete_event(
    novel_id: str,
    event_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    event = db.query(TimelineEvent).filter(TimelineEvent.id == event_id, TimelineEvent.novel_id == novel_id).first()
    if not event:
        raise HTTPException(status_code=404, detail="时间线事件不存在")
    db.delete(event)
    db.commit()
    return {"ok": True}
