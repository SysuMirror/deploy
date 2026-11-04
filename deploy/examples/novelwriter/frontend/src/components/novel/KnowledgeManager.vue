<script setup lang="ts">
import { ref } from 'vue';
import { Database, Upload, FileText, Trash2, Search, Plus, ArrowLeft, Info, Sparkles, Loader2, X, AlertCircle } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { cn } from '@/lib/utils';
import UiButton from '@/components/ui/UiButton.vue';
import UiModal from '@/components/ui/UiModal.vue';
import { knowledgeAPI } from '@/api';

interface KnowledgeBase {
  id: string;
  name: string;
  description?: string;
  type: string;
  documentCount?: number;
}

interface Document {
  id: string;
  title: string;
  content: string;
  fileType: string;
  createdAt?: string;
  similarity?: number;
}

const TYPE_LABELS: Record<string, string> = {
  general: '通用',
  worldview: '世界观',
  character: '人物关系',
  plot: '情节设定',
};

const props = defineProps<{
  novelId: string;
  knowledgeBases: KnowledgeBase[];
}>();
const emit = defineEmits<{ update: [] }>();

const selectedKB = ref<KnowledgeBase | null>(null);
const documents = ref<Document[]>([]);
const searchQuery = ref('');
const isSearching = ref(false);
const searchResults = ref<Document[] | null>(null);
const isCreateOpen = ref(false);
const isUploadOpen = ref(false);
const kbForm = ref({ name: '', description: '', type: 'general' });
const uploadTitle = ref('');
const uploadFile = ref<File | null>(null);

async function loadDocuments(kbId: string) {
  searchResults.value = null;
  searchQuery.value = '';
  try {
    const res = await knowledgeAPI.getDocuments(props.novelId, kbId);
    documents.value = res.data ?? [];
  } catch {
    documents.value = [];
  }
}

function selectKb(kb: KnowledgeBase) {
  selectedKB.value = kb;
  loadDocuments(kb.id);
}

async function createKb() {
  if (!kbForm.value.name) return toast.error('请输入名称');
  try {
    await knowledgeAPI.create(props.novelId, kbForm.value);
    isCreateOpen.value = false;
    kbForm.value = { name: '', description: '', type: 'general' };
    emit('update');
    toast.success('知识库创建成功');
  } catch {
    toast.error('创建失败');
  }
}

async function deleteKb(id: string) {
  if (!confirm('确定要删除这个知识库吗？')) return;
  try {
    await knowledgeAPI.delete(props.novelId, id);
    if (selectedKB.value?.id === id) selectedKB.value = null;
    emit('update');
    toast.success('知识库已删除');
  } catch {
    toast.error('删除失败');
  }
}

async function uploadDoc() {
  if (!selectedKB.value || !uploadFile.value) return;
  const fd = new FormData();
  fd.append('file', uploadFile.value);
  fd.append('title', uploadTitle.value || uploadFile.value.name);
  try {
    await knowledgeAPI.uploadDocument(props.novelId, selectedKB.value.id, fd);
    isUploadOpen.value = false;
    uploadTitle.value = '';
    uploadFile.value = null;
    await loadDocuments(selectedKB.value.id);
    emit('update');
    toast.success('文档上传成功');
  } catch {
    toast.error('上传失败');
  }
}

async function deleteDoc(docId: string) {
  if (!selectedKB.value || !confirm('确定删除文档？')) return;
  try {
    await knowledgeAPI.deleteDocument(props.novelId, selectedKB.value.id, docId);
    if (searchResults.value) searchResults.value = searchResults.value.filter((d) => d.id !== docId);
    else await loadDocuments(selectedKB.value.id);
    emit('update');
    toast.success('文档已删除');
  } catch {
    toast.error('删除失败');
  }
}

async function search() {
  if (!selectedKB.value) return;
  if (!searchQuery.value.trim()) {
    searchResults.value = null;
    return;
  }
  isSearching.value = true;
  try {
    const res = await knowledgeAPI.search(props.novelId, selectedKB.value.id, searchQuery.value);
    searchResults.value = res.data ?? [];
  } catch {
    toast.error('搜索失败');
  } finally {
    isSearching.value = false;
  }
}

function similarityClass(score: number) {
  if (score > 0.8) return 'bg-emerald-500/10 text-emerald-600 border-emerald-200';
  if (score > 0.5) return 'bg-amber-500/10 text-amber-600 border-amber-200';
  return 'bg-gray-500/10 text-gray-600 border-gray-200';
}
</script>

<template>
  <div class="space-y-6">
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl border bg-card/60">
      <div class="flex items-center gap-3">
        <div class="p-2.5 bg-primary/10 rounded-xl"><Database class="w-5 h-5 text-primary" /></div>
        <div>
          <h2 class="text-xl font-bold">知识库管理</h2>
          <p class="text-xs text-muted-foreground">构建专属创作资源，提升 AI 写作的一致性</p>
        </div>
      </div>
      <UiButton size="sm" @click="isCreateOpen = true"><Plus class="w-4 h-4 mr-2" />新建知识库</UiButton>
    </div>

    <div class="grid lg:grid-cols-12 gap-6 items-start">
      <div :class="cn('lg:col-span-4 space-y-3', selectedKB ? 'hidden lg:block' : 'col-span-12')">
        <div v-if="!knowledgeBases.length" class="text-center py-12 border-2 border-dashed rounded-3xl text-muted-foreground">
          <Database class="w-12 h-12 mx-auto mb-4 opacity-20" />
          <p>尚无知识库，立即创建一个开始积累素材</p>
        </div>
        <div v-else class="grid gap-3">
          <div
            v-for="kb in knowledgeBases"
            :key="kb.id"
            :class="cn(
              'p-4 rounded-2xl border-2 cursor-pointer transition-all group',
              selectedKB?.id === kb.id ? 'bg-primary text-primary-foreground border-primary shadow-lg' : 'bg-card hover:border-primary/50',
            )"
            @click="selectKb(kb)"
          >
            <div class="flex gap-3">
              <Database class="w-5 h-5 shrink-0 mt-1" />
              <div class="flex-1 min-w-0">
                <div class="flex justify-between gap-2">
                  <h4 class="font-bold truncate">{{ kb.name }}</h4>
                  <span class="text-[10px] px-2 py-0.5 rounded font-bold uppercase opacity-80">{{ TYPE_LABELS[kb.type] || kb.type }}</span>
                </div>
                <p class="text-xs mt-1 line-clamp-1 opacity-70">{{ kb.description || '无详细描述' }}</p>
                <div class="mt-3 flex justify-between items-center text-[10px] font-bold opacity-80">
                  <span class="flex items-center gap-1"><FileText class="w-3 h-3" />{{ kb.documentCount ?? 0 }} 个文档</span>
                  <button
                    class="p-1.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20"
                    @click.stop="deleteKb(kb.id)"
                  ><Trash2 class="w-3.5 h-3.5" /></button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="selectedKB" class="lg:col-span-8 border rounded-3xl p-6 space-y-6 min-h-[500px] bg-card/80">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-3">
            <button class="lg:hidden p-2 hover:bg-muted rounded-lg" @click="selectedKB = null"><ArrowLeft class="w-5 h-5" /></button>
            <div>
              <h3 class="text-xl font-bold flex items-center gap-2">{{ selectedKB.name }}<Sparkles class="w-4 h-4 text-primary" /></h3>
              <p class="text-xs text-muted-foreground">{{ TYPE_LABELS[selectedKB.type] }} · {{ documents.length }} 个文档</p>
            </div>
          </div>
          <UiButton size="sm" @click="isUploadOpen = true"><Upload class="w-4 h-4 mr-2" />上传文档</UiButton>
        </div>

        <div class="relative">
          <Search class="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            v-model="searchQuery"
            class="w-full pl-12 pr-24 py-3 rounded-2xl border bg-muted/30"
            placeholder="语义搜索：输入问题或关键词…"
            @keydown.enter="search"
          />
          <UiButton class="absolute right-1 top-1 bottom-1" size="sm" :disabled="isSearching" @click="search">
            <Loader2 v-if="isSearching" class="w-4 h-4 animate-spin" />
            <span v-else>搜索</span>
          </UiButton>
        </div>

        <div v-if="searchResults" class="space-y-4">
          <div class="flex justify-between px-2">
            <h4 class="text-sm font-bold text-primary flex items-center gap-2"><Sparkles class="w-4 h-4" />AI 语义匹配 ({{ searchResults.length }})</h4>
            <button class="text-xs text-muted-foreground flex items-center gap-1" @click="searchResults = null">清除 <X class="w-3 h-3" /></button>
          </div>
          <div v-if="!searchResults.length" class="text-center py-10 opacity-50"><AlertCircle class="w-10 h-10 mx-auto mb-2" /><p class="text-sm">未找到高相关性内容</p></div>
          <div v-for="doc in searchResults" :key="doc.id" class="p-5 border-2 rounded-2xl border-primary/30 relative group">
            <span :class="['text-[10px] px-2 py-0.5 rounded-full border font-bold', similarityClass(doc.similarity || 0)]">相关度 {{ Math.round((doc.similarity || 0) * 100) }}%</span>
            <h5 class="font-bold mt-2">{{ doc.title }}</h5>
            <p class="text-sm text-muted-foreground line-clamp-3 mt-2 whitespace-pre-wrap">{{ doc.content }}</p>
            <button class="absolute top-4 right-4 opacity-0 group-hover:opacity-100 text-destructive" @click="deleteDoc(doc.id)"><Trash2 class="w-4 h-4" /></button>
          </div>
        </div>
        <div v-else class="grid gap-3">
          <div v-if="!documents.length" class="text-center py-20 opacity-30"><FileText class="w-16 h-16 mx-auto mb-4" /><p>该知识库暂无文档</p></div>
          <div v-for="doc in documents" :key="doc.id" class="flex items-center justify-between p-4 border rounded-2xl hover:border-primary/50 group">
            <div class="flex gap-4">
              <div class="w-12 h-12 bg-muted rounded-xl flex items-center justify-center text-primary"><FileText class="w-6 h-6" /></div>
              <div>
                <p class="font-bold">{{ doc.title }}</p>
                <span class="text-[10px] text-muted-foreground">{{ doc.fileType }} · {{ doc.createdAt ? new Date(doc.createdAt).toLocaleDateString() : '' }}</span>
              </div>
            </div>
            <button class="p-2 opacity-0 group-hover:opacity-100 text-destructive" @click="deleteDoc(doc.id)"><Trash2 class="w-4 h-4" /></button>
          </div>
        </div>
      </div>
      <div v-else class="hidden lg:flex lg:col-span-8 flex-col items-center justify-center p-12 border border-dashed rounded-3xl text-center text-muted-foreground">
        <Info class="w-10 h-10 mb-4 opacity-50" />
        <h3 class="font-bold">请选择一个知识库</h3>
        <p class="text-sm mt-2 max-w-sm">选择后可管理文档或使用语义搜索召回素材</p>
      </div>
    </div>

    <UiModal :open="isCreateOpen" title="创建知识库" @close="isCreateOpen = false">
      <div class="space-y-4">
        <input v-model="kbForm.name" placeholder="名称" class="w-full border rounded-md px-3 py-2 bg-background" />
        <textarea v-model="kbForm.description" placeholder="描述" class="w-full border rounded-md px-3 py-2 bg-background" rows="2" />
        <select v-model="kbForm.type" class="w-full border rounded-md px-3 py-2 bg-background">
          <option value="general">通用</option>
          <option value="worldview">世界观</option>
          <option value="character">人物关系</option>
          <option value="plot">情节设定</option>
        </select>
        <div class="flex justify-end"><UiButton @click="createKb">创建库</UiButton></div>
      </div>
    </UiModal>

    <UiModal :open="isUploadOpen" title="上传文档" @close="isUploadOpen = false">
      <div class="space-y-4">
        <input v-model="uploadTitle" placeholder="标题（留空使用文件名）" class="w-full border rounded-md px-3 py-2 bg-background" />
        <label class="block p-8 border-2 border-dashed rounded-2xl text-center cursor-pointer hover:border-primary/50 relative">
          <input type="file" accept=".txt,.md" class="absolute inset-0 opacity-0 cursor-pointer" @change="uploadFile = ($event.target as HTMLInputElement).files?.[0] || null" />
          <Upload class="w-10 h-10 mx-auto mb-2 text-primary" />
          <p class="text-sm">{{ uploadFile?.name || '点击选择 TXT / MD 文件' }}</p>
        </label>
        <div class="flex justify-end"><UiButton :disabled="!uploadFile" @click="uploadDoc">开始上传</UiButton></div>
      </div>
    </UiModal>
  </div>
</template>
