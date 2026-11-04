import json
import logging
from typing import Any
from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self):
        self._connections: dict[str, list[WebSocket]] = {}
        self._task_subscriptions: dict[str, list[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        if user_id not in self._connections:
            self._connections[user_id] = []
        self._connections[user_id].append(websocket)
        logger.info(f"WebSocket connected: user={user_id}")

    def disconnect(self, websocket: WebSocket, user_id: str):
        if user_id in self._connections:
            self._connections[user_id] = [ws for ws in self._connections[user_id] if ws != websocket]
            if not self._connections[user_id]:
                del self._connections[user_id]
        for task_id, sockets in list(self._task_subscriptions.items()):
            self._task_subscriptions[task_id] = [ws for ws in sockets if ws != websocket]
            if not self._task_subscriptions[task_id]:
                del self._task_subscriptions[task_id]

    async def send_to_user(self, user_id: str, data: dict):
        for ws in self._connections.get(user_id, []):
            try:
                await ws.send_text(json.dumps(data, ensure_ascii=False))
            except Exception:
                pass

    async def broadcast(self, event: str, data: Any):
        payload = json.dumps({"event": event, "data": data}, ensure_ascii=False)
        for user_id, sockets in list(self._connections.items()):
            for ws in sockets:
                try:
                    await ws.send_text(payload)
                except Exception:
                    pass

    def subscribe_task(self, task_id: str, websocket: WebSocket):
        if task_id not in self._task_subscriptions:
            self._task_subscriptions[task_id] = []
        self._task_subscriptions[task_id].append(websocket)

    async def notify_task(self, task_id: str, data: dict):
        payload = json.dumps({"event": "task", "data": data}, ensure_ascii=False)
        for ws in self._task_subscriptions.get(task_id, []):
            try:
                await ws.send_text(payload)
            except Exception:
                pass

    @property
    def active_connections(self) -> int:
        return sum(len(v) for v in self._connections.values())


manager = ConnectionManager()
