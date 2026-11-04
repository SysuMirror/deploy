from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from schemas import (
    CreateCharacterRequest, UpdateCharacterRequest, CharacterResponse,
    GenerateCharactersRequest,
)
from middleware.auth import get_current_user
from models import User, Novel, Character
from services.ai_service import AIService
from services.agent import Orchestrator
from utils.helpers import new_id

router = APIRouter(prefix="/api/novels", tags=["characters"])


def _get_ai_and_orch():
    ai = AIService()
    orch = Orchestrator(ai)
    return ai, orch


@router.get("/{novel_id}/characters", response_model=list[CharacterResponse])
def list_characters(
    novel_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(Character).filter(Character.novel_id == novel_id).order_by(Character.updated_at.desc()).all()


@router.post("/{novel_id}/characters", response_model=CharacterResponse)
def create_character(
    novel_id: str,
    req: CreateCharacterRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    char = Character(
        id=new_id(),
        novel_id=novel_id,
        name=req.name,
        role=req.role,
        personality=req.personality,
        abilities=req.abilities,
        current_state=req.current_state,
        relationships=req.relationships,
        appearance=req.appearance,
        background=req.background,
    )
    db.add(char)
    db.commit()
    db.refresh(char)
    return char


@router.post("/{novel_id}/characters/generate")
async def generate_characters(
    novel_id: str,
    req: GenerateCharactersRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novel = db.query(Novel).filter(Novel.id == novel_id, Novel.user_id == current_user.id).first()
    if not novel:
        raise HTTPException(status_code=404, detail="小说不存在")
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    result = await orch.Character.generate_characters(
        config, novel.title, novel.background, novel.genre or [], req.count
    )
    return {"characters": result}


@router.patch("/{novel_id}/characters/{character_id}", response_model=CharacterResponse)
def update_character(
    novel_id: str,
    character_id: str,
    req: UpdateCharacterRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    char = db.query(Character).filter(Character.id == character_id, Character.novel_id == novel_id).first()
    if not char:
        raise HTTPException(status_code=404, detail="角色不存在")
    for key, val in req.model_dump(exclude_unset=True).items():
        setattr(char, key, val)
    db.commit()
    db.refresh(char)
    return char


@router.delete("/{novel_id}/characters/{character_id}")
def delete_character(
    novel_id: str,
    character_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    char = db.query(Character).filter(Character.id == character_id, Character.novel_id == novel_id).first()
    if not char:
        raise HTTPException(status_code=404, detail="角色不存在")
    db.delete(char)
    db.commit()
    return {"ok": True}
