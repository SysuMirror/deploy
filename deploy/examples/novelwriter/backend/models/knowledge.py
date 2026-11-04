from datetime import datetime, timezone
from sqlalchemy import Column, String, Text, ForeignKey, DateTime
from sqlalchemy.orm import relationship
from database import Base
from .base import new_id, TimestampMixin

_utcnow = lambda: datetime.now(timezone.utc)


class KnowledgeBase(Base, TimestampMixin):
    __tablename__ = "knowledge_bases"

    id = Column(String(36), primary_key=True, default=new_id)
    novel_id = Column(String(36), ForeignKey("novels.id"), index=True, nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=False, default="")
    type = Column(String(50), nullable=False, default="general")

    novel = relationship("Novel", back_populates="knowledge_bases")
    documents = relationship("KnowledgeDocument", back_populates="knowledge_base")


class KnowledgeDocument(Base):
    __tablename__ = "knowledge_documents"

    id = Column(String(36), primary_key=True, default=new_id)
    knowledge_base_id = Column(String(36), ForeignKey("knowledge_bases.id"), index=True, nullable=False)
    title = Column(String(255), nullable=False)
    content = Column(Text, nullable=False, default="")
    file_type = Column(String(20), nullable=False, default="txt")
    file_path = Column(String(500), nullable=False, default="")
    created_at = Column(DateTime, nullable=False, default=_utcnow)

    knowledge_base = relationship("KnowledgeBase", back_populates="documents")
