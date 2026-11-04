import { defineStore } from 'pinia';
import { ref } from 'vue';
import { toast } from 'vue-sonner';
import { API_URL } from '@/api/client';

type WsEventHandler = (data: unknown) => void;

export const useSocketStore = defineStore('socket', () => {
  const ws = ref<WebSocket | null>(null);
  const isConnected = ref(false);
  const handlers = new Map<string, Set<WsEventHandler>>();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let manualClose = false;
  let lastErrorToast = 0;

  function getBaseUrl() {
    if (typeof window === 'undefined') return 'ws://localhost:8002';
    if (API_URL && /^https?:\/\//i.test(API_URL)) {
      return API_URL.replace(/^http/, 'ws');
    }
    // 路径前缀部署：同源 + BASE_URL（API_URL 可能是 /sdpy/test/xxx）
    const pathPrefix = API_URL || '';
    return `${window.location.origin}${pathPrefix}`.replace(/^http/, 'ws');
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function connect() {
    if (typeof window === 'undefined') return;
    if (ws.value?.readyState === WebSocket.OPEN || ws.value?.readyState === WebSocket.CONNECTING) {
      return;
    }

    manualClose = false;
    const token = localStorage.getItem('token') || '';
    if (!token) return;

    const base = getBaseUrl();
    const s = new WebSocket(`${base}/ws?token=${encodeURIComponent(token)}`);

    s.onopen = () => {
      isConnected.value = true;
      reconnectAttempts = 0;
    };

    s.onerror = () => {
      const now = Date.now();
      if (now - lastErrorToast > 15000) {
        lastErrorToast = now;
        toast.error('实时连接异常，正在重试…');
      }
    };

    s.onclose = () => {
      isConnected.value = false;
      ws.value = null;
      if (manualClose) return;
      const delay = Math.min(30000, 2000 * Math.pow(1.6, reconnectAttempts));
      reconnectAttempts += 1;
      clearReconnect();
      reconnectTimer = setTimeout(() => {
        if (!isConnected.value) connect();
      }, delay);
    };

    s.onmessage = (event) => {
      try {
        const { event: eventName, data } = JSON.parse(event.data);

        if (eventName === 'ai_log:chunk' || eventName === 'ai_log:status') {
          import('@/stores/aiLog').then(({ useAiLogStore }) => {
            const store = useAiLogStore();
            if (eventName === 'ai_log:chunk') {
              store.handleWsChunk(data as Record<string, unknown>);
            } else {
              store.handleWsStatus(data as Record<string, unknown>);
            }
          });
        }

        const eventHandlers = handlers.get(eventName);
        if (eventHandlers) {
          eventHandlers.forEach((fn) => fn(data));
        }
        // Also fan-out typed task payloads
        if (eventName === 'task' && data && typeof data === 'object') {
          const typed = (data as { type?: string }).type;
          if (typed) {
            handlers.get(typed)?.forEach((fn) => fn(data));
          }
        }
      } catch {
        // ignore malformed messages
      }
    };

    ws.value = s;
  }

  function disconnect() {
    manualClose = true;
    clearReconnect();
    ws.value?.close();
    ws.value = null;
    isConnected.value = false;
  }

  function subscribeToTask(taskId: string) {
    if (ws.value?.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify({ event: 'subscribe:task', taskId }));
    } else {
      connect();
      setTimeout(() => {
        if (ws.value?.readyState === WebSocket.OPEN) {
          ws.value.send(JSON.stringify({ event: 'subscribe:task', taskId }));
        }
      }, 500);
    }
  }

  function on(event: string, fn: WsEventHandler) {
    if (!handlers.has(event)) {
      handlers.set(event, new Set());
    }
    handlers.get(event)!.add(fn);
    return () => off(event, fn);
  }

  function off(event: string, fn: WsEventHandler) {
    handlers.get(event)?.delete(fn);
  }

  return { ws, isConnected, connect, disconnect, subscribeToTask, on, off };
});
