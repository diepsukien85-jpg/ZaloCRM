import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router/index';
import { vuetify } from './plugins/vuetify';
import { setFeatures } from './plugin-api';
import './assets/tokens.css';
import './assets/main.css';
import './assets/rbac-page.css';
// Giao diện đồng bộ App nội bộ (bot-noi-bo) — nạp SAU cùng để ghi đè kiểu Smax cũ.
import './assets/noibo-theme.css';

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(vuetify);

// Optional UI plugin bundle — chỉ có ở build mở rộng (VITE_EDITION=enterprise).
// Build mặc định không cài bundle này; @vite-ignore để build không lỗi resolve.
if (import.meta.env.VITE_EDITION === 'enterprise') {
  const bundle = '@zalocrm/enterprise-ui';
  import(/* @vite-ignore */ bundle)
    .then((mod) => mod.setupAll?.({ router }))
    .catch(() => console.info('[plugins] no UI plugin bundle present'));
}

app.mount('#app');

// Nạp danh sách feature đang bật để các ExtensionSlot có requiresFeature biết hiển thị.
fetch('/api/v1/license')
  .then((r) => r.json())
  .then((d) => setFeatures(Array.isArray(d?.features) ? d.features : []))
  .catch(() => { /* mặc định không feature nào */ });

// Prefetch chunk các tab chính khi trình duyệt rảnh → chuyển tab gần như tức thì
// (chunk tải nền sẵn vào cache thay vì tải lúc bấm tab). Đặc biệt hữu ích khi
// server ở xa (độ trễ mạng cao). Bọc try để lỗi prefetch không ảnh hưởng app.
function prefetchMainViews() {
  const load = (fn: () => Promise<unknown>) => fn().catch(() => {});
  load(() => import('@/views/ChatView.vue'));
  load(() => import('@/views/FriendsView.vue'));
  load(() => import('@/views/ContactsView.vue'));
  load(() => import('@/views/AppointmentsView.vue'));
  load(() => import('@/views/DashboardView.vue'));
}
type IdleWin = Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void };
const w = window as IdleWin;
if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(prefetchMainViews, { timeout: 4000 });
else setTimeout(prefetchMainViews, 2500);

// TODO: Re-enable PWA when vite-plugin-pwa supports vite 8
// if ('serviceWorker' in navigator) {
//   import('virtual:pwa-register').then(({ registerSW }) => {
//     registerSW({ immediate: true });
//   });
// }
