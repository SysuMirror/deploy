import uuid
from datetime import datetime, timezone
from sqlalchemy import Column, String, DateTime
from database import Base


def new_id() -> str:
    return uuid.uuid4().hex


class TimestampMixin:
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc),
                        onupdate=lambda: datetime.now(timezone.utc), nullable=False)
