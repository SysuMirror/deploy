import { api, API_URL, extractErrorMessage } from './client';

export { api, API_URL, extractErrorMessage };

export const authAPI = {
  register: (data: { email: string; password: string; name?: string }) =>
    api.post('/auth/register', data),
  login: (data: { email: string; password: string }) =>
    api.post('/auth/login', data),
  me: () => api.get('/auth/me'),
  signin: (data: { email: string; password: string }) =>
    api.post('/auth/signin', data),
};

export const novelsAPI = {
  list: () => api.get('/novels'),
  get: (id: string) => api.get(`/novels/${id}`),
  create: (data: Record<string, unknown>) => api.post('/novels', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/novels/${id}`, data),
  updateCover: (id: string, formData: FormData) =>
    api.patch(`/novels/${id}/cover`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  delete: (id: string) => api.delete(`/novels/${id}`),

  getCharacters: (novelId: string) => api.get(`/novels/${novelId}/characters`),
  generateCharacters: (novelId: string, options?: { count?: number }) =>
    api.post(`/novels/${novelId}/characters/generate`, options ?? {}),
  createCharacter: (novelId: string, data: Record<string, unknown>) =>
    api.post(`/novels/${novelId}/characters`, data),
  updateCharacter: (novelId: string, characterId: string, data: Record<string, unknown>) =>
    api.patch(`/novels/${novelId}/characters/${characterId}`, data),
  deleteCharacter: (novelId: string, characterId: string) =>
    api.delete(`/novels/${novelId}/characters/${characterId}`),

  updateOutline: (novelId: string, data: { outline: string }) =>
    api.patch(`/novels/${novelId}/outline`, data),
  condenseOutline: (novelId: string, outline: string) =>
    api.post(`/novels/${novelId}/condense-outline`, { outline }),
  readThroughChapters: (novelId: string, chapterIds: string[]) =>
    api.post(`/novels/${novelId}/chapters/read-through`, { chapterIds }),

  getPlotThreads: (novelId: string) => api.get(`/novels/${novelId}/threads`),
  createPlotThread: (novelId: string, data: { title: string; content?: string; status?: string }) =>
    api.post(`/novels/${novelId}/threads`, data),
  updatePlotThread: (novelId: string, threadId: string, data: Record<string, unknown>) =>
    api.patch(`/novels/${novelId}/threads/${threadId}`, data),
  deletePlotThread: (novelId: string, threadId: string) =>
    api.delete(`/novels/${novelId}/threads/${threadId}`),

  getTimelineEvents: (novelId: string) => api.get(`/novels/${novelId}/timeline`),
  createTimelineEvent: (novelId: string, data: Record<string, unknown>) =>
    api.post(`/novels/${novelId}/timeline`, data),
  updateTimelineEvent: (novelId: string, eventId: string, data: Record<string, unknown>) =>
    api.patch(`/novels/${novelId}/timeline/${eventId}`, data),
  deleteTimelineEvent: (novelId: string, eventId: string) =>
    api.delete(`/novels/${novelId}/timeline/${eventId}`),

  getOutlineVersions: (novelId: string) => api.get(`/novels/${novelId}/outline/versions`),
  saveOutlineVersion: (novelId: string, data: Record<string, unknown>) =>
    api.post(`/novels/${novelId}/outline/versions`, data),
  lockOutlineVersion: (novelId: string, versionId: string, isLocked: boolean) =>
    api.patch(`/novels/${novelId}/outline/versions/${versionId}/lock`, { isLocked }),
  rollbackOutlineVersion: (novelId: string, versionId: string) =>
    api.post(`/novels/${novelId}/outline/versions/${versionId}/rollback`),

  generateOutlineStream: (novelId: string, mode: string, existingOutline?: string) => {
    const base = API_URL || (typeof window !== 'undefined' ? window.location.origin : '');
    const url = new URL(`${base}/api/novels/${novelId}/generate/outline/stream`);
    url.searchParams.set('mode', mode);
    if (existingOutline) url.searchParams.set('existingOutline', existingOutline);
    const token = localStorage.getItem('token') || '';
    if (token) url.searchParams.set('token', token);
    return new EventSource(url.toString(), { withCredentials: true });
  },

  suggestTitles: (data: Record<string, unknown>) => api.post('/novels/suggestions/titles', data),
  expandBackground: (data: Record<string, unknown>) =>
    api.post('/novels/suggestions/expand-background', data),

  export: (id: string, format = 'json') =>
    api.get(`/novels/${id}/export`, {
      params: { format },
      responseType: format === 'json' ? 'json' : 'blob',
    }),
  import: (data: FormData | Record<string, unknown>) => {
    if (data instanceof FormData) {
      return api.post('/novels/import', data, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
    }
    return api.post('/novels/import', data);
  },
  extractStyle: (id: string, sampleText: string) =>
    api.post(`/novels/${id}/extract-style`, { sampleText }),
};

export const tasksAPI = {
  generateVolumes: (novelId: string, data: { outline: string; additionalRequirements?: string; count?: number }) =>
    api.post(`/novels/${novelId}/generate/volumes`, data),
  saveBatchVolumes: (novelId: string, volumes: unknown[]) =>
    api.post(`/novels/${novelId}/volumes/batch`, { volumes }),
  updateVolume: (novelId: string, volumeId: string, data: { title: string; summary?: string }) =>
    api.patch(`/novels/${novelId}/volumes/${volumeId}`, data),
  deleteVolume: (novelId: string, volumeId: string) =>
    api.delete(`/novels/${novelId}/volumes/${volumeId}`),
  generateChapters: (
    novelId: string,
    data: {
      outline: string;
      volumeId?: string;
      additionalRequirements?: string;
      count?: number;
    },
  ) => api.post(`/novels/${novelId}/generate/chapters`, data),
  saveBatchChapters: (novelId: string, volumeId: string, chapters: unknown[]) =>
    api.post(`/novels/${novelId}/volumes/${volumeId}/chapters/batch`, { chapters }),
  generateChapterContent: (novelId: string, chapterId: string, data?: Record<string, unknown>) =>
    api.post(`/novels/${novelId}/chapters/${chapterId}/generate`, data ?? {}),
  getTaskStatus: (taskId: string) => api.get(`/tasks/${taskId}`),
  cancelTask: (taskId: string) => api.post(`/tasks/${taskId}/cancel`),
  retryTask: (taskId: string) => api.post(`/tasks/${taskId}/retry`),
  updateChapter: (chapterId: string, data: Record<string, unknown>) =>
    api.patch(`/chapters/${chapterId}`, data),
  deleteChapter: (chapterId: string) => api.delete(`/chapters/${chapterId}`),
  getChapter: (chapterId: string) => api.get(`/chapters/${chapterId}`),
  listSnapshots: (chapterId: string) => api.get(`/chapters/${chapterId}/snapshots`),
  createSnapshot: (chapterId: string, label?: string) =>
    api.post(`/chapters/${chapterId}/snapshots`, { label }),
  getSnapshot: (chapterId: string, snapshotId: string) =>
    api.get(`/chapters/${chapterId}/snapshots/${snapshotId}`),
  restoreSnapshot: (chapterId: string, snapshotId: string) =>
    api.post(`/chapters/${chapterId}/snapshots/${snapshotId}/restore`),
  deleteSnapshot: (chapterId: string, snapshotId: string) =>
    api.delete(`/chapters/${chapterId}/snapshots/${snapshotId}`),
  checkOoc: (chapterId: string, content: string) =>
    api.post(`/chapters/${chapterId}/ooc-check`, { content }),
  extractPlotThreads: (chapterId: string) =>
    api.post(`/chapters/${chapterId}/extract-plot-threads`, {}),
  inferTimeline: (chapterId: string) => api.post(`/chapters/${chapterId}/infer-timeline`, {}),
  extractKnowledge: (chapterId: string) => api.post(`/chapters/${chapterId}/extract-knowledge`, {}),
  rewriteParagraph: (
    chapterId: string,
    data: {
      paragraphText: string;
      restOfChapterContent: string;
      additionalInstructions?: string;
    },
  ) => api.post(`/chapters/${chapterId}/rewrite-paragraph`, data),
};

export const aiConfigAPI = {
  list: () => api.get('/ai-config'),
  create: (data: Record<string, unknown>) => api.post('/ai-config', data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/ai-config/${id}`, data),
  delete: (id: string) => api.delete(`/ai-config/${id}`),
  setDefault: (id: string) => api.post(`/ai-config/${id}/set-default`),
};

export const knowledgeAPI = {
  listAll: () => api.get('/knowledge'),
  list: (novelId: string) => api.get(`/knowledge/${novelId}`),
  create: (novelId: string, data: Record<string, unknown>) =>
    api.post(`/knowledge/${novelId}`, data),
  update: (novelId: string, id: string, data: Record<string, unknown>) =>
    api.patch(`/knowledge/${novelId}/${id}`, data),
  delete: (novelId: string, id: string) => api.delete(`/knowledge/${novelId}/${id}`),
  getDocuments: (novelId: string, kbId: string) =>
    api.get(`/knowledge/${novelId}/${kbId}/documents`),
  uploadDocument: (novelId: string, kbId: string, formData: FormData) =>
    api.post(`/knowledge/${novelId}/${kbId}/documents`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  deleteDocument: (novelId: string, kbId: string, docId: string) =>
    api.delete(`/knowledge/${novelId}/${kbId}/documents/${docId}`),
  search: (novelId: string, kbId: string, query: string, limit?: number) =>
    api.post(`/knowledge/${novelId}/${kbId}/search`, { query, limit }),
};

export async function chatStream(
  novelId: string,
  message: string,
  previousContent?: string,
  onChunk?: (chunk: string) => void,
) {
  const response = await fetch(`${API_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token')}`,
    },
    credentials: 'include',
    body: JSON.stringify({ novelId, message, previousContent }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(extractErrorMessage(err, 'Chat request failed'));
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value);
    for (const line of chunk.split('\n\n')) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') break;
        try {
          const parsed = JSON.parse(data) as { content?: string };
          if (parsed.content && onChunk) onChunk(parsed.content);
        } catch {
          /* ignore parse errors */
        }
      }
    }
  }
}

export const sandboxAPI = {
  list: (novelId: string) => api.get(`/novels/${novelId}/sandboxes`),
  create: (novelId: string, data: { title: string; premise: string }) =>
    api.post(`/novels/${novelId}/sandboxes`, data),
  update: (id: string, data: Record<string, unknown>) => api.patch(`/sandboxes/${id}`, data),
  delete: (id: string) => api.delete(`/sandboxes/${id}`),
  generate: (id: string) => api.post(`/sandboxes/${id}/generate`),
};

export const agentAPI = {
  createSession: (payload: { novelId?: string; title?: string }) =>
    api.post('/agent/session', payload),
  getSkills: () => api.get('/agent/skills'),
  getConversations: () => api.get('/agent/conversations'),
  getMessages: (sessionId: string) => api.get(`/agent/session/${sessionId}/messages`),
  process: (sessionId: string, userInput: string) =>
    api.post(`/agent/session/${sessionId}/process`, { userInput }),
  confirm: (sessionId: string, data: { choice: string; modifications?: unknown[] }) =>
    api.post(`/agent/session/${sessionId}/confirm`, data),
  getHistory: (taskId: string) => api.get(`/agent/session/${taskId}/history`),
  closeSession: (taskId: string) => api.delete(`/agent/session/${taskId}`),
  listSessions: (novelId: string) => api.get(`/agent/sessions?novelId=${novelId}`),
};

export async function agentProcessStream(
  sessionId: string,
  userInput: string,
  onEvent: (event: Record<string, unknown>) => void,
) {
  const response = await fetch(`${API_URL}/api/agent/session/${sessionId}/process/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token')}`,
    },
    credentials: 'include',
    body: JSON.stringify({ userInput }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(extractErrorMessage(err, 'Agent request failed'));
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      if (!part.trim()) continue;
      const lines = part.split('\n');
      let eventType = '';
      let data = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          data = line.slice(6);
        }
      }
      if (!data) continue;
      if (data === '[DONE]') {
        onEvent({ type: 'done' });
        continue;
      }
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        if (eventType === 'meta') {
          onEvent({ type: 'meta', data: parsed });
        } else {
          onEvent({ type: 'content', data: parsed });
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }
}

export async function agentConfirmStream(
  sessionId: string,
  data: { choice: string; modifications?: unknown[] },
  onEvent: (event: Record<string, unknown>) => void,
) {
  const response = await fetch(`${API_URL}/api/agent/session/${sessionId}/confirm/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token')}`,
    },
    credentials: 'include',
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(extractErrorMessage(err, 'Confirm stream failed'));
  }
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';
    for (const part of parts) {
      if (!part.trim()) continue;
      const lines = part.split('\n');
      let eventType = '';
      let bodyData = '';
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          bodyData = line.slice(6);
        }
      }
      if (!bodyData) continue;
      if (bodyData === '[DONE]') {
        onEvent({ type: 'done' });
        continue;
      }
      try {
        const parsed = JSON.parse(bodyData) as Record<string, unknown>;
        if (eventType === 'meta') {
          onEvent({ type: 'meta', data: parsed });
        } else {
          onEvent({ type: 'content', data: parsed });
        }
      } catch {
        /* ignore */
      }
    }
  }
}
