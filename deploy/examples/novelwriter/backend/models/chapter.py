from datetime import datetime, timezone
from sqlalchemy import Column, String, Integer, Text, ForeignKey, DateTime
from sqlalchemy.orm import relationship
from database import Base
from .base import new_id, TimestampMixin

_utcnow = lambda: datetime.now(timezone.utc)


class Volume(Base, TimestampMixin):
    __tablename__ = "volumes"

    id = Column(String(36), primary_key=True, default=new_id)
    novel_id = Column(String(36), ForeignKey("novels.id"), index=True, nullable=False)
    title = Column(String(255), nullable=False)
    summary = Column(Text, nullable=False, default="")
    order = Column(Integer, nullable=False, default=0)

    novel = relationship("Novel", back_populates="volumes")
    chapters = relationship("Chapter", back_populates="volume")


class Chapter(Base, TimestampMixin):
    __tablename__ = "chapters"

    id = Column(String(36), primary_key=True, default=new_id)
    novel_id = Column(String(36), ForeignKey("novels.id"), index=True, nullable=False)
    volume_id = Column(String(36), ForeignKey("volumes.id"), index=True, nullable=True)
    title = Column(String(500), nullable=False, default="")
    content = Column(Text, nullable=False, default="")
    outline = Column(Text, nullable=False, default="")
    word_count = Column(Integer, nullable=False, default=0)
    order = Column(Integer, nullable=False, default=0)
    status = Column(String(20), nullable=False, default="draft")

    novel = relationship("Novel", back_populates="chapters")
    volume = relationship("Volume", back_populates="chapters")
    snapshots = relationship("ChapterSnapshot", back_populates="chapter")


class ChapterSnapshot(Base):
    __tablename__ = "chapter_snapshots"

    id = Column(String(36), primary_key=True, default=new_id)
    chapter_id = Column(String(36), ForeignKey("chapters.id"), index=True, nullable=False)
    title = Column(String(500), nullable=False, default="")
    content = Column(Text, nullable=False, default="")
    label = Column(String(255), nullable=False, default="")
    word_count = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=_utcnow)

    chapter = relationship("Chapter", back_populates="snapshots")
