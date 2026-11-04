<script setup lang="ts">
import { ref } from 'vue';
import { Users, Plus, Edit2, Trash2, Sparkles, Loader2 } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import UiButton from '@/components/ui/UiButton.vue';
import { novelsAPI } from '@/api';

const props = defineProps<{
  novelId: string;
  characters: Array<Record<string, unknown>>;
}>();
const emit = defineEmits<{ update: [] }>();

const isModalOpen = ref(false);
const isGenerating = ref(false);
const editingId = ref<string | null>(null);
const form = ref({ name: '', role: '', personality: '', abilities: '', currentState: '' });

function openModal(c?: Record<string, unknown>) {
  if (c) {
    editingId.value = c.id as string;
    form.value = {
      name: (c.name as string) || '',
      role: (c.role as string) || '',
      personality: ((c.personality as string[]) || []).join('、'),
      abilities: ((c.abilities as { name: string; level: number }[]) || []).map((a) => `${a.name}:${a.level}`).join('、'),
      currentState: (c.currentState as string) || '',
    };
  } else {
    editingId.value = null;
    form.value = { name: '', role: '', personality: '', abilities: '', currentState: '' };
  }
  isModalOpen.value = true;
}

async function save() {
  if (!form.value.name) return toast.error('请输入姓名');
  const data = {
    name: form.value.name,
    role: form.value.role,
    personality: form.value.personality.split(/[,，、]/).filter(Boolean),
    abilities: form.value.abilities.split(/[,，、]/).filter(Boolean).map((a) => {
      const [name, level] = a.split(/[:：]/);
      return { name, level: parseInt(level) || 1 };
    }),
    currentState: form.value.currentState,
  };
  try {
    if (editingId.value) {
      await novelsAPI.updateCharacter(props.novelId, editingId.value, data);
    } else {
      await novelsAPI.createCharacter(props.novelId, data);
    }
    toast.success('已保存');
    isModalOpen.value = false;
    emit('update');
  } catch {
    toast.error('保存失败');
  }
}

async function generate() {
  isGenerating.value = true;
  try {
    await novelsAPI.generateCharacters(props.novelId, { count: 8 });
    toast.success('人物生成完成');
    emit('update');
  } finally {
    isGenerating.value = false;
  }
}

async function remove(id: string) {
  if (!confirm('确定删除？')) return;
  await novelsAPI.deleteCharacter(props.novelId, id);
  emit('update');
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex justify-between">
      <h3 class="font-semibold flex items-center gap-2"><Users class="h-5 w-5" />人物卡</h3>
      <div class="flex gap-2">
        <UiButton variant="outline" size="sm" :disabled="isGenerating" @click="generate">
          <Loader2 v-if="isGenerating" class="h-4 w-4 animate-spin mr-1" />
          <Sparkles v-else class="h-4 w-4 mr-1" />AI 生成
        </UiButton>
        <UiButton size="sm" @click="openModal()"><Plus class="h-4 w-4 mr-1" />添加</UiButton>
      </div>
    </div>
    <div class="grid gap-3 sm:grid-cols-2">
      <div v-for="c in characters" :key="c.id as string" class="rounded-xl border p-4">
        <div class="flex justify-between">
          <div>
            <p class="font-semibold">{{ c.name }}</p>
            <p class="text-xs text-muted-foreground">{{ c.role }}</p>
          </div>
          <div class="flex gap-1">
            <button class="p-1 hover:bg-muted rounded" @click="openModal(c)"><Edit2 class="h-4 w-4" /></button>
            <button class="p-1 hover:bg-destructive/10 text-destructive rounded" @click="remove(c.id as string)"><Trash2 class="h-4 w-4" /></button>
          </div>
        </div>
      </div>
    </div>

    <div v-if="isModalOpen" class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div class="bg-card rounded-xl border p-6 w-full max-w-md space-y-4">
        <h4 class="font-semibold">{{ editingId ? '编辑' : '新建' }}人物</h4>
        <input v-model="form.name" placeholder="姓名" class="w-full border rounded-md px-3 py-2 bg-background" />
        <input v-model="form.role" placeholder="角色定位" class="w-full border rounded-md px-3 py-2 bg-background" />
        <textarea v-model="form.personality" placeholder="性格（逗号分隔）" class="w-full border rounded-md px-3 py-2 bg-background" rows="2" />
        <div class="flex gap-2 justify-end">
          <UiButton variant="outline" @click="isModalOpen = false">取消</UiButton>
          <UiButton @click="save">保存</UiButton>
        </div>
      </div>
    </div>
  </div>
</template>
