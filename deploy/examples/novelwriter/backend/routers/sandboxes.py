from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from schemas import CreateSandboxRequest, UpdateSandboxRequest, SandboxResponse
from middleware.auth import get_current_user
from models import User, Novel, Sandbox
from services.ai_service import AIService
from services.agent import Orchestrator
from utils.helpers import new_id

router = APIRouter(prefix="/api", tags=["sandboxes"])


def _get_ai_and_orch():
    ai = AIService()
    orch = Orchestrator(ai)
    return ai, orch


@router.get("/novels/{novel_id}/sandboxes", response_model=list[SandboxResponse])
def list_sandboxes(
    novel_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(Sandbox).filter(Sandbox.novel_id == novel_id).order_by(Sandbox.updated_at.desc()).all()


@router.post("/novels/{novel_id}/sandboxes", response_model=SandboxResponse)
def create_sandbox(
    novel_id: str,
    req: CreateSandboxRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sb = Sandbox(id=new_id(), novel_id=novel_id, title=req.title, premise=req.premise)
    db.add(sb)
    db.commit()
    db.refresh(sb)
    return sb


@router.patch("/sandboxes/{sandbox_id}", response_model=SandboxResponse)
def update_sandbox(
    sandbox_id: str,
    req: UpdateSandboxRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sb = db.query(Sandbox).filter(Sandbox.id == sandbox_id).first()
    if not sb:
        raise HTTPException(status_code=404, detail="沙盒不存在")
    for key, val in req.model_dump(exclude_unset=True).items():
        setattr(sb, key, val)
    db.commit()
    db.refresh(sb)
    return sb


@router.delete("/sandboxes/{sandbox_id}")
def delete_sandbox(
    sandbox_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sb = db.query(Sandbox).filter(Sandbox.id == sandbox_id).first()
    if not sb:
        raise HTTPException(status_code=404, detail="沙盒不存在")
    db.delete(sb)
    db.commit()
    return {"ok": True}


@router.post("/sandboxes/{sandbox_id}/generate")
async def generate_sandbox(
    sandbox_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sb = db.query(Sandbox).filter(Sandbox.id == sandbox_id).first()
    if not sb:
        raise HTTPException(status_code=404, detail="沙盒不存在")
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")
    result = await orch.Author.continue_writing(config, sb.title, sb.premise, "请根据前提展开创意写作")
    sb.content = result
    db.commit()
    return {"content": result}
