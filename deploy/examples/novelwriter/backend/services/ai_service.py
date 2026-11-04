import logging
from dataclasses import dataclass, field
from typing import AsyncGenerator, Literal
from openai import AsyncOpenAI
from models import AIConfig

logger = logging.getLogger(__name__)

ChunkType = Literal["reasoning", "content", "error", "done"]


@dataclass
class AIStreamChunk:
    """Typed streaming chunk from AI service.

    - type="reasoning": DeepSeek thinking tokens (dimmed in UI)
    - type="content": Final answer tokens
    - type="error": Stream error
    - type="done": Stream ended
    """
    type: ChunkType
    content: str = ""
    metadata: dict = field(default_factory=dict)


# ── DeepSeek 判断 ────────────────────────────────────────────
def _is_deepseek(config: AIConfig) -> bool:
    return "deepseek" in config.provider.lower() or "deepseek.com" in (config.base_url or "").lower()


class AIService:
    """封装 OpenAI SDK，兼容 DeepSeek（thinking / reasoning_effort / extra_body）

    全部 AI 调用统一走流式，通过 AIStreamChunk 区分 thinking / content。
    """

    # ── 流式调用 ───────────────────────────────────────────
    async def chat_stream(self, config: AIConfig, messages: list[dict]) -> AsyncGenerator[AIStreamChunk, None]:
        """流式聊天，逐 chunk yield AIStreamChunk（type=reasoning|content）"""
        try:
            client = AsyncOpenAI(api_key=config.api_key, base_url=config.base_url or None)
            params = self._build_params(config, messages, stream=True)

            logger.info(f"[AI-STREAM] 请求 → model={config.model} provider={config.provider} "
                        f"messages={len(messages)}")

            stream = await client.chat.completions.create(**params)
            chunk_count = 0
            full_response = ""
            async for chunk in stream:
                chunk_count += 1
                delta = chunk.choices[0].delta if chunk.choices else None
                if delta and delta.content:
                    full_response += delta.content
                    yield AIStreamChunk(type="content", content=delta.content)
                elif delta and getattr(delta, "reasoning_content", None):
                    full_response += delta.reasoning_content
                    yield AIStreamChunk(type="reasoning", content=delta.reasoning_content)

            preview = full_response[:300].replace("\n", "\\n")
            logger.info(f"[AI-STREAM] 响应 ← chunks={chunk_count} len={len(full_response)} "
                        f"预览: {preview}{'...' if len(full_response) > 300 else ''}")

            yield AIStreamChunk(type="done", content=full_response,
                                metadata={"chunks": chunk_count, "total_length": len(full_response)})

        except Exception as e:
            logger.error(f"[AI-STREAM] 失败: {e}")
            yield AIStreamChunk(type="error", content=str(e))

    # ── 参数构建 ───────────────────────────────────────────
    def _build_params(self, config: AIConfig, messages: list[dict], stream: bool) -> dict:
        """把前端 AIConfig 参数转成 OpenAI SDK 的 kwargs"""
        params = {
            "model": config.model,
            "messages": messages,
            "stream": stream,
        }
        p = config.parameters or {}

        if "temperature" in p:
            params["temperature"] = float(p["temperature"])

        if "maxTokens" in p:
            tokens = int(p["maxTokens"])
            if _is_deepseek(config):
                tokens = min(tokens, 65536)
            else:
                tokens = min(tokens, 131072)
            params["max_tokens"] = tokens

        # DeepSeek thinking 模式
        if _is_deepseek(config):
            thinking_enabled = p.get("thinking", True)
            if thinking_enabled:
                params["extra_body"] = {
                    "thinking": {"type": "enabled"},
                    "reasoning_effort": p.get("reasoningEffort") or "high",
                }
            else:
                params["extra_body"] = {"thinking": {"type": "disabled"}}

        return params
