from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from database import get_db
from schemas import RegisterRequest, LoginRequest, UpdateUserRequest, AuthResponse, UserResponse
from services.auth_service import AuthService
from middleware.auth import get_current_user
from models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _auth_call(fn):
    try:
        return fn()
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"认证失败: {e}") from e


@router.post("/register", response_model=AuthResponse)
def register(req: RegisterRequest, db: Session = Depends(get_db)):
    svc = AuthService(db)
    user, token = _auth_call(lambda: svc.register(req.email, req.password, req.name))
    return {"user": user, "token": token}


@router.post("/login", response_model=AuthResponse)
def login(req: LoginRequest, db: Session = Depends(get_db)):
    svc = AuthService(db)
    user, token = _auth_call(lambda: svc.login(req.email, req.password))
    return {"user": user, "token": token}


@router.post("/signin", response_model=AuthResponse)
def signin(req: LoginRequest, db: Session = Depends(get_db)):
    svc = AuthService(db)
    user, token = _auth_call(lambda: svc.login(req.email, req.password))
    return {"user": user, "token": token}


@router.get("/me", response_model=UserResponse)
def me(current_user: User = Depends(get_current_user)):
    return current_user


@router.get("/get_user")
def get_user(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    svc = AuthService(db)
    user = svc.get_user(current_user.id)
    return {"user": [{"id": user.id, "email": user.email, "name": user.name, "avatar": user.avatar,
                       "createdAt": str(user.created_at), "updatedAt": str(user.updated_at)}]}


@router.post("/update_user")
def update_user(req: UpdateUserRequest, current_user: User = Depends(get_current_user),
                db: Session = Depends(get_db)):
    svc = AuthService(db)
    user = _auth_call(lambda: svc.update_user(current_user.id, req.name, req.email))
    return {"user": {"id": user.id, "email": user.email, "name": user.name, "avatar": user.avatar}}
