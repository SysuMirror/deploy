<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { Loader2, Plus, Wand2, BookOpen, Play, XCircle } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import UiButton from '@/components/ui/UiButton.vue';
import { novelsAPI, tasksAPI } from '@/api';
import { useSocketStore } from '@/stores/socket';

const props = defineProps<{ novelId: string; novel: Record<string, unknown> }>();
const emit = defineEmits<{ refresh: [] }>();

const router = useRouter();
const socketStore = useSocketStore();
const loading = ref(false);
const generatingTaskId = ref<string | null>(null);
const outline = ref('');
const additionalReq = ref('');
const selectedVolumeId = ref('');
const readThroughIds = ref<string[]>([]);
const volumes = ref<Array<Record<string, unknown>>>([]);

let offTask: (() => void) | null = null;

function syncVolumes() {
  volumes.value = (props.novel.volumes as Array<Record<string, unknown>>) || [];
  if (!selectedVolumeId.value && volumes.value.length) {
    const first = volumes.value.find((v) => v.id);
    selectedVolumeId.value = (first?.id as string) || '';
  }
  if (!outline.value) {
    outline.value = (props.novel.outline as string) || '';
  }
}

watch(() => props.novel, syncVolumes, { deep: true, immediate: true });

onMounted(() => {
  syncVolumes();
  socketStore.connect();
  offTask = socketStore.on('task', (data: unknown) => {
    const payload = data as { type?: string; taskId?: string };
    if (!generatingTaskId.value || payload.taskId !== generatingTaskId.value) return;
    if (payload.type === 'task:completed' || payload.type === 'task:failed' || payload.type === 'task:cancelled') {
      if (payload.type === 'task:completed') toast.success('任务已完成');
      if (payload.type === 'task:failed') toast.error('任务失败');
      if (payload.type === 'task:cancelled') toast.info('任务已取消');
      generatingTaskId.value = null;
      emit('refresh');
    }
  });
});

onUnmounted(() => {
  offTask?.();
});

function trackTask(taskId: string) {
  generatingTaskId.value = taskId;
  socketStore.subscribeToTask(taskId);
}

async function generateVolumes() {
  if (!outline.value.trim()) return toast.error('请先填写大纲');
  loading.value = true;
  try {
    const res = await tasksAPI.generateVolumes(props.novelId, {
      outline: outline.value,
      additionalRequirements: additionalReq.value,
      count: 3,
    });
    const taskId = res.data?.id as string | undefined;
    if (taskId) trackTask(taskId);
    if (res.data?.volumes?.length) {
      toast.success(`已生成 ${res.data.volumes.length} 个分卷`);
      generatingTaskId.value = null;
      emit('refresh');
    } else if (taskId) {
      toast.success('分卷生成任务已提交');
    }
  } catch {
    /* toast by interceptor */
  } finally {
    loading.value = false;
  }
}

async function generateChapters() {
  if (!selectedVolumeId.value) return toast.error('请选择分卷');
  loading.value = true;
  try {
    const res = await tasksAPI.generateChapters(props.novelId, {
      outline: outline.value,
      volumeId: selectedVolumeId.value,
      additionalRequirements: additionalReq.value,
      count: 10,
    });
    const taskId = res.data?.id as string | undefined;
    if (taskId) trackTask(taskId);
    if (res.data?.chapters?.length) {
      toast.success(`已生成 ${res.data.chapters.length} 章`);
      generatingTaskId.value = null;
      emit('refresh');
    } else if (taskId) {
      toast.success('章节生成任务已提交');
    }
  } catch {
    /* toast by interceptor */
  } finally {
    loading.value = false;
  }
}

async function generateChapterContent(chapterId: string) {
  loading.value = true;
  try {
    const res = await tasksAPI.generateChapterContent(props.novelId, chapterId);
    const taskId = res.data?.id as string | undefined;
    if (taskId) trackTask(taskId);
    if (res.data?.content) {
      toast.success('正文已生成');
      generatingTaskId.value = null;
      emit('refresh');
    } else if (taskId) {
      toast.success('正文生成已提交');
    }
  } catch {
    /* toast by interceptor */
  } finally {
    loading.value = false;
  }
}

async function cancelCurrentTask() {
  if (!generatingTaskId.value) return;
  try {
    await tasksAPI.cancelTask(generatingTaskId.value);
    generatingTaskId.value = null;
    toast.info('已请求取消');
  } catch {
    /* toast by interceptor */
  }
}

async function readThrough() {
  if (readThroughIds.value.length < 2 || readThroughIds.value.length > 5) {
    return toast.error('请选择 2～5 个连续章节');
  }
  loading.value = true;
  try {
    await novelsAPI.readThroughChapters(props.novelId, readThroughIds.value);
    toast.success('全文通读任务已提交');
  } catch {
    /* toast by interceptor */
  } finally {
    loading.value = false;
  }
}

function goEdit(chapterId: string) {
  router.push(`/chapters/edit?id=${chapterId}`);
}

function toggleReadThrough(id: string) {
  const idx = readThroughIds.value.indexOf(id);
  if (idx >= 0) readThroughIds.value.splice(idx, 1);
  else readThroughIds.value.push(id);
}
</script>

<template>
  <div class="space-y-6">
    <div class="rounded-xl border p-4 space-y-3">
      <label class="text-sm font-medium">大纲（用于生成卷/章）</label>
      <textarea
        v-model="outline"
        rows="4"
        class="w-full border rounded-md px-3 py-2 bg-background text-sm min-h-[96px]"
        placeholder="粘贴或输入大纲..."
      />
      <input
        v-model="additionalReq"
        class="w-full border rounded-md px-3 py-2 bg-background text-sm"
        placeholder="额外要求（可选）"
      />
      <div class="flex flex-col sm:flex-row sm:flex-wrap gap-2">
        <UiButton size="sm" class="w-full sm:w-auto" :disabled="loading" @click="generateVolumes">
          <Loader2 v-if="loading" class="h-4 w-4 animate-spin mr-1" />
          <Wand2 v-else class="h-4 w-4 mr-1" />AI 生成分卷
        </UiButton>
        <select
          v-model="selectedVolumeId"
          class="border rounded-md px-3 py-2 bg-background text-sm w-full sm:w-auto min-w-[10rem]"
        >
          <option value="" disabled>选择分卷</option>
          <option v-for="vol in volumes.filter((v) => v.id)" :key="vol.id as string" :value="vol.id as string">
            {{ vol.title }}
          </option>
        </select>
        <UiButton size="sm" variant="outline" class="w-full sm:w-auto" :disabled="loading" @click="generateChapters">
          <Plus class="h-4 w-4 mr-1" />批量生成章节
        </UiButton>
      </div>
    </div>

    <div v-if="!volumes.length" class="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
      暂无分卷。填写大纲后点击「AI 生成分卷」开始。
    </div>

    <div v-for="vol in volumes" :key="(vol.id as string) || vol.title as string" class="rounded-xl border overflow-hidden">
      <div class="px-4 py-3 bg-muted/30 font-medium flex justify-between items-center gap-2">
        <span class="truncate">{{ vol.title }}</span>
        <span class="text-xs text-muted-foreground shrink-0">{{ (vol.chapters as unknown[])?.length || 0 }} 章</span>
      </div>
      <div class="divide-y">
        <div
          v-for="ch in (vol.chapters as Array<Record<string, unknown>>) || []"
          :key="ch.id as string"
          class="px-3 sm:px-4 py-3 flex items-center justify-between gap-2 hover:bg-muted/20"
        >
          <div class="flex items-center gap-2 sm:gap-3 min-w-0">
            <input
              type="checkbox"
              :checked="readThroughIds.includes(ch.id as string)"
              class="shrink-0 h-4 w-4"
              @change="toggleReadThrough(ch.id as string)"
            />
            <div class="min-w-0">
              <p class="font-medium truncate text-sm sm:text-base">{{ ch.title || '未命名章节' }}</p>
              <p class="text-xs text-muted-foreground truncate">{{ ch.outline || '无大纲' }}</p>
            </div>
          </div>
          <div class="flex gap-1 sm:gap-2 shrink-0">
            <UiButton size="sm" variant="ghost" aria-label="编辑" @click="goEdit(ch.id as string)">
              <BookOpen class="h-4 w-4" />
            </UiButton>
            <UiButton
              size="sm"
              variant="outline"
              aria-label="生成正文"
              :disabled="loading"
              @click="generateChapterContent(ch.id as string)"
            >
              <Play class="h-4 w-4" />
            </UiButton>
          </div>
        </div>
        <p v-if="!(vol.chapters as unknown[])?.length" class="px-4 py-6 text-center text-sm text-muted-foreground">
          暂无章节
        </p>
      </div>
    </div>

    <div v-if="readThroughIds.length" class="flex items-center gap-2">
      <UiButton size="sm" class="w-full sm:w-auto" :disabled="loading" @click="readThrough">
        全文通读修订 ({{ readThroughIds.length }} 章)
      </UiButton>
    </div>

    <p v-if="generatingTaskId" class="text-sm text-primary flex flex-wrap items-center gap-2">
      <Loader2 class="h-4 w-4 animate-spin" />任务进行中…
      <UiButton size="sm" variant="ghost" @click="cancelCurrentTask">
        <XCircle class="h-4 w-4 mr-1" />取消
      </UiButton>
    </p>
  </div>
</template>
