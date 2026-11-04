from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from schemas import CreateAIConfigRequest, UpdateAIConfigRequest, AIConfigResponse
from middleware.auth import get_current_user
from models import User, AIConfig
from utils.helpers import new_id

router = APIRouter(prefix="/api/ai-config", tags=["ai_config"])


@router.get("", response_model=list[AIConfigResponse])
def list_configs(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(AIConfig).filter(AIConfig.user_id == current_user.id).all()


@router.post("", response_model=AIConfigResponse)
def create_config(
    req: CreateAIConfigRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    cfg = AIConfig(
        id=new_id(),
        user_id=current_user.id,
        provider=req.provider,
        model=req.model,
        api_key=req.api_key,
        base_url=req.base_url,
        parameters=req.parameters,
        purpose=req.purpose,
    )
    db.add(cfg)
    db.commit()
    db.refresh(cfg)
    return cfg


@router.patch("/{config_id}", response_model=AIConfigResponse)
def update_config(
    config_id: str,
    req: UpdateAIConfigRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    cfg = db.query(AIConfig).filter(AIConfig.id == config_id, AIConfig.user_id == current_user.id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="AI配置不存在")
    for key, val in req.model_dump(exclude_unset=True).items():
        setattr(cfg, key, val)
    db.commit()
    db.refresh(cfg)
    return cfg


@router.delete("/{config_id}")
def delete_config(
    config_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    cfg = db.query(AIConfig).filter(AIConfig.id == config_id, AIConfig.user_id == current_user.id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="AI配置不存在")
    db.delete(cfg)
    db.commit()
    return {"ok": True}


@router.post("/{config_id}/set-default", response_model=AIConfigResponse)
def set_default(
    config_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    # Unset all defaults
    db.query(AIConfig).filter(AIConfig.user_id == current_user.id, AIConfig.is_default == True).update({"is_default": False})
    cfg = db.query(AIConfig).filter(AIConfig.id == config_id, AIConfig.user_id == current_user.id).first()
    if not cfg:
        raise HTTPException(status_code=404, detail="AI配置不存在")
    cfg.is_default = True
    db.commit()
    db.refresh(cfg)
    return cfg
