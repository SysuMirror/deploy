import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from config import settings
from database import init_db
from services.ai_service import AIService
from services.agent import Orchestrator
from websocket.manager import manager
from utils import verify_token

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Register pluggable skills (side-effect import)
import services.skills  # noqa: F401

ai_service = AIService()
orchestrator = Orchestrator(ai_service)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    logger.info(f"Database initialized, server starting on port {settings.port}")
    yield


app = FastAPI(title="NovelWriter API", version="1.0.0", lifespan=lifespan)


def _error_body(status: int, message: str, detail=None) -> dict:
    body = {"ok": False, "message": message, "error": message, "detail": detail if detail is not None else message}
    return body


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(_request: Request, exc: StarletteHTTPException):
    detail = exc.detail
    if isinstance(detail, list):
        message = "; ".join(
            str(item.get("msg", item)) if isinstance(item, dict) else str(item) for item in detail
        )
    else:
        message = str(detail)
    return JSONResponse(status_code=exc.status_code, content=_error_body(exc.status_code, message, detail))


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(_request: Request, exc: RequestValidationError):
    errors = exc.errors()
    parts = []
    for err in errors:
        loc = ".".join(str(x) for x in err.get("loc", []) if x != "body")
        parts.append(f"{loc}: {err.get('msg', '参数错误')}" if loc else str(err.get("msg", "参数错误")))
    message = "；".join(parts) or "请求参数无效"
    return JSONResponse(status_code=422, content=_error_body(422, message, errors))


@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception):
    logger.exception("Unhandled error: %s", exc)
    return JSONResponse(status_code=500, content=_error_body(500, f"服务器内部错误: {exc}"))


@app.middleware("http")
async def log_requests(request: Request, call_next):
    start_time = time.time()
    client_ip = request.client.host if request.client else "unknown"
    path = request.url.path
    method = request.method

    logger.info(f"[HTTP] --> {method} {path} | Client: {client_ip}")
    response = await call_next(request)

    cost = round((time.time() - start_time) * 1000, 2)
    logger.info(f"[HTTP] <-- {method} {path} | Status: {response.status_code} | Cost: {cost}ms")
    return response

_cors_origins = [
    o.strip()
    for o in (settings.cors_origin or "*").split(",")
    if o.strip()
]
if "*" in _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r".*",
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
else:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[*_cors_origins, "http://localhost:8001", "http://127.0.0.1:8001"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

app.mount("/uploads", StaticFiles(directory=settings.upload_dir), name="uploads")


@app.get("/health")
async def health():
    return {"ok": True, "service": "novelwriter-api"}

from routers.auth import router as auth_router
from routers.novels import router as novels_router
from routers.chapters import router as chapters_router
from routers.characters import router as characters_router
from routers.plot_threads import router as plot_threads_router
from routers.timeline import router as timeline_router
from routers.outline import router as outline_router
from routers.knowledge import router as knowledge_router
from routers.ai_config import router as ai_config_router
from routers.tasks import router as tasks_router
from routers.sandboxes import router as sandboxes_router
from routers.chat import router as chat_router
from routers.agent import router as agent_router
from routers.ai import router as ai_router

app.include_router(auth_router)
app.include_router(novels_router)
app.include_router(chapters_router)
app.include_router(characters_router)
app.include_router(plot_threads_router)
app.include_router(timeline_router)
app.include_router(outline_router)
app.include_router(knowledge_router)
app.include_router(ai_config_router)
app.include_router(tasks_router)
app.include_router(sandboxes_router)
app.include_router(chat_router)
app.include_router(agent_router)
app.include_router(ai_router)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, token: str = Query(default="")):
    user_id = ""
    if token:
        payload = verify_token(token)
        if payload:
            user_id = payload.get("sub", "")
    if not user_id:
        await websocket.close(code=4001)
        return
    await manager.connect(websocket, user_id)
    try:
        while True:
            data = await websocket.receive_json()
            event = data.get("event", "message")
            # Support both "subscribe:task" (frontend) and "subscribe_task" (legacy)
            if event in ("subscribe_task", "subscribe:task"):
                task_id = data.get("taskId", "")
                if task_id:
                    manager.subscribe_task(task_id, websocket)
            elif event == "ping":
                await websocket.send_text('{"event":"pong"}')
            else:
                await manager.broadcast(event, data.get("data"))
    except WebSocketDisconnect:
        manager.disconnect(websocket, user_id)
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket, user_id)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=settings.port, reload=True)
