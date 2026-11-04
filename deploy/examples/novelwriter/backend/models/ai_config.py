from datetime import datetime, timezone
from sqlalchemy import Column, String, Integer, Boolean, Text, ForeignKey, JSON, DateTime
from sqlalchemy.orm import relationship
from database import Base
from .base import new_id, TimestampMixin

_utcnow = lambda: datetime.now(timezone.utc)


class AIConfig(Base, TimestampMixin):
    __tablename__ = "ai_configs"

    id = Column(String(36), primary_key=True, default=new_id)
    user_id = Column(String(36), ForeignKey("users.id"), index=True, nullable=False)
    provider = Column(String(50), nullable=False)
    model = Column(String(100), nullable=False)
    api_key = Column(String(500), nullable=False)
    base_url = Column(String(500), nullable=False, default="")
    parameters = Column(JSON, nullable=False, default=dict)
    is_default = Column(Boolean, nullable=False, default=False)
    purpose = Column(String(50), nullable=False, default="default")


class Task(Base):
    __tablename__ = "tasks"

    id = Column(String(36), primary_key=True, default=new_id)
    user_id = Column(String(36), ForeignKey("users.id"), index=True, nullable=True)
    novel_id = Column(String(36), ForeignKey("novels.id"), index=True, nullable=True)
    type = Column(String(50), nullable=False)
    status = Column(String(20), nullable=False, default="running")
    progress = Column(Integer, nullable=False, default=0)
    message = Column(Text, nullable=False, default="")
    result = Column(JSON, nullable=True)
    error = Column(Text, nullable=False, default="")
    created_at = Column(DateTime, nullable=False, default=_utcnow)
    updated_at = Column(DateTime, nullable=False, default=_utcnow)


class Sandbox(Base, TimestampMixin):
    __tablename__ = "sandboxes"

    id = Column(String(36), primary_key=True, default=new_id)
    novel_id = Column(String(36), ForeignKey("novels.id"), index=True, nullable=False)
    title = Column(String(255), nullable=False)
    premise = Column(Text, nullable=False, default="")
    content = Column(Text, nullable=False, default="")
    status = Column(String(20), nullable=False, default="draft")

    novel = relationship("Novel", back_populates="sandboxes")
