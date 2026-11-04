from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session
from database import get_db
from schemas import (
    CreateKnowledgeBaseRequest, UpdateKnowledgeBaseRequest,
    KnowledgeBaseResponse, KnowledgeDocumentResponse, KnowledgeSearchRequest,
)
from middleware.auth import get_current_user
from models import User, Novel, KnowledgeBase, KnowledgeDocument
from services.ai_service import AIService
from services.agent import Orchestrator
from utils.helpers import new_id
from config import settings
import os

router = APIRouter(prefix="/api/knowledge", tags=["knowledge"])


def _get_ai_and_orch():
    ai = AIService()
    orch = Orchestrator(ai)
    return ai, orch


@router.get("")
def list_all(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    novels = db.query(Novel).filter(Novel.user_id == current_user.id).all()
    novel_ids = [n.id for n in novels]
    bases = db.query(KnowledgeBase).filter(KnowledgeBase.novel_id.in_(novel_ids)).all()
    for kb in bases:
        doc_count = db.query(KnowledgeDocument).filter(KnowledgeDocument.knowledge_base_id == kb.id).count()
        kb.document_count = doc_count
    return bases


@router.get("/{novel_id}", response_model=list[KnowledgeBaseResponse])
def list_bases(
    novel_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(KnowledgeBase).filter(KnowledgeBase.novel_id == novel_id).all()


@router.post("/{novel_id}", response_model=KnowledgeBaseResponse)
def create_base(
    novel_id: str,
    req: CreateKnowledgeBaseRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    kb = KnowledgeBase(id=new_id(), novel_id=novel_id, **req.model_dump())
    db.add(kb)
    db.commit()
    db.refresh(kb)
    return kb


@router.patch("/{novel_id}/{kb_id}", response_model=KnowledgeBaseResponse)
def update_base(
    novel_id: str,
    kb_id: str,
    req: UpdateKnowledgeBaseRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id, KnowledgeBase.novel_id == novel_id).first()
    if not kb:
        raise HTTPException(status_code=404, detail="知识库不存在")
    for key, val in req.model_dump(exclude_unset=True).items():
        setattr(kb, key, val)
    db.commit()
    db.refresh(kb)
    return kb


@router.delete("/{novel_id}/{kb_id}")
def delete_base(
    novel_id: str,
    kb_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id, KnowledgeBase.novel_id == novel_id).first()
    if not kb:
        raise HTTPException(status_code=404, detail="知识库不存在")
    db.delete(kb)
    db.commit()
    return {"ok": True}


@router.get("/{novel_id}/{kb_id}/documents", response_model=list[KnowledgeDocumentResponse])
def list_documents(
    novel_id: str,
    kb_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    return db.query(KnowledgeDocument).filter(KnowledgeDocument.knowledge_base_id == kb_id).all()


@router.post("/{novel_id}/{kb_id}/documents")
async def upload_document(
    novel_id: str,
    kb_id: str,
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id, KnowledgeBase.novel_id == novel_id).first()
    if not kb:
        raise HTTPException(status_code=404, detail="知识库不存在")
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="上传文件为空")
    if len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="文件不能超过 20MB")
    text = content.decode("utf-8", errors="ignore")
    if not text.strip():
        raise HTTPException(status_code=400, detail="无法读取文件文本内容，请上传 UTF-8 文本")
    ext = os.path.splitext(file.filename or "file.txt")[1].lstrip(".") or "txt"
    doc = KnowledgeDocument(
        id=new_id(),
        knowledge_base_id=kb_id,
        title=file.filename or "未命名文档",
        content=text,
        file_type=ext,
        file_path="",
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return doc


@router.delete("/{novel_id}/{kb_id}/documents/{doc_id}")
def delete_document(
    novel_id: str,
    kb_id: str,
    doc_id: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    doc = db.query(KnowledgeDocument).filter(KnowledgeDocument.id == doc_id, KnowledgeDocument.knowledge_base_id == kb_id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")
    db.delete(doc)
    db.commit()
    return {"ok": True}


@router.post("/{novel_id}/{kb_id}/search")
async def search_knowledge(
    novel_id: str,
    kb_id: str,
    req: KnowledgeSearchRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        # Simple keyword search fallback
        docs = db.query(KnowledgeDocument).filter(
            KnowledgeDocument.knowledge_base_id == kb_id,
            KnowledgeDocument.content.contains(req.query),
        ).limit(req.limit or req.top_k).all()
        return {"results": [{"title": d.title, "content": d.content} for d in docs]}
    all_docs = db.query(KnowledgeDocument).filter(KnowledgeDocument.knowledge_base_id == kb_id).all()
    result = await orch.Knowledge.search_knowledge(config, req.query, [
        {"title": d.title, "content": d.content} for d in all_docs
    ])
    return {"results": result}
