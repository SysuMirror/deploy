import os
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    port: int = 8002
    db_path: str = "novelwriter.db"
    jwt_secret: str = "novelwriter-secret-key-change-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_hours: int = 72
    upload_dir: str = "uploads"
    cors_origin: str = "*"

    class Config:
        env_prefix = ""
        env_file = ".env"
        extra = "ignore"


settings = Settings()
os.makedirs(settings.upload_dir, exist_ok=True)
for sub in ("covers", "knowledge"):
    os.makedirs(os.path.join(settings.upload_dir, sub), exist_ok=True)
