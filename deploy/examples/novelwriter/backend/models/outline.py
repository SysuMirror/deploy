from datetime import datetime, timezone
from sqlalchemy import Column, String, Integer, Boolean, Text, ForeignKey, JSON, DateTime
from sqlalchemy.orm import relationship
from database import Base
from .base import new_id, TimestampMixin

_utcnow = lambda: datetime.now(timezone.utc)


class OutlineVersion(Base):
    __tablename__ = "outline_versions"

    id = Column(String(36), primary_key=True, default=new_id)
    novel_id = Column(String(36), ForeignKey("novels.id"), index=True, nullable=False)
    content = Column(Text, nullable=False, default="")
    context = Column(JSON, nullable=True)
    mode = Column(String(20), nullable=False, default="manual")
    is_locked = Column(Boolean, nullable=False, default=False)
    version = Column(Integer, nullable=False, default=1)
    created_at = Column(DateTime, nullable=False, default=_utcnow)

    novel = relationship("Novel", back_populates="outline_versions")


class WritingStyleRule(Base, TimestampMixin):
    __tablename__ = "writing_style_rules"

    id = Column(String(36), primary_key=True, default=new_id)
    novel_id = Column(String(36), ForeignKey("novels.id"), unique=True, nullable=False)
    rules = Column(Text, nullable=False, default="")
