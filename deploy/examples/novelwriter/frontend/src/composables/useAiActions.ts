/** Listens for AI action events and executes them on the frontend. */
import { onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { executeSkill } from '@/utils/aiPipe';

export function useAiActions() {
  const router = useRouter();

  function onNavigate(e: Event) {
    const route = (e as CustomEvent<{ route: string }>).detail?.route;
    if (route) {
      router.push(route);
    }
  }

  function onCreateNovel(e: Event) {
    const params = (e as CustomEvent<Record<string, unknown>>).detail;
    if (params?.title) {
      router.push({
        path: '/novels/new',
        query: {
          title: params.title as string,
          genre: JSON.stringify(params.genre || []),
          style: JSON.stringify(params.style || []),
          background: (params.background as string) || '',
        },
      });
    }
  }

  function onExecuteSkill(e: Event) {
    const { skillId, params } = (e as CustomEvent<{ skillId: string; params: Record<string, unknown> }>).detail;
    if (skillId && params) {
      executeSkill(skillId, (params.novel_id || params.novelId || '') as string, params);
    }
  }

  function onAction(e: Event) {
    const action = (e as CustomEvent<Record<string, unknown>>).detail;
    console.log('[AiAction]', action.type, action);
  }

  onMounted(() => {
    window.addEventListener('ai:navigate', onNavigate);
    window.addEventListener('ai:create-novel', onCreateNovel);
    window.addEventListener('ai:execute-skill', onExecuteSkill);
    window.addEventListener('ai:action', onAction);
  });

  onUnmounted(() => {
    window.removeEventListener('ai:navigate', onNavigate);
    window.removeEventListener('ai:create-novel', onCreateNovel);
    window.removeEventListener('ai:execute-skill', onExecuteSkill);
    window.removeEventListener('ai:action', onAction);
  });
}
