<script setup lang="ts">
/**
 * 脚本应用编辑弹窗（新建 / 编辑共用）。
 *
 * 一个应用下可以挂任意多个「命令组」，每组 = 命令名 + 命令主体 + 若干参数预设。
 * 命令主体按原样拼接执行，所以 `cd .. && python3 xxx.py` 这种也允许写。
 *
 * 列表页（新建）和详情页（编辑）都用它，靠 app 传不传区分模式。
 */
import { reactive, ref, watch } from 'vue';
import {
  scriptsApi,
  ApiError,
  type ScriptApp,
  type ScriptAppInput,
  type ScriptCommand,
  type ScriptCommandInput,
  type ScriptParam,
  type ScriptParamInput,
} from '@/services/api';

const props = defineProps<{
  modelValue: boolean;
  /** 传了就进入编辑模式，否则是新建 */
  app?: ScriptApp | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [v: boolean];
  /** 保存成功后带上后端返回的应用（列表/详情据此刷新） */
  saved: [app: ScriptApp | undefined];
}>();

type ParamForm = {
  flag: string;
  label: string;
  placeholder: string;
  defaultValue: string;
  required: boolean;
  valueMode: 'value' | 'switch';
  inputType: 'text' | 'select';
  /** 下拉候选项，按换行 / 逗号 / 顿号分隔，提交时拆开 */
  optionsText: string;
};

type CommandForm = {
  /** 本地编辑用的稳定 key（新增未保存的命令组也要能 v-for 追踪） */
  key: string;
  name: string;
  description: string;
  mainCommand: string;
  params: ParamForm[];
};

const saving = ref(false);
const editorError = ref('');
const editingId = ref<string | null>(null);

const form = reactive({
  name: '',
  description: '',
  workdir: '',
  enabled: true,
  commands: [] as CommandForm[],
});

let keySeq = 0;
function nextKey() {
  keySeq += 1;
  return `cmd-${keySeq}`;
}

function emptyParam(): ParamForm {
  return {
    flag: '',
    label: '',
    placeholder: '',
    defaultValue: '',
    required: false,
    valueMode: 'value',
    inputType: 'text',
    optionsText: '',
  };
}

function emptyCommand(): CommandForm {
  return { key: nextKey(), name: '', description: '', mainCommand: '', params: [] };
}

function resetForm() {
  form.name = '';
  form.description = '';
  form.workdir = '/root/SSE_Market';
  form.enabled = true;
  form.commands = [emptyCommand()];
}

function paramToForm(p: ScriptParam): ParamForm {
  return {
    flag: p.flag,
    label: p.label,
    placeholder: p.placeholder,
    defaultValue: p.defaultValue,
    required: p.required,
    valueMode: p.valueMode,
    inputType: p.inputType,
    optionsText: p.options.join('\n'),
  };
}

function commandToForm(c: ScriptCommand): CommandForm {
  return {
    key: nextKey(),
    name: c.name,
    description: c.description,
    mainCommand: c.mainCommand,
    params: c.params.map(paramToForm),
  };
}

function applyApp(app: ScriptApp) {
  editingId.value = app.id;
  form.name = app.name;
  form.description = app.description;
  form.workdir = app.workdir;
  form.enabled = app.enabled;
  form.commands = app.commands.length ? app.commands.map(commandToForm) : [emptyCommand()];
}

/** 每次打开都按当前入参重置，避免上一次编辑的残留串进来 */
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    editorError.value = '';
    if (props.app) applyApp(props.app);
    else {
      editingId.value = null;
      resetForm();
    }
  }
);

function addCommand() {
  form.commands.push(emptyCommand());
}

function removeCommand(idx: number) {
  form.commands.splice(idx, 1);
}

function moveCommand(idx: number, delta: number) {
  const to = idx + delta;
  if (to < 0 || to >= form.commands.length) return;
  const [item] = form.commands.splice(idx, 1);
  form.commands.splice(to, 0, item);
}

function addParam(ci: number) {
  form.commands[ci].params.push(emptyParam());
}

function removeParam(ci: number, pi: number) {
  form.commands[ci].params.splice(pi, 1);
}

function parseOptions(text: string): string[] {
  return text
    .split(/[\n,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildCommands(): ScriptCommandInput[] {
  return form.commands
    // 完全空白的命令组直接跳过，避免「点了添加但没填」卡住保存
    .filter((c) => c.name.trim() || c.mainCommand.trim())
    .map((c) => {
      const params: ScriptParamInput[] = c.params
        .filter((p) => p.flag.trim())
        .map((p) => ({
          flag: p.flag.trim(),
          label: p.label.trim(),
          placeholder: p.placeholder.trim(),
          defaultValue: p.defaultValue.trim(),
          required: p.required,
          valueMode: p.valueMode,
          inputType: p.inputType,
          options: p.inputType === 'select' ? parseOptions(p.optionsText) : [],
        }));
      return {
        name: c.name.trim(),
        description: c.description.trim(),
        mainCommand: c.mainCommand.trim(),
        params,
      };
    });
}

async function save() {
  editorError.value = '';
  if (!form.name.trim()) {
    editorError.value = '请填写应用名';
    return;
  }
  if (!form.workdir.trim()) {
    editorError.value = '请填写根目录';
    return;
  }
  const commands = buildCommands();
  if (!commands.length) {
    editorError.value = '至少配置一个命令组（命令名与命令主体都要填）';
    return;
  }
  const blank = commands.find((c) => !c.name || !c.mainCommand);
  if (blank) {
    editorError.value = '每个命令组的「命令名」与「命令主体」都不能为空';
    return;
  }
  const names = commands.map((c) => c.name);
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) {
    editorError.value = `命令组名重复：${dup}`;
    return;
  }
  const payload: ScriptAppInput = {
    name: form.name.trim(),
    description: form.description.trim(),
    workdir: form.workdir.trim(),
    enabled: form.enabled,
    commands,
  };
  saving.value = true;
  try {
    const isEdit = Boolean(editingId.value);
    const res = isEdit
      ? await scriptsApi.update(editingId.value as string, payload)
      : await scriptsApi.create(payload);
    emit('update:modelValue', false);
    // 新建时把后端返回的对象带出去，调用方可以直接跳详情页
    emit('saved', res.app);
  } catch (e) {
    editorError.value = e instanceof ApiError || e instanceof Error ? e.message : '保存失败';
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <SlModal
    :model-value="modelValue"
    :title="editingId ? '编辑脚本应用' : '新建脚本应用'"
    width="820px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="editor">
      <div class="editor__row">
        <SlInput v-model="form.name" label="应用名" placeholder="如 iWiki 部署" />
        <SlInput
          v-model="form.workdir"
          label="根目录"
          placeholder="/root/SSE_Market/iWiki"
          hint="执行前会 cd 到这里；保存时会在宿主机上解析真实路径并校验范围"
        />
      </div>
      <SlInput
        v-model="form.description"
        label="说明（可选）"
        placeholder="一句话说明这个应用做什么"
      />

      <label class="editor__check">
        <input v-model="form.enabled" type="checkbox" />
        <span>启用（停用后不能执行）</span>
      </label>

      <div class="editor__section">
        <div class="editor__section-head">
          <span class="editor__section-title">命令组（{{ form.commands.length }}）</span>
          <button type="button" class="sa-link" @click="addCommand">+ 添加命令组</button>
        </div>

        <div v-for="(c, ci) in form.commands" :key="c.key" class="editor__cmd">
          <div class="editor__cmd-head">
            <span class="editor__cmd-index">#{{ ci + 1 }}</span>
            <div class="editor__cmd-order">
              <button type="button" class="sa-icon-btn" :disabled="ci === 0" @click="moveCommand(ci, -1)">
                ↑
              </button>
              <button
                type="button"
                class="sa-icon-btn"
                :disabled="ci === form.commands.length - 1"
                @click="moveCommand(ci, 1)"
              >
                ↓
              </button>
            </div>
            <button type="button" class="sa-link sa-link--danger" @click="removeCommand(ci)">
              删除该命令组
            </button>
          </div>

          <div class="editor__grid2">
            <label class="mini-field">
              <span>命令名</span>
              <input v-model="c.name" class="sa-input" placeholder="如 部署到测试" />
            </label>
            <label class="mini-field">
              <span>说明（可选）</span>
              <input v-model="c.description" class="sa-input" placeholder="如 拉代码并重启测试站" />
            </label>
          </div>

          <label class="mini-field">
            <span>命令主体</span>
            <input
              v-model="c.mainCommand"
              class="sa-input sa-input--mono"
              placeholder="如 python3 iwiki.py deploy"
            />
          </label>
          <p class="mini-hint">原样拼接执行，可以写 <code>cd .. &amp;&amp; python3 xxx.py</code> 这种。</p>

          <div v-if="c.params.length" class="param-editor">
            <div v-for="(p, pi) in c.params" :key="pi" class="param-editor__row">
              <div class="param-editor__grid">
                <label class="mini-field">
                  <span>参数名</span>
                  <input v-model="p.flag" class="sa-input" placeholder="--target" />
                </label>
                <label class="mini-field">
                  <span>显示名</span>
                  <input v-model="p.label" class="sa-input" placeholder="目标环境" />
                </label>
                <label class="mini-field">
                  <span>输入类型</span>
                  <select v-model="p.inputType" class="sa-input">
                    <option value="text">文本</option>
                    <option value="select">下拉选择</option>
                  </select>
                </label>
                <label class="mini-field">
                  <span>取值方式</span>
                  <select v-model="p.valueMode" class="sa-input">
                    <option value="value">带值（--flag 值）</option>
                    <option value="switch">开关（只拼 --flag）</option>
                  </select>
                </label>
                <label class="mini-field">
                  <span>默认值</span>
                  <input
                    v-model="p.defaultValue"
                    class="sa-input"
                    :placeholder="p.valueMode === 'switch' ? '留空' : '可留空'"
                  />
                </label>
                <label class="mini-field mini-field--check">
                  <input v-model="p.required" type="checkbox" />
                  <span>必填</span>
                </label>
              </div>
              <label v-if="p.inputType === 'select'" class="mini-field mini-field--full">
                <span>候选项（每行一个，或用逗号分隔）</span>
                <textarea v-model="p.optionsText" class="sa-input" rows="2" placeholder="test&#10;prod" />
              </label>
              <div class="param-editor__row-foot">
                <button type="button" class="sa-link sa-link--danger" @click="removeParam(ci, pi)">
                  移除该参数
                </button>
              </div>
            </div>
          </div>

          <button type="button" class="sa-link" @click="addParam(ci)">+ 添加参数</button>
        </div>
      </div>

      <SlAlert v-if="editorError" variant="error">{{ editorError }}</SlAlert>
    </div>

    <template #footer>
      <SlButton class="modal-foot-btn" variant="secondary" size="sm" @click="emit('update:modelValue', false)">
        取消
      </SlButton>
      <SlButton class="modal-foot-btn" size="sm" :loading="saving" @click="save">保存</SlButton>
    </template>
  </SlModal>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.editor__row {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 12px;
}
.editor__check {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
}
.editor__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.editor__section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--deploy-border);
}
.editor__section-title {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--deploy-muted-fg);
}
.editor__cmd {
  padding: 12px 14px;
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius-lg);
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--deploy-muted);
}
.editor__cmd-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.editor__cmd-index {
  font-size: 11.5px;
  font-weight: 700;
  color: var(--deploy-muted-fg);
}
.editor__cmd-order {
  display: flex;
  gap: 4px;
}
.editor__grid2 {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: 10px;
}
.param-editor {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.param-editor__row {
  padding: 10px 12px;
  border: 1px dashed var(--deploy-border-strong);
  border-radius: var(--deploy-radius);
  background: var(--deploy-card);
}
.param-editor__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 8px;
  align-items: end;
}
.mini-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
}
.mini-field--full {
  margin-top: 8px;
}
.mini-field--check {
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding-bottom: 8px;
}
.mini-hint {
  margin: -4px 0 0;
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
}
.mini-hint code {
  font-family: var(--deploy-mono);
  font-size: 12px;
  background: var(--deploy-muted);
  padding: 1px 5px;
  border-radius: 5px;
}
.param-editor__row-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}

@media (max-width: 900px) {
  .editor__row,
  .editor__grid2 {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  /* 参数有 6 个字段，两列在手机上每个只有约 150px，标签和输入框都会挤 */
  .param-editor__grid {
    grid-template-columns: 1fr;
  }
  .param-editor__row {
    padding: 10px;
  }
  .editor__cmd {
    padding: 12px;
  }
  /* 「取消 / 保存」放大到手指可点 */
  .modal-foot-btn {
    min-height: 44px;
    flex: 1 1 auto;
  }
  /* 命令组标题行在窄屏换行，别把「添加」挤出去 */
  .editor__section-head {
    flex-wrap: wrap;
  }
}
</style>
