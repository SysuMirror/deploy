from sqlalchemy.orm import Session
from passlib.context import CryptContext
from models import User
from utils import create_token
from utils.helpers import new_id

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _normalize_password(password: str) -> str:
    """bcrypt 最多 72 字节，避免 hash/verify 抛异常导致 500。"""
    raw = (password or "").encode("utf-8")[:72]
    return raw.decode("utf-8", errors="ignore") or (password or "")[:72]


class AuthService:
    def __init__(self, db: Session):
        self.db = db

    def register(self, email: str, password: str, name: str) -> tuple[User, str]:
        existing = self.db.query(User).filter(User.email == email).first()
        if existing:
            raise ValueError("邮箱已被注册")

        user = User(
            id=new_id(),
            email=email,
            password=pwd_context.hash(_normalize_password(password)),
            name=name or "",
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)

        token = create_token(user.id, user.email)
        return user, token

    def login(self, email: str, password: str) -> tuple[User, str]:
        user = self.db.query(User).filter(User.email == email).first()
        if not user or not pwd_context.verify(_normalize_password(password), user.password):
            raise ValueError("邮箱或密码错误")

        token = create_token(user.id, user.email)
        return user, token

    def get_user(self, user_id: str) -> User | None:
        return self.db.query(User).filter(User.id == user_id).first()

    def update_user(self, user_id: str, name: str | None, email: str | None) -> User:
        user = self.db.query(User).filter(User.id == user_id).first()
        if not user:
            raise ValueError("用户不存在")

        if name is not None:
            user.name = name
        if email is not None and email != user.email:
            existing = self.db.query(User).filter(User.email == email, User.id != user_id).first()
            if existing:
                raise ValueError("邮箱已被使用")
            user.email = email

        self.db.commit()
        self.db.refresh(user)
        return user
