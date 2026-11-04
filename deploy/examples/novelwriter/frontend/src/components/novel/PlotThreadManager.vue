<script setup lang="ts">
import { ref, watch } from 'vue';
import { Bookmark, Plus, Edit2, Trash2, CheckCircle2, CircleDashed, XCircle } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import UiButton from '@/components/ui/UiButton.vue';
import UiModal from '@/components/ui/UiModal.vue';
import { novelsAPI } from '@/api';

export interface PlotThread {
  id: string;
  novelId: string;
  title: string;
  content: string | null;
  status: 'open' | 'resolved' | 'dropped';
  createdAt?: string;
  updatedAt?: string;
}

const props = defineProps<{ novelId: string }>();

const threads = ref<PlotThread[]>([]);
const loading = ref(true);
const isModalOpen = ref(false);
const editing = ref<PlotThread | null>(null);
const form = ref({ title: '', content: '', status: 'open' as PlotThread['status'] });

const statusOptions = [
  { value: 'open' as const, label: '未回收 (进行中)', icon: CircleDashed, color: 'text-blue-500' },
  { value: 'resolved' as const, label: '已回收 (填坑完毕)', icon: CheckCircle2, color: 'text-green-500' },
  { value: 'dropped' as const, label: '已废弃 (剧情修改废弃)', icon: XCircle, color: 'text-red-500' },
];

async function load() {
  loading.value = true;
  try {
    const res = await novelsAPI.getPlotThreads(props.novelId);
    threads.value = res.data ?? [];
  } catch {
    toast.error('获取伏笔列表失败');
  } finally {
    loading.value = false;
  }
}

watch(() => props.novelId, load, { immediate: true });

function openModal(t?: PlotThread) {
  if (t) {
    editing.value = t;
    form.value = { title: t.title, content: t.content || '', status: t.status };
  } else {
    editing.value = null;
    form.value = { title: '', content: '', status: 'open' };
  }
  isModalOpen.value = true;
}

async function submit() {
  if (!form.value.title.trim()) return toast.error('请输入伏笔标题/简述');
  try {
    if (editing.value) {
      await novelsAPI.updatePlotThread(props.novelId, editing.value.id, form.value);
      toast.success('伏笔已更新');
    } else {
      await novelsAPI.createPlotThread(props.novelId, form.value);
      toast.success('伏笔添加成功');
    }
    isModalOpen.value = false;
    await load();
  } catch {
    toast.error('保存失败');
  }
}

async function remove(id: string) {
  if (!confirm('确定要删除这条伏笔记录吗？')) return;
  try {
    await novelsAPI.deletePlotThread(props.novelId, id);
    toast.success('伏笔已删除');
    await load();
  } catch {
    toast.error('删除失败');
  }
}

function statusLabel(status: PlotThread['status']) {
  if (status === 'resolved') return '已回收';
  if (status === 'dropped') return '已废弃';
  return '未回收';
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-6">
      <div>
        <h2 class="text-2xl font-bold flex items-center gap-2">
          <Bookmark class="w-6 h-6 text-primary" />伏笔追踪
        </h2>
        <p class="text-sm text-muted-foreground mt-1">记录并追踪故事中埋下的伏笔及支线任务进度。</p>
      </div>
      <UiButton @click="openModal()"><Plus class="w-5 h-5 mr-2" />新增伏笔</UiButton>
    </div>

    <div v-if="loading" class="text-center py-12 text-muted-foreground">加载中...</div>
    <div
      v-else-if="!threads.length"
      class="text-center py-16 border-2 border-dashed rounded-xl text-muted-foreground bg-muted/20"
    >
      <Bookmark class="w-12 h-12 mx-auto mb-3 opacity-20" />
      <p>暂无伏笔记录。在这里可以记录您在前期埋下的坑，防止后期遗忘。</p>
    </div>
    <div v-else class="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
      <div
        v-for="thread in threads"
        :key="thread.id"
        class="bg-card border p-5 rounded-xl hover:shadow-md transition relative group"
      >
        <div class="flex items-start justify-between mb-3">
          <div class="flex items-center gap-2 min-w-0">
            <CircleDashed v-if="thread.status === 'open'" class="w-4 h-4 text-blue-500 shrink-0" />
            <CheckCircle2 v-else-if="thread.status === 'resolved'" class="w-4 h-4 text-green-500 shrink-0" />
            <XCircle v-else class="w-4 h-4 text-red-500 shrink-0" />
            <h3 class="font-bold line-clamp-1">{{ thread.title }}</h3>
          </div>
          <div class="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            <button class="p-1.5 hover:bg-muted rounded" @click="openModal(thread)"><Edit2 class="w-3.5 h-3.5" /></button>
            <button class="p-1.5 hover:bg-destructive/10 text-destructive rounded" @click="remove(thread.id)"><Trash2 class="w-3.5 h-3.5" /></button>
          </div>
        </div>
        <p class="text-sm font-medium mb-3" :class="thread.status === 'resolved' ? 'text-green-600' : thread.status === 'dropped' ? 'text-red-600' : 'text-blue-600'">
          {{ statusLabel(thread.status) }}
        </p>
        <p v-if="thread.content" class="text-sm text-muted-foreground line-clamp-3 bg-muted/30 p-3 rounded-lg">{{ thread.content }}</p>
      </div>
    </div>

    <UiModal :open="isModalOpen" :title="editing ? '编辑伏笔' : '新增伏笔'" @close="isModalOpen = false">
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium mb-2">伏笔标题/简述</label>
          <input v-model="form.title" class="w-full border rounded-md px-3 py-2 bg-background" placeholder="例如：后山神秘山洞里的声音" />
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">状态</label>
          <div class="flex gap-2">
            <button
              v-for="opt in statusOptions"
              :key="opt.value"
              type="button"
              :class="[
                'flex flex-col items-center flex-1 p-3 rounded-xl border text-xs font-medium transition',
                form.status === opt.value ? 'border-primary bg-primary/10' : 'border-border hover:border-primary/30',
              ]"
              @click="form.status = opt.value"
            >
              <component :is="opt.icon" :class="['w-5 h-5 mb-1', form.status === opt.value ? opt.color : 'text-muted-foreground']" />
              {{ opt.label }}
            </button>
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">详细说明 (选填)</label>
          <textarea v-model="form.content" rows="4" class="w-full border rounded-md px-3 py-2 bg-background resize-none" placeholder="记录伏笔埋在哪一章…" />
        </div>
        <div class="flex justify-end gap-2 pt-2">
          <UiButton variant="ghost" @click="isModalOpen = false">取消</UiButton>
          <UiButton @click="submit">{{ editing ? '保存' : '添加' }}</UiButton>
        </div>
      </div>
    </UiModal>
  </div>
</template>
