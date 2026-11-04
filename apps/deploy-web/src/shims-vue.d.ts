declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

declare module '@sse/ui' {
  import type { Plugin } from 'vue';
  const SseUi: Plugin;
  export default SseUi;
}
