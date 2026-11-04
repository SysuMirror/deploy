<script setup lang="ts">
import { computed } from 'vue';
import type { Deployment } from '@/services/api';

export type PipelineStepState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export type PipelineStep = {
  id: string;
  label: string;
  state: PipelineStepState;
  hint?: string;
};

const props = defineProps<{
  deployment?: Deployment | null;
  idle?: boolean;
}>();

const emit = defineEmits<{
  viewLogs: [];
}>();

const TERMINAL_FAIL = new Set(['failed', 'cancelled']);
const TERMINAL_OK = new Set(['success']);

function hasLog(logs: string, re: RegExp) {
  return re.test(logs || '');
}

type Mark = { state: PipelineStepState; hint?: string };

function buildSteps(d: Deployment): PipelineStep[] {
  const logs = d.logs || '';
  const st = d.status;
  const failed = TERMINAL_FAIL.has(st);
  const success = TERMINAL_OK.has(st);

  const defs: { id: string; label: string; done: boolean; running: boolean; hint?: string; skip?: boolean }[] = [];

  const queued = ['pending'].includes(st);
  const isGit = d.source === 'git';
  const preparingSrc = ['unpacking', 'cloning'].includes(st);
  const agentStarted = hasLog(logs, /\[agent\]|部署 Agent|需要部署 Agent/);
  const agentDone = hasLog(logs, /已写入:|已自动生成|压缩包已有 deploy\.sh|跳过 Agent/);
  const hasDeploySh = hasLog(logs, /deploy\.sh|压缩包已有/);
  const cloneOk = hasLog(logs, /Git 提交:|仓库已下载到本机|git clone|git init|clone --depth/);
  const loginOk = hasLog(logs, /已登录控制面板|sseinfra.*登录|面板登录/);
  const groupOk =
    hasLog(logs, /ensureGroup|创建组|复用组|组=|group /i) ||
    hasLog(logs, /Pod Running/) ||
    ['deploying', 'success'].includes(st);
  const podOk = hasLog(logs, /Pod Running/) || ['deploying', 'success'].includes(st);
  const envOk =
    hasLog(logs, /环境变量|setEnv|MINIO_|SDPY_PUBLIC|pushEnv|注入/) ||
    hasLog(logs, /\[k8s\]|syncPackage|Git 部署/) ||
    st === 'success';
  const transferOk =
    hasLog(logs, /\[k8s\]|syncPackage|传包|kubectl cp|Git 部署|deploy\/run|addDeploy/) ||
    st === 'success';
  const procOk =
    hasLog(logs, /supervisord|RUNNING|进程状态|status=RUNNING/) || st === 'success';
  const gwOk =
    hasLog(logs, /\[gateway\]|modules\.conf|Host 路由|网关|已更新平台网关/) || st === 'success';

  defs.push({
    id: 'queue',
    label: '排队受理',
    done: !queued || success || failed || preparingSrc || st === 'building' || st === 'deploying',
    running: queued,
    hint: '创建部署任务',
  });
  // Git 部署比压缩包多一步「拉取代码」（本机 clone 仓库）。
  if (isGit) {
    defs.push({
      id: 'clone',
      label: '拉取代码',
      done: cloneOk || ['building', 'deploying', 'success'].includes(st) || groupOk,
      running: st === 'cloning' && !cloneOk,
      hint: 'Git clone（带 token）',
    });
  }
  defs.push({
    id: 'source',
    label: isGit ? '准备源码' : '准备源码',
    done:
      agentDone ||
      hasDeploySh ||
      (isGit ? cloneOk : true) ||
      ['building', 'deploying', 'success'].includes(st) ||
      groupOk,
    running: !isGit && (preparingSrc || (st === 'pending' && !queued)),
    hint: isGit ? '校验 deploy.sh' : '解压压缩包',
  });
  defs.push({
    id: 'agent',
    label: 'Agent / deploy.sh',
    done: agentDone || (!agentStarted && ['building', 'deploying', 'success'].includes(st)),
    running: agentStarted && !agentDone && !['deploying', 'success'].includes(st),
    hint: agentStarted ? '生成或校验脚本' : '已有脚本则跳过',
    // Git 部署仓库自带 deploy.sh，不启动 Agent（无论最终成/败都显示“跳过”，而非“失败”）。
    // 非 Git：仅在进入构建/部署/成功且已具备 deploy.sh 时才跳过。
    skip:
      !agentStarted &&
      hasDeploySh &&
      (isGit || ['building', 'deploying', 'success'].includes(st)),
  });
  defs.push({
    id: 'login',
    label: '登录控制面板',
    done: loginOk || groupOk || podOk || success,
    running: st === 'building' && !loginOk && !groupOk,
    hint: 'sseinfra 面板',
  });
  defs.push({
    id: 'group',
    label: '创建 / 复用组',
    done: groupOk || podOk || success,
    running: st === 'building' && loginOk && !groupOk,
    hint: 'POST /add 或复用',
  });
  defs.push({
    id: 'pod',
    label: 'Pod Running',
    done: podOk || success,
    running: groupOk && !podOk && st === 'building',
    hint: '等待调度就绪',
  });
  defs.push({
    id: 'env',
    label: '注入环境变量',
    done: envOk || transferOk || success,
    running: podOk && st === 'deploying' && !envOk,
    hint: 'SDPY_* / MINIO_*',
  });
  defs.push({
    id: 'transfer',
    label: '传包 / Git 部署',
    done: transferOk || procOk || success,
    running: podOk && st === 'deploying' && envOk && !transferOk,
    hint: 'kubectl / deploy run',
  });
  defs.push({
    id: 'proc',
    label: '进程 RUNNING',
    done: procOk || success,
    running: transferOk && st === 'deploying' && !procOk,
    hint: 'supervisord',
  });
  defs.push({
    id: 'gateway',
    label: '刷新网关',
    done: gwOk || success,
    running: procOk && !gwOk && !success && st === 'deploying',
    hint: '路径 + Host 路由',
  });
  defs.push({
    id: 'done',
    label: '完成',
    done: success,
    running: false,
    hint: success ? d.url || '已上线' : failed ? '失败或取消' : undefined,
  });

  function toMark(done: boolean, running: boolean, hint?: string, skip?: boolean): Mark {
    if (skip && (success || done)) return { state: 'skipped', hint: hint || '已跳过' };
    if (failed && running) return { state: 'failed', hint };
    if (failed && done) return { state: 'done', hint };
    if (success || done) return { state: 'done', hint };
    if (running) return { state: 'running', hint };
    return { state: 'pending', hint };
  }

  let steps: PipelineStep[] = defs.map((x) => ({
    id: x.id,
    label: x.label,
    ...toMark(x.done, x.running, x.hint, x.skip),
  }));

  if (failed) {
    const idx = steps.findIndex((s) => s.state === 'running' || s.state === 'pending');
    if (idx >= 0) {
      steps = steps.map((s, i) =>
        i === idx ? { ...s, state: 'failed' as const } : s
      );
    }
  }

  return steps;
}

const idleSteps: PipelineStep[] = [
  { id: 'queue', label: '排队受理', state: 'pending' },
  { id: 'source', label: '准备源码', state: 'pending' },
  { id: 'agent', label: 'Agent / deploy.sh', state: 'pending' },
  { id: 'login', label: '登录控制面板', state: 'pending' },
  { id: 'group', label: '创建 / 复用组', state: 'pending' },
  { id: 'pod', label: 'Pod Running', state: 'pending' },
  { id: 'env', label: '注入环境变量', state: 'pending' },
  { id: 'transfer', label: '传包 / Git 部署', state: 'pending' },
  { id: 'proc', label: '进程 RUNNING', state: 'pending' },
  { id: 'gateway', label: '刷新网关', state: 'pending' },
  { id: 'done', label: '完成', state: 'pending' },
];

const steps = computed(() => (props.deployment ? buildSteps(props.deployment) : idleSteps));

const current = computed(() => steps.value.find((s) => s.state === 'running') || steps.value.find((s) => s.state === 'failed'));

const progress = computed(() => {
  const list = steps.value;
  const done = list.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  return Math.round((done / Math.max(list.length, 1)) * 100);
});

const statusText: Record<PipelineStepState, string> = {
  pending: '待开始',
  running: '进行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
};
</script>

<template>
  <div class="pipeline">
    <div class="pipeline__head">
      <div>
        <h3 class="pipeline__title">部署流水线</h3>
        <p class="pipeline__sub">
          <template v-if="current">当前：{{ current.label }} · {{ statusText[current.state] }}</template>
          <template v-else>共 {{ steps.length }} 步 · 进度 {{ progress }}%</template>
        </p>
      </div>
      <SlButton v-if="deployment" size="sm" variant="secondary" @click="emit('viewLogs')">
        跳到日志
      </SlButton>
    </div>

    <div class="pipeline__bar" aria-hidden="true">
      <div class="pipeline__bar-fill" :style="{ width: `${progress}%` }" />
    </div>

    <ol class="pipeline__steps">
      <li
        v-for="(s, idx) in steps"
        :key="s.id"
        class="pipeline__step"
        :class="`pipeline__step--${s.state}`"
      >
        <div class="pipeline__rail-col" aria-hidden="true">
          <span class="pipeline__dot">{{ idx + 1 }}</span>
          <span v-if="idx < steps.length - 1" class="pipeline__line" />
        </div>
        <div class="pipeline__body">
          <div class="pipeline__label">{{ s.label }}</div>
          <div class="pipeline__meta">
            <span class="pipeline__state">{{ statusText[s.state] }}</span>
            <span v-if="s.hint" class="pipeline__hint">{{ s.hint }}</span>
          </div>
        </div>
      </li>
    </ol>
  </div>
</template>

<style scoped>
.pipeline {
  margin: 0 0 20px;
  padding: 18px 20px;
  border: 1px solid var(--deploy-border);
  border-radius: 14px;
  background: var(--deploy-card);
  box-shadow: var(--deploy-shadow);
}
.pipeline__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.pipeline__title {
  margin: 0;
  font-size: 15px;
  font-weight: 750;
  letter-spacing: -0.02em;
}
.pipeline__sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--deploy-fg-secondary);
}
.pipeline__bar {
  height: 4px;
  border-radius: 999px;
  background: var(--deploy-muted);
  overflow: hidden;
  margin-bottom: 16px;
}
.pipeline__bar-fill {
  height: 100%;
  background: linear-gradient(90deg, #0284c7, #0ea5e9);
  transition: width 0.35s var(--deploy-ease);
}
.pipeline__steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0;
  max-height: 420px;
  overflow: auto;
}
.pipeline__step {
  display: grid;
  grid-template-columns: 36px 1fr;
  gap: 10px;
  min-height: 44px;
}
.pipeline__rail-col {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.pipeline__dot {
  width: 26px;
  height: 26px;
  border-radius: 999px;
  display: grid;
  place-items: center;
  font-size: 11px;
  font-weight: 700;
  border: 2px solid #cbd5e1;
  color: #64748b;
  background: #fff;
  flex-shrink: 0;
}
.pipeline__line {
  flex: 1;
  width: 2px;
  min-height: 12px;
  background: #e2e8f0;
  margin: 2px 0;
}
.pipeline__step--done .pipeline__dot {
  border-color: #12b76a;
  background: #ecfdf3;
  color: #027a48;
}
.pipeline__step--done .pipeline__line {
  background: #12b76a;
}
.pipeline__step--running .pipeline__dot {
  border-color: #2e90fa;
  background: #eff8ff;
  color: #175cd3;
  box-shadow: 0 0 0 3px rgba(46, 144, 250, 0.2);
  animation: pulse 1.2s ease infinite;
}
.pipeline__step--failed .pipeline__dot {
  border-color: #f04438;
  background: #fef3f2;
  color: #b42318;
}
.pipeline__step--skipped .pipeline__dot {
  border-color: #94a3b8;
  background: #f8fafc;
  color: #94a3b8;
}
.pipeline__label {
  font-size: 13px;
  font-weight: 650;
  line-height: 1.3;
  padding-top: 3px;
}
.pipeline__meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  font-size: 11px;
  color: #667085;
  margin-top: 2px;
  padding-bottom: 10px;
}
.pipeline__state {
  font-weight: 600;
}
.pipeline__hint {
  opacity: 0.85;
}
@keyframes pulse {
  50% {
    box-shadow: 0 0 0 5px rgba(46, 144, 250, 0.08);
  }
}
</style>
