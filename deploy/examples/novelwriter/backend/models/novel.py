import json
from sqlalchemy import Column, String, Integer, Text, ForeignKey, JSON, DateTime
from sqlalchemy.orm import relationship
from database import Base
from .base import new_id, TimestampMixin


class Novel(Base, TimestampMixin):
    __tablename__ = "novels"

    id = Column(String(36), primary_key=True, default=new_id)
    user_id = Column(String(36), ForeignKey("users.id"), index=True, nullable=False)
    title = Column(String(255), nullable=False)
    background = Column(Text, nullable=False, default="")
    genre = Column(JSON, nullable=False, default=list)
    style = Column(JSON, nullable=False, default=list)
    target_words = Column(Integer, nullable=False, default=200000)
    min_chapter_words = Column(Integer, nullable=False, default=3000)
    world_settings = Column(JSON, nullable=True)
    writing_style_rules = Column(Text, nullable=False, default="")
    outline = Column(Text, nullable=False, default="")
    cover = Column(String(500), nullable=False, default="")

    volumes = relationship("Volume", back_populates="novel", lazy="dynamic")
    chapters = relationship("Chapter", back_populates="novel", lazy="dynamic")
    characters = relationship("Character", back_populates="novel", lazy="dynamic")
    plot_threads = relationship("PlotThread", back_populates="novel", lazy="dynamic")
    timeline_events = relationship("TimelineEvent", back_populates="novel", lazy="dynamic")
    outline_versions = relationship("OutlineVersion", back_populates="novel", lazy="dynamic")
    knowledge_bases = relationship("KnowledgeBase", back_populates="novel", lazy="dynamic")
    sandboxes = relationship("Sandbox", back_populates="novel", lazy="dynamic")
