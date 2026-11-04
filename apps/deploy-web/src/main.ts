import { createApp } from 'vue';
import { createPinia } from 'pinia';
import SseUi from '@sse/ui';
import '@sse/ui/style.css';
import '@/styles/deploy-theme.css';
import '@/styles/script-apps.css';

import App from './App.vue';
import router from './router';
const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(SseUi);

router.isReady().then(() => {
  app.mount('#app');
});
