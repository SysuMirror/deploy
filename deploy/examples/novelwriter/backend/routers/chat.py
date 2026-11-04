import json
from typing import AsyncGenerator
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session
from database import get_db
from middleware.auth import get_current_user
from models import User
from services.ai_service import AIService, AIStreamChunk
from services.agent import Orchestrator

router = APIRouter(prefix="/api/chat", tags=["chat"])


def _get_ai_and_orch():
    ai = AIService()
    orch = Orchestrator(ai)
    return ai, orch


@router.post("")
async def chat_stream(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    body = await request.json()
    messages = body.get("messages", [])
    # Support frontend's single-message format: { novelId, message, previousContent }
    if not messages and body.get("message"):
        system_msg = "你是一位专业的小说创作AI助手。"
        msg_list = [{"role": "system", "content": system_msg}]
        if body.get("previousContent"):
            msg_list.append({"role": "user", "content": f"前文内容：{body['previousContent']}"})
        msg_list.append({"role": "user", "content": body["message"]})
        messages = msg_list
    if not messages:
        raise HTTPException(status_code=400, detail="消息不能为空")

    ai, orch = _get_ai_and_orch()
    config = orch.get_config(db, current_user.id)
    if not config:
        raise HTTPException(status_code=400, detail="请先配置AI模型")

    async def event_stream() -> AsyncGenerator[str, None]:
        try:
            async for chunk in ai.chat_stream(config, messages):
                if chunk.type == "reasoning":
                    yield f"event: reasoning\ndata: {json.dumps({'content': chunk.content}, ensure_ascii=False)}\n\n"
                elif chunk.type == "content":
                    yield f"data: {json.dumps({'content': chunk.content}, ensure_ascii=False)}\n\n"
                elif chunk.type == "error":
                    yield f"event: error\ndata: {json.dumps({'message': chunk.content}, ensure_ascii=False)}\n\n"
                elif chunk.type == "done":
                    break
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'message': str(e)}, ensure_ascii=False)}\n\n"
        yield "data: [DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")
