from sqlalchemy import Column, String, DateTime
from database import Base
from .base import new_id, TimestampMixin


class User(Base, TimestampMixin):
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=new_id)
    email = Column(String(255), unique=True, nullable=False)
    password = Column(String(255), nullable=False)
    name = Column(String(100), nullable=False, default="")
    avatar = Column(String(500), nullable=False, default="")
