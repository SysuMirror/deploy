"""Agent loop — single while-loop, flat message history, DB-backed memory.

Design:
- All messages stored in agent_messages table (role: user/assistant/tool_result)
- Every run loads full history from DB → builds conversation array
- Agent loop: stream → parse tools → execute → save → repeat
- ask_user tool pauses the loop; next user message continues from where it left off
- _StreamFilter strips <tool_call> XML from streamed content so the
  frontend only sees clean text; tool invocations are shown via SSE events.
"""

import json, logging, re
from typing import AsyncGenerator
from sqlalchemy.orm import Session

from models import AIConfig, Novel, AgentMessage
from services.ai_service import AIService, AIStreamChunk
from services.agent.tools import ToolRegistry, parse_tool_calls, strip_tool_calls
from utils.helpers import new_id

logger = logging.getLogger(__name__)
MAX_ITERATIONS = 10


# ── Streaming tool-call filter ────────────────────────────────────────────────

class _StreamFilter:
    """Filters ``<tool_call>…</tool_call>`` out of a token stream.

    The AI streams text that may contain tool-call XML.  This stateful filter
    suppresses the XML and yields only the human-readable content.  When a
    complete ``<tool_call>…</tool_call>`` is consumed, its inner JSON is
    appended to ``tool_jsons`` so the caller can parse it later.
    """

    TAG = "<tool_call>"
    TAG_END = "</tool_call>"

    def __init__(self):
        self.buf = ""          # unconsumed characters
        self.tool_jsons: list[str] = []
        self._inside = False

    def feed(self, chunk: str) -> str | None:
        """Push a chunk; return clean text (or None if nothing to emit yet)."""
        self.buf += chunk
        out = ""

        while self.buf:
            if not self._inside:
                idx = self.buf.find(self.TAG)
                if idx == -1:
                    # No tag start — but keep a suffix that could begin a tag
                    keep = 0
                    for n in range(len(self.TAG) - 1, 0, -1):
                        if self.buf.endswith(self.TAG[:n]):
                            keep = n
                            break
                    if keep:
                        out += self.buf[:-keep]
                        self.buf = self.buf[-keep:]
                    else:
                        out += self.buf
                        self.buf = ""
                    break
                else:
                    out += self.buf[:idx]
                    self.buf = self.buf[idx + len(self.TAG):]
                    self._inside = True

            if self._inside:
                idx = self.buf.find(self.TAG_END)
                if idx == -1:
                    break  # wait for more chunks
                raw = self.buf[:idx].strip()
                if raw:
                    self.tool_jsons.append(raw)
                self.buf = self.buf[idx + len(self.TAG_END):]
                self._inside = False

        return out or None

    def flush(self) -> str:
        """Return whatever remains in the buffer (should be clean text)."""
        return self.buf


# ── System prompt ────────────────────────────────────────────────────────────

def _system_prompt(novel: Novel | None) -> str:
    tools = ToolRegistry.get_schemas()
    tools_desc = "\n".join(
        f"- **{t['name']}**({', '.join(t['parameters'].get('required', []))}): {t['description']}"
        for t in tools
    )
    ctx = ""
    if novel:
        ctx = (
            f"\n## 当前小说\n"
            f"- 书名: 《{novel.title}》 ID: {novel.id}\n"
            f"- 背景: {(novel.background or '未设定')[:300]}\n"
            f"- 题材: {', '.join(novel.genre or []) or '未指定'}\n"
            f"- 大纲: {(novel.outline or '未设定')[:500]}\n"
        )
    return f"""# 你是小说创作AI助手

你有能力通过调用工具来执行实际操作——创建小说、生成大纲、撰写章节内容。你不是一个只能说话的聊天机器人。

{ctx}

# 关键规则（必须严格遵守）

**规则 1：必须使用工具执行操作。** 当用户要求创建小说、写内容、生成大纲等操作时，你必须调用对应的工具。绝对禁止只在文字中描述你要做什么——你必须真的调用工具！

**规则 2：每次只调用一个工具。** 在文本结尾处使用以下精确格式调用工具：
```
<tool_call>{{"name":"create_novel","arguments":{{"title":"书名","genre":["题材"],"background":"背景设定"}}}}</tool_call>
```
格式说明：
- `<tool_call>` 标签必须单独成行或在段落末尾
- 标签内是一个 JSON 对象，包含 name 和 arguments 两个字段
- arguments 的值是一个 JSON 对象，键值对对应工具的参数
- 每次回复只能包含一个 tool_call

**规则 3：用 ask_user 让用户做选择题。** 当你需要用户做出选择时（如选书名、选风格、确认操作），必须调用 ask_user 工具。**必须提供 options 参数（2-4个精选选项）**，让用户一键点击选择。不要只问问题不给选项。调用 ask_user 后会暂停等待用户回复。如果只是需要用户确认，options 可以是 ["确认", "取消"] 或 ["是", "否"]。

**规则 4：完成后调用 done。** 全部操作完成后调用 done 工具。

# 完整示例

用户说"帮我创建一本玄幻小说叫仙道长青"，你的正确回复：

嗯，我来为你创建这本玄幻小说。

<tool_call>{{"name":"create_novel","arguments":{{"title":"仙道长青","genre":["玄幻","修仙"],"background":"一个凡人少年偶然获得上古传承，踏上修仙之路。","target_words":200000}}}}</tool_call>

---

用户说"写第一章"，你的正确回复（假设已有小说ID）：

好的，我来撰写第一章的内容。

<tool_call>{{"name":"write_chapter_content","arguments":{{"novel_id":"<从上下文获取>","chapter_id":"<章节ID>","instruction":"写第一章开场"}}}}</tool_call>

---

用户说"这本书叫什么好？"你的正确回复：

让我为你生成几个书名建议。

<tool_call>{{"name":"suggest_titles","arguments":{{"background":"<背景>","genre":["<题材>"],"count":5}}}}</tool_call>

# 可用工具

{tools_desc}

# 再次强调
**你不是聊天机器人，你是能执行操作的工具调用Agent。看到操作需求 → 调用工具，不要只是描述。** 全程用中文与用户交流。"""


# ── DB helpers ───────────────────────────────────────────────────────────────

def _save_msg(db: Session, session_id: str, role: str, content: str, extra: dict | None = None):
    msg = AgentMessage(id=new_id(), session_id=session_id, role=role,
                       content=content[:10000], extra=extra)
    db.add(msg)
    db.commit()


def _load_messages(db: Session, session_id: str) -> list[dict]:
    """Load all messages for a session, convert to OpenAI format."""
    msgs = db.query(AgentMessage).filter(
        AgentMessage.session_id == session_id
    ).order_by(AgentMessage.created_at).all()

    result = []
    for m in msgs:
        if m.role == "user":
            result.append({"role": "user", "content": m.content})
        elif m.role == "assistant":
            result.append({"role": "assistant", "content": m.content})
        elif m.role == "tool_result":
            extra = m.extra or {}
            text = json.dumps({"tool": extra.get("name",""), "result": extra.get("result",{}), "error": extra.get("error","")}, ensure_ascii=False)
            result.append({"role": "user", "content": f"<tool_result>{text}</tool_result>"})
    return result


def _last_tool_result_pending(db: Session, session_id: str) -> bool:
    """Check if the most recent tool_result has pending=True (ask_user awaiting answer)."""
    last_tr = db.query(AgentMessage).filter(
        AgentMessage.session_id == session_id,
        AgentMessage.role == "tool_result",
    ).order_by(AgentMessage.created_at.desc()).first()
    if last_tr and last_tr.extra:
        return last_tr.extra.get("pending") is True
    return False


# ── Agent ────────────────────────────────────────────────────────────────────

class ToolCallingAgent:
    def __init__(self, ai: AIService):
        self.ai = ai

    async def run(
        self,
        config: AIConfig,
        message: str,
        db: Session,
        user_id: str,
        session_id: str,
        novel: Novel | None,
    ) -> AsyncGenerator[AIStreamChunk, None]:
        """Run the agent loop for one user message in a session.

        Loads all previous messages from DB to maintain conversation memory.
        If the last assistant message contains an ask_user call, this message
        is treated as the answer (saved as tool_result, not user message).
        """

        # ── Load history ────────────────────────────────────────────────
        history = _load_messages(db, session_id)
        logger.info(f"[Agent] session={session_id} history_len={len(history)}")

        is_answer = _last_tool_result_pending(db, session_id)

        # ── Build conversation ──────────────────────────────────────────
        conversation = [{"role": "system", "content": _system_prompt(novel)}]

        if is_answer:
            # This message is an answer to a pending ask_user question.
            # Save as tool_result, append to conversation as tool_result.
            _save_msg(db, session_id, "tool_result", message,
                      {"name": "ask_user", "result": {"answer": message}})
            conversation.extend(history)
            conversation.append({"role": "user",
                "content": f"<tool_result>{json.dumps({'tool':'ask_user','result':{'answer':message}}, ensure_ascii=False)}</tool_result>"})
            logger.info("[Agent] treating message as ask_user answer")
        else:
            # Normal user message — save and append.
            _save_msg(db, session_id, "user", message)
            conversation.extend(history)
            conversation.append({"role": "user", "content": message})

        # ── Agent loop ──────────────────────────────────────────────────
        for iteration in range(1, MAX_ITERATIONS + 1):
            logger.info(f"[Agent] iter {iteration}/{MAX_ITERATIONS}")

            full_response = ""
            filt = _StreamFilter()

            # Stream AI — filter <tool_call> XML from displayed content
            async for chunk in self.ai.chat_stream(config, conversation):
                if chunk.type == "content":
                    full_response += chunk.content
                    clean = filt.feed(chunk.content)
                    if clean:
                        yield AIStreamChunk(type="content", content=clean)
                elif chunk.type == "reasoning":
                    yield AIStreamChunk(type="reasoning", content=chunk.content)
                elif chunk.type == "error":
                    yield chunk
                    return
                elif chunk.type == "done":
                    # Flush any leftover buffered text
                    tail = filt.flush()
                    if tail:
                        yield AIStreamChunk(type="content", content=tail)
                    break

            # Parse tool calls
            tool_calls = parse_tool_calls(full_response)

            if not tool_calls:
                # No tools — AI just chatted. Save clean content and stop.
                _save_msg(db, session_id, "assistant", strip_tool_calls(full_response))
                break

            # Save assistant message WITHOUT tool_call XML (clean for UI)
            # But send the FULL response (with XML) to AI so it remembers its tool calls
            _save_msg(db, session_id, "assistant", strip_tool_calls(full_response))
            conversation.append({"role": "assistant", "content": full_response})

            # Execute each tool
            for tc in tool_calls:
                logger.info(f"[Agent] tool: {tc.name}")

                # Emit tool_call event
                yield AIStreamChunk(type="content", content="", metadata={
                    "tool_call": {"name": tc.name, "arguments": tc.arguments}})

                # Execute
                tool = ToolRegistry.get(tc.name)
                if not tool:
                    from services.agent.tools import ToolResult
                    result = ToolResult(name=tc.name, error=f"未知工具: {tc.name}")
                else:
                    try:
                        result = await tool.execute(db, user_id, tc.arguments,
                                                     ai=self.ai, config=config)
                    except Exception as e:
                        from services.agent.tools import ToolResult
                        logger.error(f"[Agent] tool error: {e}")
                        result = ToolResult(name=tc.name, error=str(e))

                # Emit tool_result event
                yield AIStreamChunk(type="content", content="", metadata={
                    "tool_result": {"name": result.name, "result": result.result, "error": result.error}})

                # Emit action event if any
                if result.result.get("action"):
                    yield AIStreamChunk(type="content", content="", metadata={
                        "action": result.result["action"]})

                # ── ask_user: pause and wait ──────────────────────────
                if tc.name == "ask_user" and not result.error:
                    _save_msg(db, session_id, "tool_result",
                              result.result.get("question", ""),
                              {"name": "ask_user", "result": result.result, "pending": True})
                    yield AIStreamChunk(type="content", content="", metadata={
                        "question": {"question": result.result.get("question",""),
                                     "options": result.result.get("options",[]),
                                     "context": result.result.get("context","")}})
                    yield AIStreamChunk(type="done", content="", metadata={"awaitingInput": True})
                    return

                # Save tool_result and continue
                _save_msg(db, session_id, "tool_result",
                          result.result.get("message","") or json.dumps(result.result, ensure_ascii=False)[:500],
                          {"name": result.name, "result": result.result, "error": result.error})

                # Feed back to conversation
                result_text = json.dumps({
                    "tool": result.name,
                    "result": result.result if not result.error else {},
                    "error": result.error or "",
                }, ensure_ascii=False)
                conversation.append({"role": "user",
                    "content": f"<tool_result>{result_text}</tool_result>"})

                # done → stop
                if tc.name == "done":
                    yield AIStreamChunk(type="done", content="", metadata=result.result)
                    return

        # Max iterations
        _save_msg(db, session_id, "assistant", "已达到最大操作步数，任务可能未完全完成。")
        yield AIStreamChunk(type="done", content="")
