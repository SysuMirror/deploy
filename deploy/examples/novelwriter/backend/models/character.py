from sqlalchemy import Column, String, Integer, Text, ForeignKey, JSON
from sqlalchemy.orm import relationship
from database import Base
from .base import new_id, TimestampMixin


class Character(Base, TimestampMixin):
    __tablename__ = "characters"

    id = Column(String(36), primary_key=True, default=new_id)
    novel_id = Column(String(36), ForeignKey("novels.id"), index=True, nullable=False)
    name = Column(String(100), nullable=False)
    role = Column(String(50), nullable=False, default="配角")
    personality = Column(JSON, nullable=False, default=list)
    abilities = Column(JSON, nullable=False, default=list)
    current_state = Column(Text, nullable=False, default="")
    relationships = Column(JSON, nullable=False, default=list)
    appearance = Column(Text, nullable=False, default="")
    background = Column(Text, nullable=False, default="")

    novel = relationship("Novel", back_populates="characters")


class PlotThread(Base, TimestampMixin):
    __tablename__ = "plot_threads"

    id = Column(String(36), primary_key=True, default=new_id)
    novel_id = Column(String(36), ForeignKey("novels.id"), index=True, nullable=False)
    title = Column(String(255), nullable=False)
    content = Column(Text, nullable=False, default="")
    status = Column(String(20), nullable=False, default="open")
    chapter_id = Column(String(36), nullable=False, default="")

    novel = relationship("Novel", back_populates="plot_threads")


class TimelineEvent(Base, TimestampMixin):
    __tablename__ = "timeline_events"

    id = Column(String(36), primary_key=True, default=new_id)
    novel_id = Column(String(36), ForeignKey("novels.id"), index=True, nullable=False)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=False, default="")
    time_label = Column(String(255), nullable=False, default="")
    order = Column(Integer, nullable=False, default=0)
    chapter_id = Column(String(36), nullable=False, default="")

    novel = relationship("Novel", back_populates="timeline_events")
