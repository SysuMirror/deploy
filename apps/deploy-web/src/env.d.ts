/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BASE_PATH?: string;
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// @sse/ui 的 SlMarkdownView 对 mermaid 做动态 import 并在缺失时降级；
// 本应用不依赖 mermaid，提供声明以通过 vue-tsc 类型检查。
declare module 'mermaid' {
  interface Mermaid {
    initialize(config: Record<string, unknown>): void;
    render(id: string, code: string): Promise<{ svg: string }>;
  }
  const mermaid: Mermaid;
  export default mermaid;
}
