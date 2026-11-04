<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { toast } from 'vue-sonner';
import { RouterLink } from 'vue-router';
import { ArrowLeft, Sparkles, User, Settings2, Trash2, Star, Plus, Brain, Cpu } from 'lucide-vue-next';
import AppShell from '@/components/layout/AppShell.vue';
import UiButton from '@/components/ui/UiButton.vue';
import UiCard from '@/components/ui/UiCard.vue';
import { aiConfigAPI, API_URL } from '@/api';

const userForm = ref({ name: '', email: '' });
const configs = ref<Array<Record<string, unknown>>>([]);

const providerPresets = [
  { label: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  { label: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-pro' },
  { label: 'Anthropic', provider: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-6' },
];

const formData = ref({
  provider: 'openai',
  model: 'gpt-4.1-mini',
  apiKey: '',
  baseUrl: 'https://api.openai.com/v1',
  temperature: 0.7,
  maxTokens: 1000000,
  purpose: 'default' as string,
  thinking: true,
  reasoningEffort: 'high' as string,
});

const isDeepSeek = computed(() =>
  formData.value.provider === 'deepseek' || formData.value.baseUrl.includes('deepseek.com')
);

function selectPreset(preset: typeof providerPresets[0]) {
  formData.value.provider = preset.provider;
  formData.value.baseUrl = preset.baseUrl;
  formData.value.model = preset.model;
}

onMounted(async () => {
  try {
    const token = localStorage.getItem('token') || '';
    const res = await fetch(`${API_URL}/api/auth/get_user`, {
      credentials: 'include',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    const data = await res.json();
    const u = data.user?.[0];
    if (u) userForm.value = { name: u.name || '', email: u.email || '' };
  } catch {
    /* optional */
  }
  const cfg = await aiConfigAPI.list();
  configs.value = cfg.data ?? [];
});

async function saveUser() {
  const token = localStorage.getItem('token') || '';
  await fetch(`${API_URL}/api/auth/update_user`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    credentials: 'include',
    body: JSON.stringify(userForm.value),
  });
  toast.success('资料已保存');
}

async function saveConfig() {
  const params: Record<string, unknown> = {
    temperature: formData.value.temperature,
    maxTokens: formData.value.maxTokens,
  };
  if (isDeepSeek.value) {
    params.thinking = formData.value.thinking;
    params.reasoningEffort = formData.value.thinking ? formData.value.reasoningEffort : '';
  }
  await aiConfigAPI.create({
    provider: formData.value.provider,
    model: formData.value.model,
    apiKey: formData.value.apiKey,
    baseUrl: formData.value.baseUrl,
    parameters: params,
    purpose: formData.value.purpose,
  });
  toast.success('配置已添加');
  const cfg = await aiConfigAPI.list();
  configs.value = cfg.data ?? [];
}

async function setDefault(id: string) {
  await aiConfigAPI.setDefault(id);
  toast.success('已设为默认');
  const cfg = await aiConfigAPI.list();
  configs.value = cfg.data ?? [];
}

async function removeConfig(id: string) {
  if (!confirm('删除此配置？')) return;
  await aiConfigAPI.delete(id);
  const cfg = await aiConfigAPI.list();
  configs.value = cfg.data ?? [];
}
</script>

<template>
  <AppShell>
    <div class="page-container">
      <RouterLink to="/" class="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6">
        <ArrowLeft class="h-4 w-4" />返回
      </RouterLink>

      <div class="flex items-center gap-3 mb-8">
        <div class="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
          <Settings2 class="h-5 w-5 text-primary" />
        </div>
        <h1 class="text-2xl font-bold tracking-tight">系统设置</h1>
      </div>

      <div class="space-y-6">
        <UiCard class="p-6">
          <div class="flex items-center gap-2.5 mb-5">
            <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <User class="h-4 w-4 text-primary" />
            </div>
            <h2 class="font-bold">用户资料</h2>
          </div>
          <div class="space-y-3">
            <input v-model="userForm.name" placeholder="昵称" class="input-field" />
            <input v-model="userForm.email" placeholder="邮箱" class="input-field" />
            <UiButton @click="saveUser" size="sm">保存资料</UiButton>
          </div>
        </UiCard>

        <UiCard class="p-6">
          <div class="flex items-center gap-2.5 mb-5">
            <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles class="h-4 w-4 text-primary" />
            </div>
            <h2 class="font-bold">AI 模型配置</h2>
          </div>

          <!-- Provider presets -->
          <div class="flex flex-wrap gap-2 mb-4">
            <button
              v-for="p in providerPresets"
              :key="p.provider"
              type="button"
              :class="[
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors',
                formData.provider === p.provider
                  ? 'bg-primary/10 border-primary/40 text-primary'
                  : 'border-border hover:bg-muted/60 text-muted-foreground'
              ]"
              @click="selectPreset(p)"
            >
              <Cpu class="h-3 w-3" />{{ p.label }}
            </button>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <input v-model="formData.provider" placeholder="Provider (如 openai, deepseek)" class="input-field" />
            <input v-model="formData.model" placeholder="Model (如 deepseek-v4-pro)" class="input-field" />
            <input v-model="formData.apiKey" type="password" placeholder="API Key" class="input-field sm:col-span-2" />
            <input v-model="formData.baseUrl" placeholder="Base URL" class="input-field sm:col-span-2" />
            <div>
              <label class="block text-xs text-muted-foreground mb-1.5">Temperature</label>
              <input v-model.number="formData.temperature" type="number" step="0.1" min="0" max="2" class="input-field" />
            </div>
            <div>
              <label class="block text-xs text-muted-foreground mb-1.5">Max Tokens</label>
              <input v-model.number="formData.maxTokens" type="number" min="1" class="input-field" />
            </div>
          </div>

          <!-- DeepSeek-specific options -->
          <div v-if="isDeepSeek" class="mt-4 p-4 rounded-xl border border-border/50 bg-muted/30 space-y-3">
            <div class="flex items-center gap-2 text-sm font-medium">
              <Brain class="h-4 w-4 text-primary" />DeepSeek 高级设置
            </div>
            <label class="flex items-center gap-3 cursor-pointer">
              <input v-model="formData.thinking" type="checkbox" class="h-4 w-4 rounded border-border text-primary focus:ring-primary/20" />
              <span class="text-sm">启用深度思考 (Thinking)</span>
            </label>
            <div v-if="formData.thinking">
              <label class="block text-xs text-muted-foreground mb-1.5">推理力度 (Reasoning Effort)</label>
              <select v-model="formData.reasoningEffort" class="input-field">
                <option value="high">High — 深度推理，适合复杂创作决策</option>
                <option value="medium">Medium — 均衡推理</option>
                <option value="low">Low — 快速响应</option>
              </select>
            </div>
          </div>

          <UiButton @click="saveConfig" size="sm" class="mt-4">
            <Plus class="h-4 w-4" />添加配置
          </UiButton>

          <div v-if="configs.length" class="mt-6 space-y-3">
            <div
              v-for="c in configs"
              :key="c.id as string"
              class="flex items-center justify-between rounded-xl border border-border/50 p-4 bg-muted/30"
            >
              <div>
                <p class="font-semibold text-sm">{{ c.provider }} / {{ c.model }}</p>
                <p class="text-xs text-muted-foreground mt-0.5">
                  {{ c.baseUrl }}
                  <span v-if="(c.parameters as Record<string,unknown>)?.thinking" class="ml-2 text-primary font-medium">深度思考</span>
                </p>
                <p v-if="c.isDefault" class="text-xs text-primary font-medium flex items-center gap-1 mt-0.5">
                  <Star class="h-3 w-3" />默认配置
                </p>
              </div>
              <div class="flex gap-2">
                <UiButton size="sm" variant="outline" @click="setDefault(c.id as string)">设为默认</UiButton>
                <UiButton size="sm" variant="destructive" @click="removeConfig(c.id as string)">
                  <Trash2 class="h-4 w-4" />
                </UiButton>
              </div>
            </div>
          </div>
        </UiCard>
      </div>
    </div>
  </AppShell>
</template>
