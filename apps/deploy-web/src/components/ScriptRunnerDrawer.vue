<script setup lang="ts">
/**
 * 脚本应用运行抽屉：填参数 → 核对完整命令 → 执行 → 实时输出 + 执行历史。
 *
 * 输出用 SSE 回流（POST + fetch 流式读，因为 EventSource 既不能带 Authorization
 * 也不支持 POST），每条 chunk 经 renderAnsi 高亮后再进 DOM（内部已做 HTML 转义）。
 *
 * 关闭抽屉不会终止宿主上正在跑的脚本 —— 那是不可逆的部署动作，
 * 误点关闭就打断会把线上搞成半截状态；要停必须显式点「终止」。
 */
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue';
import { scriptsApi, type ScriptApp, type ScriptCommand, type ScriptRun } from '@/services/api';
import { renderAnsi, stripAnsi } from '@/utils/ansi';
import {
  assembleCommandLine,
  buildFullScript,
  formatRunTime,
  scriptStatusText,
  shellQuote,
} from '@/utils/script-command';

const props = defineProps<{
  modelValue: boolean;
  app: ScriptApp | null;
  /** 打开时默认选中的命令组 */
  commandId: string;
}>();

const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>();

const activeCommandId = ref('');
const runValues = reactive<Record<string, string>>({});
const runStarting = ref(false);
const runError = ref('');
const activeRunId = ref('');
const runStatus = ref('');
const runExitCode = ref<number | null>(null);
const consoleText = ref('');
const consoleEl = ref<HTMLElement | null>(null);
const runs = ref<ScriptRun[]>([]);
const autoScroll = ref(true);
const copied = ref('');
let abortStream: (() => void) | null = null;

const runnerCommand = computed<ScriptCommand | undefined>(() =>
  props.app?.commands.find((c) => c.id === activeCommandId.value)
);

const previewLine = computed(() => {
  const cmd = runnerCommand.value;
  if (!cmd) return '';
  return assembleCommandLine(cmd.mainCommand, cmd.params, runValues);
});

const previewScript = computed(() => buildFullScript(props.app?.workdir ?? '', previewLine.value));

const isRunning = computed(() => runStatus.value === 'running');

/** 控制台高亮 HTML（ANSI + 语义关键字）。v-html 用的内容已在工具里做过转义 */
const consoleHtml = computed(() =>
  consoleText.value ? renderAnsi(consoleText.value) : '（暂无输出）'
);

/** 按入参重置成「刚打开」的状态，并把参数填上默认值 */
function init(commandId: string) {
  const app = props.app;
  if (!app) return;
  activeCommandId.value = commandId || app.commands[0]?.id || '';
  runError.value = '';
  runStatus.value = '';
  runExitCode.value = null;
  consoleText.value = '';
  activeRunId.value = '';
  autoScroll.value = true;
  copied.value = '';
  stopStream();
  const cmd = app.commands.find((c) => c.id === activeCommandId.value);
  for (const key of Object.keys(runValues)) delete runValues[key];
  for (const p of cmd?.params ?? []) {
    runValues[p.id] = p.valueMode === 'switch' ? '' : p.defaultValue;
  }
  void loadRuns(app.id);
}

// 打开时初始化；已打开时外部改了 commandId（比如详情页点了另一个命令组的执行）则切换
watch(
  () => props.modelValue,
  (open) => {
    if (open) init(props.commandId);
    else stopStream();
  },
  { immediate: true }
);
watch(
  () => props.commandId,
  (cid) => {
    if (props.modelValue && props.app && cid && cid !== activeCommandId.value) init(cid);
  }
);

function switchCommand(commandId: string) {
  if (!props.app || commandId === activeCommandId.value) return;
  init(commandId);
}

function closeRunner() {
  // 输出流可以断，宿主上的脚本继续跑（历史里还能点回来看），避免误关打断部署
  stopStream();
  emit('update:modelValue', false);
}

async function loadRuns(appId: string) {
  try {
    const res = await scriptsApi.runs(appId);
    runs.value = res.runs;
  } catch {
    runs.value = [];
  }
}

function appendConsole(text: string) {
  consoleText.value += text;
  if (!autoScroll.value) return;
  void nextTick(() => {
    const el = consoleEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function onConsoleScroll() {
  const el = consoleEl.value;
  if (!el) return;
  // 用户手动往上翻时暂停自动滚屏，回到底部再恢复
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function stopStream() {
  abortStream?.();
  abortStream = null;
}

/** 订阅输出：新执行与「点开历史里正在跑的记录」共用同一条路径（后端会回放已有输出） */
function attachStream(runId: string) {
  stopStream();
  activeRunId.value = runId;
  abortStream = scriptsApi.streamRun(runId, (ev) => {
    if (ev.type === 'replay' && ev.text) consoleText.value = ev.text;
    else if (ev.type === 'chunk' && ev.text) appendConsole(ev.text);
    else if (ev.type === 'end') {
      if (ev.text) appendConsole(`\n${ev.text}\n`);
      runStatus.value = ev.status ?? 'failed';
      runExitCode.value = ev.exitCode ?? null;
      stopStream();
      if (props.app) void loadRuns(props.app.id);
    }
  });
}

async function startRun() {
  const app = props.app;
  const cmd = runnerCommand.value;
  if (!app || !cmd) return;
  runError.value = '';
  consoleText.value = '';
  autoScroll.value = true;
  copied.value = '';
  runStarting.value = true;
  try {
    const res = await scriptsApi.run(app.id, cmd.id, { ...runValues });
    runStatus.value = 'running';
    runExitCode.value = null;
    consoleText.value = `$ ${buildFullScript(res.workdir, res.commandLine)}\n[命令组] ${res.commandName}\n[执行位置] 宿主机 ${res.workdir}\n\n`;
    attachStream(res.runId);
    await loadRuns(app.id);
  } catch (e) {
    runError.value = e instanceof Error ? e.message : '启动失败';
  } finally {
    runStarting.value = false;
  }
}

async function cancelRun() {
  if (!activeRunId.value) return;
  try {
    const res = await scriptsApi.cancelRun(activeRunId.value);
    if (!res.ok) runError.value = res.message;
  } catch (e) {
    runError.value = e instanceof Error ? e.message : '终止失败';
  }
}

/** 点历史记录：正在跑的重新接流，已结束的直接展示存档输出 */
async function openRun(run: ScriptRun) {
  runError.value = '';
  copied.value = '';
  if (run.status === 'running') {
    runStatus.value = 'running';
    runExitCode.value = null;
    consoleText.value = '';
    attachStream(run.id);
    return;
  }
  stopStream();
  activeRunId.value = run.id;
  runStatus.value = run.status;
  runExitCode.value = run.exitCode;
  consoleText.value = '';
  try {
    // 不要在这里再拼一遍 `$ 命令行 / [命令组] / [目录]` 头部：
    // 后端落库的 output 开头已经带了这三行，再拼就是上下两遍重复。
    const res = await scriptsApi.getRun(run.id);
    consoleText.value = res.run.output || '（无输出）';
  } catch (e) {
    runError.value = e instanceof Error ? e.message : '读取输出失败';
  }
}

async function copyText(text: string, tag: string) {
  if (!text) return;
  try {
    // clipboard API 在非 https / 无权限时会抛，回退到 textarea + execCommand
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    copied.value = tag;
    window.setTimeout(() => {
      if (copied.value === tag) copied.value = '';
    }, 1800);
  } catch {
    runError.value = '复制失败，请手动选中复制';
  }
}

/** 复制控制台输出：去掉 ANSI 控制码，否则粘出去是一堆 [0;36m */
function copyOutput() {
  void copyText(stripAnsi(consoleText.value), 'output');
}

/** 复制待执行的完整脚本（含 cd，与真正下发的命令一致） */
function copyCommandLine() {
  void copyText(previewScript.value, 'cmd');
}

/** 复制某次执行的完整脚本 + 元信息 */
function copyRunInfo(run: ScriptRun) {
  void copyText(
    `$ ${buildFullScript(run.workdir, run.commandLine)}\n[命令组] ${run.commandName} · ${run.operatorName}\n[执行位置] 宿主机 ${run.workdir}`,
    `run-${run.id}`
  );
}

watch(
  () => [activeCommandId.value, JSON.stringify(runValues)],
  () => {
    autoScroll.value = true;
  }
);

onUnmounted(() => stopStream());
</script>

<template>
  <Teleport to="body">
    <div v-if="modelValue" class="runner-overlay" @click.self="closeRunner">
      <section class="runner">
        <header class="runner__head">
          <div class="runner__titles">
            <h2 class="runner__title">{{ app?.name }}</h2>
            <p class="runner__sub">
              宿主机 · <code class="sa-code">{{ app?.workdir }}</code>
            </p>
          </div>
          <div class="runner__kinds">
            <button
              v-for="cmd in app?.commands ?? []"
              :key="cmd.id"
              type="button"
              class="kind-tab"
              :class="{ 'kind-tab--on': cmd.id === activeCommandId }"
              @click="switchCommand(cmd.id)"
            >
              {{ cmd.name }}
            </button>
          </div>
          <button type="button" class="runner__close" aria-label="关闭" @click="closeRunner">×</button>
        </header>

        <div class="runner__body">
          <div class="runner__left">
            <div class="sa-panel">
              <p class="sa-panel__title">命令组</p>
              <p class="cmd-brief">
                <strong>{{ runnerCommand?.name }}</strong>
                <span v-if="runnerCommand?.description" class="cmd-brief__desc">
                  {{ runnerCommand.description }}
                </span>
              </p>
              <code class="cmd-brief__main">{{ runnerCommand?.mainCommand }}</code>
            </div>

            <!-- 执行位置：用户最常问「这命令到底在哪台机器、哪个目录跑的」，单独拎出来说清楚 -->
            <div class="sa-panel">
              <p class="sa-panel__title">执行位置</p>
              <div class="where">
                <span class="where__host">宿主机</span>
                <code class="where__dir">{{ app?.workdir }}</code>
                <button
                  type="button"
                  class="sa-link sa-link--sm"
                  title="复制路径"
                  @click="copyText(app?.workdir ?? '', 'dir')"
                >
                  {{ copied === 'dir' ? '已复制' : '复制' }}
                </button>
              </div>
              <p class="where__hint">
                命令经 nsenter 进入宿主命名空间执行（不是跑在本平台容器里），
                上面就是宿主上的真实路径 —— 脚本里写的 docker、宿主的 python3、.env 都能直接用。
              </p>
            </div>

            <div v-if="runnerCommand?.params.length" class="sa-panel">
              <p class="sa-panel__title">参数</p>
              <div class="param-list">
                <div v-for="p in runnerCommand.params" :key="p.id" class="param-item">
                  <label class="param-item__label">
                    {{ p.label || p.flag }}
                    <span v-if="p.required" class="param-item__req">*</span>
                    <code class="param-item__flag">{{ p.flag }}</code>
                  </label>

                  <label v-if="p.valueMode === 'switch'" class="param-switch">
                    <input v-model="runValues[p.id]" type="checkbox" true-value="1" false-value="" />
                    <span>启用该开关</span>
                  </label>

                  <select
                    v-else-if="p.inputType === 'select'"
                    v-model="runValues[p.id]"
                    class="sa-input"
                  >
                    <option value="">（不传）</option>
                    <option v-for="opt in p.options" :key="opt" :value="opt">{{ opt }}</option>
                  </select>

                  <input
                    v-else
                    v-model="runValues[p.id]"
                    class="sa-input"
                    type="text"
                    :placeholder="p.placeholder || (p.required ? '必填' : '留空则不传该参数')"
                  />
                </div>
              </div>
            </div>
            <p v-else class="sa-panel sa-panel--empty">该命令组没有参数，直接执行即可。</p>

            <div class="sa-panel">
              <div class="sa-panel__title-row">
                <p class="sa-panel__title">即将执行的完整命令</p>
                <button type="button" class="sa-link sa-link--sm" @click="copyCommandLine">
                  {{ copied === 'cmd' ? '已复制' : '复制' }}
                </button>
              </div>
              <!-- 分两行给：目录和命令各自独立，比一整条长串更容易核对 -->
              <div class="script-view">
                <div class="script-view__row">
                  <span class="script-view__label">目录</span>
                  <code class="script-view__dir">{{ app?.workdir }}</code>
                </div>
                <div class="script-view__row">
                  <span class="script-view__label">命令</span>
                  <code class="script-view__cmd">{{ previewLine }}</code>
                </div>
              </div>
              <p class="preview__hint">
                实际下发的是 <code>cd {{ shellQuote(app?.workdir ?? '') }} &amp;&amp; …</code>；
                参数拼接规则：命令主体 + 参数名 + 参数值，留空的参数不会拼进去。
              </p>
            </div>

            <div class="runner__actions">
              <SlButton size="sm" :loading="runStarting" :disabled="isRunning" @click="startRun">
                {{ isRunning ? '执行中...' : '执行' }}
              </SlButton>
              <SlButton v-if="isRunning" variant="secondary" size="sm" @click="cancelRun">
                终止
              </SlButton>
            </div>

            <SlAlert v-if="runError" variant="error">{{ runError }}</SlAlert>
          </div>

          <div class="runner__right">
            <div class="console-card">
              <header class="console-card__head">
                <span class="console-card__title">输出</span>
                <span v-if="runStatus" class="sa-chip" :class="`sa-chip--status-${runStatus}`">
                  <span v-if="isRunning" class="sa-live-dot" />
                  {{ scriptStatusText(runStatus) }}
                  <template v-if="runExitCode !== null"> · exit {{ runExitCode }}</template>
                </span>
                <div class="console-card__tools">
                  <label class="console-card__auto">
                    <input v-model="autoScroll" type="checkbox" />
                    自动滚屏
                  </label>
                  <button
                    type="button"
                    class="console-btn"
                    :disabled="!consoleText"
                    @click="copyOutput"
                  >
                    {{ copied === 'output' ? '已复制' : '复制全部' }}
                  </button>
                </div>
              </header>
              <!-- 高亮渲染：renderAnsi 内部已做 HTML 转义，输出里的标签不会被执行 -->
              <pre ref="consoleEl" class="console" @scroll="onConsoleScroll"><code v-html="consoleHtml" /></pre>
            </div>

            <div class="history-card">
              <p class="sa-panel__title">执行历史</p>
              <div v-if="!runs.length" class="history-empty">暂无执行记录</div>
              <ul v-else class="history-list">
                <li v-for="r in runs" :key="r.id">
                  <div class="history-row" :class="{ 'history-row--active': r.id === activeRunId }">
                    <button type="button" class="history-item" @click="openRun(r)">
                      <span class="history-item__main">
                        <span class="sa-chip" :class="`sa-chip--status-${r.status}`">
                          {{ scriptStatusText(r.status) }}
                        </span>
                        <span class="history-item__kind">{{ r.commandName }}</span>
                        <span class="history-item__op">{{ r.operatorName }}</span>
                        <span class="history-item__time">{{ formatRunTime(r.createdAt) }}</span>
                      </span>
                      <!-- 每条都带上「跑的什么命令、在哪个目录」，回看时不用点进去猜。
                           必须带 && ：只并排显示 `cd /a/b` + `pwd && date` 会被读成一条命令 -->
                      <span class="history-item__cmd" :title="buildFullScript(r.workdir, r.commandLine)">
                        <span class="history-item__cd">cd {{ shellQuote(r.workdir) }} &amp;&amp;</span>
                        {{ r.commandLine }}
                      </span>
                    </button>
                    <button
                      type="button"
                      class="sa-link sa-link--sm"
                      title="复制该次执行的完整命令"
                      @click="copyRunInfo(r)"
                    >
                      {{ copied === `run-${r.id}` ? '已复制' : '复制' }}
                    </button>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.runner-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(15, 23, 42, 0.5);
  display: flex;
  justify-content: flex-end;
}
.runner {
  width: min(1220px, 96vw);
  height: 100vh;
  /* 手机上 100vh 是"地址栏收起时"的高度，地址栏可见时抽屉底部会被压到屏幕外，
     固定底部的操作区就点不到了。dvh 跟随实际可视高度（老浏览器忽略这行、退回 vh）。 */
  height: 100dvh;
  background: var(--deploy-bg);
  display: flex;
  flex-direction: column;
  box-shadow: var(--deploy-shadow-lg);
  animation: slide-in 0.2s var(--deploy-ease);
}
@keyframes slide-in {
  from {
    transform: translateX(24px);
    opacity: 0.6;
  }
}
.runner__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--deploy-border);
  background: var(--deploy-card);
}
.runner__titles {
  min-width: 0;
  flex: 1;
}
.runner__title {
  margin: 0;
  font-size: 15px;
  font-weight: 700;
}
.runner__sub {
  margin: 4px 0 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.runner__kinds {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 999px;
  background: var(--deploy-muted);
  flex-shrink: 0;
  max-width: 46%;
  overflow-x: auto;
}
.kind-tab {
  border: none;
  background: transparent;
  padding: 5px 14px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  color: var(--deploy-fg-secondary);
  cursor: pointer;
  white-space: nowrap;
}
.kind-tab--on {
  background: var(--deploy-card);
  color: var(--deploy-fg);
  box-shadow: var(--deploy-shadow);
}
.runner__close {
  border: none;
  background: transparent;
  font-size: 24px;
  line-height: 1;
  color: var(--deploy-fg-secondary);
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 8px;
}
.runner__close:hover {
  background: var(--deploy-muted);
}
.runner__body {
  flex: 1;
  min-height: 0;
  display: grid;
  /* 桌面两栏：左参数、右输出。1fr 用 minmax(0,1fr) 而不是裸 1fr ——
     裸 1fr 的最小值是 auto，内容里的 nowrap（长命令行）会把右栏顶宽、把左侧挤没。 */
  grid-template-columns: minmax(320px, 400px) minmax(0, 1fr);
  gap: 14px;
  padding: 14px 18px 18px;
  overflow: hidden;
}
.runner__left {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  /* grid 子项默认 min-width:auto，内容里的 nowrap 元素（历史命令行、长目录）
     会把轨道顶宽，导致面板整体溢出抽屉、右侧内容被裁掉。必须显式允许收缩。 */
  min-width: 0;
  overflow-y: auto;
}
.runner__right {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  min-width: 0;
}
.runner__actions {
  display: flex;
  gap: 8px;
}
.cmd-brief {
  margin: 0 0 6px;
  font-size: 13.5px;
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}
.cmd-brief__desc {
  font-size: 12px;
  font-weight: 400;
  color: var(--deploy-muted-fg);
}
.cmd-brief__main {
  display: block;
  font-family: var(--deploy-mono);
  font-size: 12px;
  color: var(--deploy-fg-secondary);
  word-break: break-all;
}
.param-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.param-item__label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 5px;
}
.param-item__req {
  color: #dc2626;
}
.param-item__flag {
  font-family: var(--deploy-mono);
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
  font-weight: 400;
}
.param-switch {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 13px;
  color: var(--deploy-fg-secondary);
}
.preview__hint {
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--deploy-muted-fg);
}
.preview__hint code {
  font-family: var(--deploy-mono);
  font-size: 11px;
  word-break: break-all;
}
/* 目录 / 命令分两行给，核对时不用在一长串里找人眼分隔符 */
.script-view {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 11px 12px;
  border-radius: var(--deploy-radius);
  background: #0f172a;
}
.script-view__row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.script-view__label {
  flex-shrink: 0;
  font-size: 11px;
  font-weight: 650;
  color: #64748b;
}
.script-view__dir,
.script-view__cmd {
  font-family: var(--deploy-mono);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-all;
}
.script-view__dir {
  color: #67e8f9;
}
.script-view__cmd {
  color: #e2e8f0;
}
/* —— 执行位置 —— */
.where {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.where__host {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 650;
  background: #e0f2fe;
  color: #0369a1;
}
.where__dir {
  font-family: var(--deploy-mono);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--deploy-fg-secondary);
}
.where__hint {
  margin: 9px 0 0;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--deploy-muted-fg);
}

/* 控制台 */
.console-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius-lg);
  overflow: hidden;
  background: #0b1120;
}
.console-card__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  background: #0f172a;
  border-bottom: 1px solid #1e293b;
}
.console-card__title {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #94a3b8;
}
.console-card__tools {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}
.console-card__auto {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #94a3b8;
}
.console-btn {
  border: 1px solid #334155;
  background: #1e293b;
  color: #cbd5e1;
  border-radius: 6px;
  padding: 3px 10px;
  font-size: 11.5px;
  font-family: inherit;
  cursor: pointer;
}
.console-btn:hover:not(:disabled) {
  background: #334155;
}
.console-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.console {
  flex: 1;
  min-height: 260px;
  margin: 0;
  padding: 12px 14px;
  overflow: auto;
  color: #cbd5e1;
  font-family: var(--deploy-mono);
  font-size: 12px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-all;
}
.console code {
  font-family: inherit;
  white-space: inherit;
}
/* 语义高亮的兜底色（脚本自带 ANSI 颜色时不会被覆盖） */
.console :deep(.ln-bad) {
  color: #fca5a5;
}
.console :deep(.ln-warn) {
  color: #fde68a;
}
.console :deep(.ln-ok) {
  color: #86efac;
}
.console :deep(.ln-info) {
  color: #93c5fd;
}
.history-card {
  flex-shrink: 0;
  max-height: 40%;
  display: flex;
  flex-direction: column;
  background: var(--deploy-card);
  border: 1px solid var(--deploy-border);
  border-radius: var(--deploy-radius-lg);
  padding: 12px 14px;
  overflow: hidden;
}
.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
}
.history-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: var(--deploy-radius);
}
.history-row:hover {
  background: var(--deploy-muted);
}
.history-row--active {
  background: var(--deploy-accent-soft);
}
.history-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border: none;
  border-radius: var(--deploy-radius);
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
}
.history-item__main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
/* 每条历史都带命令行与目录：回看时不用逐条点进去才知道跑的是什么、在哪跑的 */
.history-item__cmd {
  font-family: var(--deploy-mono);
  font-size: 11.5px;
  color: var(--deploy-fg-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.history-item__cd {
  color: #0e7490;
}
.history-item__kind {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.history-item__op {
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
  flex-shrink: 0;
}
.history-item__time {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--deploy-muted-fg);
  font-family: var(--deploy-mono);
  flex-shrink: 0;
}
.history-empty {
  font-size: 12.5px;
  color: var(--deploy-muted-fg);
}

@media (max-width: 900px) {
  /* 单栏不再用 grid：grid 的 auto 行 + 子项 min-height:0 会把左栏压扁，
     左栏内容于是"溢出"到右栏所在的行上，互相盖住（实测「执行」按钮被历史面板挡住点不到）。
     单栏就是一条纵向流：每块取各自的内容高度，由 body 统一滚动。 */
  .runner__body {
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overflow-x: hidden;
  }
  .runner__left,
  .runner__right {
    /* 0 1 auto：不放大、不收缩（收缩就是上面那个盖住的成因），按内容撑高 */
    flex: 0 1 auto;
    min-height: auto;
    overflow-y: visible;
  }
  .runner__kinds {
    max-width: 40%;
  }
}

/* ------------------------------------------------------------------ *
 * 手机端（≤640px）：全屏抽屉、命令组标签独占一行、触控目标放大
 * ------------------------------------------------------------------ */
@media (max-width: 640px) {
  /* 96vw 在手机上会留一条 4% 的缝，看着像"没盖满"且容易误点到底层页面 */
  .runner {
    width: 100vw;
  }

  /* 头部改成两行：第一行标题 + 关闭，第二行命令组标签铺满整行。
     原来标签被限制在 40% 宽里横向滚动，4 个命令组基本没法点。 */
  .runner__head {
    flex-wrap: wrap;
    gap: 10px;
    padding: 12px 14px;
  }
  .runner__titles {
    flex: 1 1 auto;
    order: 1;
    min-width: 0;
  }
  .runner__close {
    order: 2;
    /* 手指点得到：44px 是移动端触控目标的下限 */
    min-width: 44px;
    min-height: 44px;
    margin: -6px -6px 0 0;
  }
  .runner__kinds {
    order: 3;
    flex: 1 1 100%;
    max-width: none;
    border-radius: var(--deploy-radius);
    background: transparent;
    padding: 0;
    scrollbar-width: none;
  }
  .runner__kinds::-webkit-scrollbar {
    display: none;
  }
  .kind-tab {
    min-height: 40px;
    padding: 8px 14px;
    background: var(--deploy-muted);
    border: 1px solid var(--deploy-border);
  }
  .kind-tab--on {
    border-color: var(--deploy-accent);
  }
  /* 「在哪执行」在手机上是关键信息，不能截断成省略号 */
  .runner__sub {
    white-space: normal;
    overflow: visible;
    text-overflow: clip;
    word-break: break-all;
    line-height: 1.5;
  }

  .runner__body {
    padding: 12px 14px 16px;
    gap: 12px;
  }

  /* 输出是手机上最想看的东西：给它一个够高的固定观察区，
     否则一路滚到底只能看到两三行 */
  .console {
    min-height: 46vh;
  }
  .history-card {
    max-height: 46vh;
  }

  .runner__actions :deep(.sl-btn) {
    flex: 1 1 auto;
    min-height: 44px;
  }
  /* 开关型参数：原生 checkbox 只有 13px，手指很容易点空 */
  .param-switch {
    min-height: 44px;
    padding: 0 4px;
    font-size: 14px;
  }
  .param-switch input[type='checkbox'] {
    width: 22px;
    height: 22px;
    flex-shrink: 0;
  }
  /* 目录 / 命令在窄屏下并排会互相挤压，标签提到各自上方 */
  .script-view__row {
    flex-direction: column;
    gap: 2px;
  }
  .where {
    flex-wrap: wrap;
  }
  .where__dir {
    white-space: normal;
    word-break: break-all;
  }
  .param-item__label {
    flex-wrap: wrap;
  }
  .console-card__head {
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 12px;
  }
  .console-card__tools {
    gap: 12px;
  }
  .console-card__auto {
    min-height: 36px;
    font-size: 12.5px;
  }
  .console-card__auto input[type='checkbox'] {
    width: 20px;
    height: 20px;
  }
  .console-btn {
    min-height: 36px;
    padding: 6px 12px;
    font-size: 12.5px;
  }
  .sa-link:not(.sa-link--sm) {
    min-height: 40px;
    padding: 8px 10px;
  }
  .sa-link--sm {
    min-height: 36px;
    padding: 6px 10px;
  }
}
</style>
