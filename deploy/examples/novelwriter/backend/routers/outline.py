from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from schemas import SaveOutlineVersionRequest, OutlineVersionResponse
from middleware.auth import get_current_user
from models import User, Novel, OutlineVersion
from utils.helpers import new_id

router = APIRouter(prefix="/api/novels", tags=["outline"])


@router.get("/{novel_id}/outline/versions", response_model=list[OutlineVersionResponse])
def list_versions(
    novel_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(OutlineVersion).filter(OutlineVersion.novel_id == novel_id).order_by(OutlineVersion.version.desc()).all()


@router.post("/{novel_id}/outline/versions", response_model=OutlineVersionResponse)
def save_version(
    novel_id: str,
    req: SaveOutlineVersionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    max_ver = db.query(OutlineVersion).filter(OutlineVersion.novel_id == novel_id).order_by(OutlineVersion.version.desc()).first()
    version = OutlineVersion(
        id=new_id(),
        novel_id=novel_id,
        content=req.content,
        context=req.context,
        mode=req.mode,
        version=(max_ver.version + 1) if max_ver else 1,
    )
    db.add(version)
    db.commit()
    db.refresh(version)
    return version


@router.patch("/{novel_id}/outline/versions/{version_id}/lock")
def lock_version(
    novel_id: str,
    version_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    version = db.query(OutlineVersion).filter(OutlineVersion.id == version_id, OutlineVersion.novel_id == novel_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="大纲版本不存在")
    version.is_locked = True
    db.commit()
    return {"ok": True}


@router.post("/{novel_id}/outline/versions/{version_id}/rollback")
def rollback(
    novel_id: str,
    version_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    version = db.query(OutlineVersion).filter(OutlineVersion.id == version_id, OutlineVersion.novel_id == novel_id).first()
    if not version:
        raise HTTPException(status_code=404, detail="大纲版本不存在")
    novel = db.query(Novel).filter(Novel.id == novel_id).first()
    novel.outline = version.content
    db.commit()
    return {"outline": version.content}
