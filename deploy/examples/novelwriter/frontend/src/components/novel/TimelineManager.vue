<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { Clock, Plus, Edit2, Trash2, ArrowUpCircle, ArrowDownCircle } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import UiButton from '@/components/ui/UiButton.vue';
import UiModal from '@/components/ui/UiModal.vue';
import { novelsAPI } from '@/api';

export interface TimelineEvent {
  id: string;
  novelId: string;
  title: string;
  description: string | null;
  timeLabel: string | null;
  order: number;
}

const props = defineProps<{ novelId: string }>();

const events = ref<TimelineEvent[]>([]);
const loading = ref(true);
const isModalOpen = ref(false);
const editing = ref<TimelineEvent | null>(null);
const form = ref({ title: '', timeLabel: '', description: '', order: 0 });

const sortedEvents = computed(() => [...events.value].sort((a, b) => a.order - b.order));

async function load() {
  loading.value = true;
  try {
    const res = await novelsAPI.getTimelineEvents(props.novelId);
    events.value = (res.data ?? []).map((e: Record<string, unknown>) => ({
      ...e,
      order: (e.order as number) ?? (e.sortOrder as number) ?? 0,
    })) as TimelineEvent[];
  } catch {
    toast.error('获取时间线失败');
  } finally {
    loading.value = false;
  }
}

watch(() => props.novelId, load, { immediate: true });

function openModal(ev?: TimelineEvent) {
  if (ev) {
    editing.value = ev;
    form.value = { title: ev.title, timeLabel: ev.timeLabel || '', description: ev.description || '', order: ev.order };
  } else {
    editing.value = null;
    const maxOrder = events.value.length ? Math.max(...events.value.map((e) => e.order)) : 0;
    form.value = { title: '', timeLabel: '', description: '', order: maxOrder + 1 };
  }
  isModalOpen.value = true;
}

async function submit() {
  if (!form.value.title.trim()) return toast.error('请输入事件名称');
  try {
    if (editing.value) {
      await novelsAPI.updateTimelineEvent(props.novelId, editing.value.id, form.value);
      toast.success('时间线节点已更新');
    } else {
      await novelsAPI.createTimelineEvent(props.novelId, form.value);
      toast.success('时间线节点添加成功');
    }
    isModalOpen.value = false;
    await load();
  } catch {
    toast.error('保存失败');
  }
}

async function remove(id: string) {
  if (!confirm('确定要删除这个时间节点吗？')) return;
  try {
    await novelsAPI.deleteTimelineEvent(props.novelId, id);
    toast.success('删除成功');
    await load();
  } catch {
    toast.error('删除失败');
  }
}

async function move(ev: TimelineEvent, direction: 'up' | 'down') {
  const list = sortedEvents.value;
  const idx = list.findIndex((e) => e.id === ev.id);
  const target = direction === 'up' ? list[idx - 1] : list[idx + 1];
  if (!target) return;
  try {
    await novelsAPI.updateTimelineEvent(props.novelId, ev.id, { order: target.order });
    await novelsAPI.updateTimelineEvent(props.novelId, target.id, { order: ev.order });
    await load();
  } catch {
    toast.error('移动失败');
  }
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between mb-8">
      <div>
        <h2 class="text-2xl font-bold flex items-center gap-2"><Clock class="w-6 h-6 text-primary" />时间线视图</h2>
        <p class="text-sm text-muted-foreground mt-1">梳理小说的历史年代、大事件流以及人物成长时间节点。</p>
      </div>
      <UiButton @click="openModal()"><Plus class="w-5 h-5 mr-2" />新建节点</UiButton>
    </div>

    <div v-if="loading" class="text-center py-12 text-muted-foreground">加载中...</div>
    <div v-else-if="!sortedEvents.length" class="text-center py-16 border-2 border-dashed rounded-xl text-muted-foreground bg-muted/20">
      <Clock class="w-12 h-12 mx-auto mb-3 opacity-20" />
      <p>暂无时间节点。开始记录您故事中的第一个大事件吧。</p>
    </div>
    <div v-else class="relative border-l-2 border-border ml-4 md:ml-6 pb-4">
      <div v-for="(event, index) in sortedEvents" :key="event.id" class="mb-10 pl-8 relative group">
        <div class="absolute w-4 h-4 rounded-full bg-primary border-4 border-background -left-[9px] top-1.5" />
        <div class="bg-card border p-5 rounded-xl hover:shadow-md transition max-w-3xl relative">
          <div class="absolute top-4 right-4 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <button class="p-1.5 hover:bg-muted rounded disabled:opacity-30" :disabled="index === 0" @click="move(event, 'up')"><ArrowUpCircle class="w-4 h-4" /></button>
            <button class="p-1.5 hover:bg-muted rounded disabled:opacity-30" :disabled="index === sortedEvents.length - 1" @click="move(event, 'down')"><ArrowDownCircle class="w-4 h-4" /></button>
            <button class="p-1.5 hover:bg-muted rounded" @click="openModal(event)"><Edit2 class="w-4 h-4" /></button>
            <button class="p-1.5 hover:bg-destructive/10 text-destructive rounded" @click="remove(event.id)"><Trash2 class="w-4 h-4" /></button>
          </div>
          <div class="pr-24">
            <span v-if="event.timeLabel" class="inline-block px-3 py-1 mb-3 text-xs font-semibold text-primary bg-primary/10 rounded-full">{{ event.timeLabel }}</span>
            <h3 class="text-lg font-bold mb-2">{{ event.title }}</h3>
            <p v-if="event.description" class="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">{{ event.description }}</p>
          </div>
        </div>
      </div>
    </div>

    <UiModal :open="isModalOpen" :title="editing ? '编辑时间节点' : '新建时间节点'" @close="isModalOpen = false">
      <div class="space-y-4">
        <div class="grid grid-cols-3 gap-4">
          <div class="col-span-2">
            <label class="block text-sm font-medium mb-2">发生时间标签 (选填)</label>
            <input v-model="form.timeLabel" class="w-full border rounded-md px-3 py-2 bg-background" placeholder="神魔大战元年" />
          </div>
          <div>
            <label class="block text-sm font-medium mb-2">排序数值</label>
            <input v-model.number="form.order" type="number" class="w-full border rounded-md px-3 py-2 bg-background" />
          </div>
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">事件名称</label>
          <input v-model="form.title" class="w-full border rounded-md px-3 py-2 bg-background" required />
        </div>
        <div>
          <label class="block text-sm font-medium mb-2">事件详情 (选填)</label>
          <textarea v-model="form.description" rows="4" class="w-full border rounded-md px-3 py-2 bg-background resize-none" />
        </div>
        <p class="text-xs text-muted-foreground border-t pt-2">排序数值越小，展示越靠前；也可用卡片箭头微调。</p>
        <div class="flex justify-end gap-2">
          <UiButton variant="ghost" @click="isModalOpen = false">取消</UiButton>
          <UiButton @click="submit">{{ editing ? '保存' : '添加' }}</UiButton>
        </div>
      </div>
    </UiModal>
  </div>
</template>
