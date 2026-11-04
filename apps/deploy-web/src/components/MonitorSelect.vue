<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    options: Array<{ value: string; label: string; hint?: string }>;
    placeholder?: string;
    searchable?: boolean;
    width?: string;
  }>(),
  { placeholder: '全部', searchable: false, width: '' }
);

const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const open = ref(false);
const query = ref('');
const rootEl = ref<HTMLElement | null>(null);

const selected = computed(() => props.options.find((o) => o.value === props.modelValue));
const display = computed(() => selected.value?.label || props.placeholder);
const filtered = computed(() => {
  const kw = query.value.trim().toLowerCase();
  if (!kw) return props.options;
  return props.options.filter(
    (o) => o.label.toLowerCase().includes(kw) || o.value.toLowerCase().includes(kw)
  );
});

function pick(v: string) {
  emit('update:modelValue', v);
  open.value = false;
}
function toggle() {
  open.value = !open.value;
}

function onDocMousedown(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) open.value = false;
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false;
}

watch(open, (v) => {
  if (v) query.value = '';
});
onMounted(() => {
  document.addEventListener('mousedown', onDocMousedown);
  document.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMousedown);
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <div ref="rootEl" class="ms" :style="width ? { width } : undefined">
    <button
      type="button"
      class="ms__trigger"
      :class="{ 'ms__trigger--open': open }"
      @click="toggle"
    >
      <span class="ms__value" :class="{ 'ms__value--ph': !selected }">{{ display }}</span>
      <svg class="ms__chev" :class="{ 'ms__chev--open': open }" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
    <Transition name="ms-pop">
      <div v-if="open" class="ms__panel">
        <div v-if="searchable" class="ms__search">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.5" />
            <path d="M10.4 10.4L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <input v-model="query" type="text" placeholder="搜索…" @keydown.enter.prevent="filtered[0] && pick(filtered[0].value)" />
        </div>
        <div class="ms__list">
          <button
            v-for="o in filtered"
            :key="o.value"
            type="button"
            class="ms__opt"
            :class="{ 'ms__opt--sel': o.value === modelValue }"
            @click="pick(o.value)"
          >
            <span class="ms__opt-main">
              <span class="ms__opt-label">{{ o.label }}</span>
              <span v-if="o.hint" class="ms__opt-hint">{{ o.hint }}</span>
            </span>
            <svg v-if="o.value === modelValue" class="ms__check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M3.5 8.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <div v-if="!filtered.length" class="ms__empty">无匹配项</div>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.ms {
  position: relative;
  width: 100%;
  font-size: 13px;
}
.ms__trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border: 1px solid var(--deploy-border);
  border-radius: 9px;
  background: #fff;
  color: var(--deploy-fg);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}
.ms__trigger:hover {
  border-color: #b9c6d8;
}
.ms__trigger--open {
  border-color: var(--deploy-primary);
  box-shadow: 0 0 0 3px var(--deploy-accent-soft);
}
.ms__value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}
.ms__value--ph {
  color: var(--deploy-muted-fg);
  font-weight: 400;
}
.ms__chev {
  flex: none;
  color: var(--deploy-muted-fg);
  transition: transform 0.18s ease;
}
.ms__chev--open {
  transform: rotate(180deg);
}
.ms__panel {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  min-width: 100%;
  z-index: 60;
  background: #fff;
  border: 1px solid var(--deploy-border);
  border-radius: 11px;
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.14), 0 2px 8px rgba(15, 23, 42, 0.06);
  overflow: hidden;
}
.ms__search {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  border-bottom: 1px solid var(--deploy-border);
  color: var(--deploy-muted-fg);
}
.ms__search input {
  flex: 1;
  border: none;
  outline: none;
  font-family: inherit;
  font-size: 13px;
  color: var(--deploy-fg);
  background: transparent;
}
.ms__list {
  max-height: 264px;
  overflow-y: auto;
  padding: 5px;
}
.ms__opt {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 9px;
  border: none;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  color: var(--deploy-fg);
  transition: background 0.12s ease;
}
.ms__opt:hover {
  background: var(--deploy-muted);
}
.ms__opt--sel {
  background: var(--deploy-accent-soft);
  color: var(--deploy-primary);
}
.ms__opt-main {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ms__opt-label {
  font-size: 13px;
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ms__opt-hint {
  font-size: 11px;
  color: var(--deploy-muted-fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ms__check {
  flex: none;
  color: var(--deploy-primary);
}
.ms__empty {
  padding: 14px 10px;
  text-align: center;
  font-size: 12.5px;
  color: var(--deploy-muted-fg);
}
.ms-pop-enter-active,
.ms-pop-leave-active {
  transition: opacity 0.14s ease, transform 0.14s ease;
}
.ms-pop-enter-from,
.ms-pop-leave-to {
  opacity: 0;
  transform: translateY(-5px) scale(0.98);
}
</style>
