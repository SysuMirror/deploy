import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useAiLogStore } from '@/stores/aiLog';

describe('aiLogStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  describe('tab management', () => {
    it('creates a new tab with correct initial state', () => {
      const store = useAiLogStore();
      const taskId = store.createTab('free_chat', 'novel-1', '测试对话');

      expect(taskId).toBeTruthy();
      expect(taskId).toMatch(/^task_\d+_\d+$/);

      const tab = store.tabs[taskId];
      expect(tab).toBeDefined();
      expect(tab.skillId).toBe('free_chat');
      expect(tab.novelId).toBe('novel-1');
      expect(tab.title).toBe('测试对话');
      expect(tab.status).toBe('queued');
      expect(tab.messages).toHaveLength(0);
    });

    it('closes a tab and removes it', () => {
      const store = useAiLogStore();
      const taskId = store.createTab('free_chat', '', 'test');
      expect(Object.keys(store.tabs)).toHaveLength(1);

      store.closeTab(taskId);
      expect(store.tabs[taskId]).toBeUndefined();
    });

    it('closing the active tab switches to another tab', () => {
      const store = useAiLogStore();
      const t1 = store.createTab('free_chat', '', 'tab1');
      const t2 = store.createTab('free_chat', '', 'tab2');
      store.activeTabId = t1;

      store.closeTab(t1);
      expect(store.activeTabId).toBe(t2);
    });

    it('tabList returns tabs sorted by creation time descending', () => {
      const store = useAiLogStore();
      const t1 = store.createTab('free_chat', '', 'old');
      const t2 = store.createTab('free_chat', '', 'new');

      const list = store.tabList;
      expect(list[0].taskId).toBe(t2); // newest first
      expect(list[1].taskId).toBe(t1);
    });
  });

  describe('message handling', () => {
    it('appendChunk adds content to the last assistant message', () => {
      const store = useAiLogStore();
      const taskId = store.createTab('free_chat', '', 'test');
      store.appendUserMessage(taskId, 'hello');
      store.appendAssistantMessage(taskId);

      store.appendChunk(taskId, 'content', '你好');
      store.appendChunk(taskId, 'content', '世界');

      const tab = store.tabs[taskId];
      const lastMsg = tab.messages[tab.messages.length - 1];
      expect(lastMsg.role).toBe('assistant');
      expect(lastMsg.content).toBe('你好世界');
    });

    it('appendChunk with reasoning type adds to reasoningContent', () => {
      const store = useAiLogStore();
      const taskId = store.createTab('free_chat', '', 'test');
      store.appendAssistantMessage(taskId);

      store.appendChunk(taskId, 'reasoning', 'thinking step 1...');
      store.appendChunk(taskId, 'reasoning', 'thinking step 2...');

      const lastMsg = store.tabs[taskId].messages[0];
      expect(lastMsg.reasoningContent).toBe('thinking step 1...thinking step 2...');
      expect(lastMsg.content).toBe(''); // content stays empty
    });

    it('appendChunk with reasoning and content goes to separate fields', () => {
      const store = useAiLogStore();
      const taskId = store.createTab('free_chat', '', 'test');
      store.appendAssistantMessage(taskId);

      store.appendChunk(taskId, 'reasoning', 'thinking...');
      store.appendChunk(taskId, 'content', 'answer');

      const lastMsg = store.tabs[taskId].messages[0];
      expect(lastMsg.reasoningContent).toBe('thinking...');
      expect(lastMsg.content).toBe('answer');
    });

    it('appendChunk is no-op when tab has no messages', () => {
      const store = useAiLogStore();
      const taskId = store.createTab('free_chat', '', 'test');
      // No user/assistant messages — appendChunk should be safe
      expect(() => store.appendChunk(taskId, 'content', 'x')).not.toThrow();
    });

    it('appendChunk is no-op for unknown taskId', () => {
      const store = useAiLogStore();
      expect(() => store.appendChunk('nonexistent', 'content', 'x')).not.toThrow();
    });

    it('finishMessage marks streaming as done', () => {
      const store = useAiLogStore();
      const taskId = store.createTab('free_chat', '', 'test');
      store.appendAssistantMessage(taskId);

      store.finishMessage(taskId, 'completed');

      const tab = store.tabs[taskId];
      expect(tab.status).toBe('completed');
      const lastMsg = tab.messages[tab.messages.length - 1];
      expect(lastMsg.isStreaming).toBe(false);
    });

    it('finishMessage with failed sets error', () => {
      const store = useAiLogStore();
      const taskId = store.createTab('free_chat', '', 'test');
      store.appendAssistantMessage(taskId);

      store.finishMessage(taskId, 'failed', 'timeout');

      const tab = store.tabs[taskId];
      expect(tab.status).toBe('failed');
      expect(tab.error).toBe('timeout');
    });
  });

  describe('panel state', () => {
    it('openPanel sets isPanelOpen and activeTabId', () => {
      const store = useAiLogStore();
      const taskId = store.createTab('free_chat', '', 'test');

      store.openPanel(taskId);

      expect(store.isPanelOpen).toBe(true);
      expect(store.activeTabId).toBe(taskId);
    });

    it('togglePanel toggles isPanelOpen', () => {
      const store = useAiLogStore();
      expect(store.isPanelOpen).toBe(false);

      store.togglePanel();
      expect(store.isPanelOpen).toBe(true);

      store.togglePanel();
      expect(store.isPanelOpen).toBe(false);
    });

    it('closing last tab hides panel', () => {
      const store = useAiLogStore();
      const taskId = store.createTab('free_chat', '', 'test');
      store.isPanelOpen = true;

      store.closeTab(taskId);

      expect(store.isPanelOpen).toBe(false);
    });
  });

  describe('computed properties', () => {
    it('runningCount counts tabs with running status', () => {
      const store = useAiLogStore();
      const t1 = store.createTab('free_chat', '', '1');
      const t2 = store.createTab('free_chat', '', '2');
      store.tabs[t1].status = 'running';
      store.tabs[t2].status = 'running';

      expect(store.runningCount).toBe(2);

      store.tabs[t1].status = 'completed';
      expect(store.runningCount).toBe(1);
    });

    it('activeTab returns null when no tab is selected', () => {
      const store = useAiLogStore();
      expect(store.activeTab).toBeNull();
    });
  });
});
