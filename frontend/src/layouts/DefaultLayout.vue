<template>
  <v-app class="smax-app nb-app">
    <!-- ════════ MENU DỌC (đồng bộ App nội bộ: navy, có nhóm, thu gọn được) ════════ -->
    <v-navigation-drawer
      permanent
      :rail="collapsed"
      :width="248"
      :rail-width="68"
      class="nb-sidebar"
      :class="{ 'nb-sidebar--rail': collapsed }"
    >
      <div class="nb-sidebar-header">
        <RouterLink to="/" class="nb-logo" title="ZaloCRM">
          <span class="nb-logo-icon"><img src="/brand/zalocrm-logo.png" alt="" /></span>
          <span v-if="!collapsed" class="nb-logo-text">Zalo<b>CRM</b></span>
        </RouterLink>
        <button
          v-if="!collapsed"
          class="nb-collapse-btn"
          type="button"
          title="Thu gọn menu"
          aria-label="Thu gọn menu"
          @click="toggleCollapsed"
        >
          <v-icon size="18">mdi-chevron-double-left</v-icon>
        </button>
      </div>
      <button
        v-if="collapsed"
        class="nb-expand-btn"
        type="button"
        title="Mở rộng menu"
        aria-label="Mở rộng menu"
        @click="toggleCollapsed"
      >
        <v-icon size="18">mdi-chevron-double-right</v-icon>
      </button>

      <nav class="nb-nav" aria-label="Menu chính">
        <template v-for="(group, gi) in NAV_GROUPS" :key="gi">
          <div v-if="group.label && !collapsed" class="nb-nav-label">{{ group.label }}</div>
          <div v-else-if="group.label" class="nb-nav-divider" />
          <RouterLink
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            class="nb-nav-item"
            :class="{ active: isNavActive(item, route.path) }"
            :title="collapsed ? item.label : undefined"
          >
            <v-icon size="20" class="nb-nav-ic">{{ item.icon }}</v-icon>
            <span v-if="!collapsed" class="nb-nav-text">{{ item.label }}</span>
          </RouterLink>
        </template>
      </nav>

      <template #append>
        <v-menu location="end bottom" offset="8">
          <template #activator="{ props: act }">
            <button class="nb-user" type="button" v-bind="act" :title="authStore.user?.fullName || 'Tài khoản'">
              <span class="nb-user-avatar">{{ initials }}</span>
              <span v-if="!collapsed" class="nb-user-info">
                <span class="nb-user-name">{{ authStore.user?.fullName || 'Tài khoản' }}</span>
                <span class="nb-user-role">{{ roleLabel }}</span>
              </span>
              <v-icon v-if="!collapsed" size="16" class="nb-user-caret">mdi-dots-vertical</v-icon>
            </button>
          </template>
          <v-list density="compact" min-width="220">
            <v-list-item :title="authStore.user?.fullName || ''" :subtitle="authStore.user?.email || ''" />
            <v-divider class="my-1" />
            <v-list-item to="/settings/personal/profile" title="Hồ sơ của tôi" prepend-icon="mdi-account-circle-outline" />
            <v-list-item to="/profile" title="Hồ sơ nick Zalo" prepend-icon="mdi-card-account-details-outline" />
            <v-divider class="my-1" />
            <v-list-item title="Đăng xuất" prepend-icon="mdi-logout" base-color="error" @click="logout" />
          </v-list>
        </v-menu>
      </template>
    </v-navigation-drawer>

    <!-- ════════ THANH TRÊN (mỏng, trắng) ════════ -->
    <v-app-bar flat :height="52" class="nb-topbar">
      <div class="nb-topbar-title">{{ pageTitle }}</div>
      <div class="nb-topbar-spacer" />
      <!--
        ATTRIBUTION BANNER — moved into DashboardView per copyright holder
        (dmman16pn@gmail.com). Rendering still required by Apache 2.0 §4(d);
        see src/views/DashboardView.vue and src/composables/use-attribution.ts.
      -->
      <GlobalSearch class="nb-topbar-search" />
      <!-- Điểm mở rộng UI: plugin có thể chèn action vào topbar. Rỗng nếu không có plugin. -->
      <ExtensionSlot name="topbar.actions" />
      <NotificationBell class="nb-icon-btn-wrap" />
    </v-app-bar>

    <!-- ════════ MAIN ════════ -->
    <v-main class="smax-main nb-main">
      <div :key="route.path.split('/')[1] || 'home'" class="nb-page-enter nb-page" :class="{ 'nb-page--padded': padded }">
        <slot />
      </div>
    </v-main>

    <!-- Popup nổi: hỏi AI về tình trạng khách hàng hôm nay -->
    <AiDailyBriefPopup />

    <!-- Global toast queue -->
    <ToastContainer />
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { useTheme } from 'vuetify';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import NotificationBell from '@/components/NotificationBell.vue';
import GlobalSearch from '@/components/GlobalSearch.vue';
import ToastContainer from '@/components/ui/ToastContainer.vue';
import ExtensionSlot from '@/components/ExtensionSlot.vue';
import AiDailyBriefPopup from '@/components/ai/ai-daily-brief-popup.vue';
import { NAV_GROUPS, isNavActive, activeNavLabel } from '@/constants/nav-menu';

const theme = useTheme();
const route = useRoute();
const router = useRouter();
const authStore = useAuthStore();

// Chỉ giao diện sáng (App nội bộ không có giao diện tối). Xoá lựa chọn tối cũ nếu còn lưu.
onMounted(() => {
  theme.global.name.value = 'smax-light';
  try { localStorage.setItem('theme', 'smax-light'); } catch { /* bỏ qua */ }
});

// Menu thu gọn: nhớ lựa chọn; lần đầu tự thu gọn nếu màn hình < 1400px (trang Tin nhắn cần chỗ).
// Màn hình < 1200px luôn thu gọn (menu mở rộng làm các trang nhiều cột bị chật).
const COLLAPSE_KEY = 'nb-sidebar-collapsed';
function initialCollapsed(): boolean {
  if (window.innerWidth < 1200) return true;
  try {
    const saved = localStorage.getItem(COLLAPSE_KEY);
    if (saved !== null) return saved === '1';
  } catch { /* bỏ qua */ }
  return window.innerWidth < 1400;
}
const collapsed = ref(initialCollapsed());
function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  try { localStorage.setItem(COLLAPSE_KEY, collapsed.value ? '1' : '0'); } catch { /* bỏ qua */ }
}

const pageTitle = computed(() => activeNavLabel(route.path) || 'ZaloCRM');
// Trang không tự canh lề (nội dung dính sát menu / mép phải) → layout thêm lề.
const PADDED = ['/automation', '/analytics', '/reports', '/profile'];
const padded = computed(() => PADDED.some((p) => route.path === p || (p !== '/automation' && route.path.startsWith(p + '/'))));

// Mục menu đang chọn luôn nằm trong vùng nhìn thấy (menu dài hơn màn hình thấp).
watch(() => route.path, () => nextTick(() => {
  document.querySelector('.nb-nav-item.active')?.scrollIntoView({ block: 'nearest' });
}), { immediate: true });

const initials = computed(() => {
  const name = authStore.user?.fullName || 'U';
  return name.split(' ').map((p) => p[0]).slice(-2).join('').toUpperCase();
});
const roleLabel = computed(() => ({ owner: 'Chủ tổ chức', admin: 'Quản trị', member: 'Nhân viên' } as Record<string, string>)[authStore.user?.role || ''] || authStore.user?.role || '');

function logout() {
  authStore.logout();
  router.push('/login');
}
</script>

<style scoped>
/* ── Menu dọc ── */
.nb-sidebar {
  background: var(--nb-sidebar) !important;
  color: var(--nb-sidebar-text) !important;
  border: none !important;
}
.nb-sidebar :deep(.v-navigation-drawer__content) { display: flex; flex-direction: column; overflow-y: auto; overflow-x: hidden; }
.nb-sidebar-header {
  display: flex; align-items: center; gap: 8px;
  padding: 16px 14px 12px;
}
.nb-logo { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; text-decoration: none; color: #fff; }
.nb-logo-icon {
  width: 40px; height: 40px; flex-shrink: 0;
  border-radius: var(--nb-radius-md);
  background: linear-gradient(135deg, var(--nb-primary), var(--nb-accent));
  box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);
  display: flex; align-items: center; justify-content: center; padding: 5px;
}
.nb-logo-icon img { width: 100%; height: 100%; object-fit: contain; background: #fff; border-radius: 7px; }
.nb-logo-text { font-size: 18px; font-weight: 800; letter-spacing: -0.01em; white-space: nowrap; }
.nb-logo-text b { color: #93C5FD; font-weight: 800; }
.nb-collapse-btn, .nb-expand-btn {
  background: none; border: none; cursor: pointer;
  color: rgba(203, 213, 225, 0.6);
  border-radius: 6px; padding: 6px;
  display: flex; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.nb-collapse-btn:hover, .nb-expand-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.1); }
.nb-expand-btn { margin: 0 auto 4px; }

.nb-nav { padding: 4px 10px 12px; flex: 1; }
.nb-nav-label {
  font-size: 11px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase;
  color: rgba(203, 213, 225, 0.5);
  padding: 10px 10px 4px;
}
.nb-nav-divider { height: 1px; background: rgba(255, 255, 255, 0.08); margin: 10px 8px; }
.nb-nav-item {
  display: flex; align-items: center; gap: 12px;
  padding: 7px 12px; margin-bottom: 1px;
  border-radius: var(--nb-radius-sm);
  color: var(--nb-sidebar-text);
  text-decoration: none; font-size: 14px; font-weight: 600;
  transition: background 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
  white-space: nowrap;
}
.nb-nav-item:hover { background: var(--nb-sidebar-hover); color: #fff; }
.nb-nav-item.active { background: var(--nb-primary); color: #fff; box-shadow: 0 2px 8px rgba(37, 99, 235, 0.3); }
.nb-nav-item:focus-visible { outline: 2px solid #93C5FD; outline-offset: 1px; }
.nb-nav-ic { color: inherit !important; flex-shrink: 0; }
.nb-sidebar--rail .nb-nav { padding: 4px 8px 12px; }
.nb-sidebar--rail .nb-nav-item { justify-content: center; padding: 10px 0; }
.nb-sidebar--rail .nb-sidebar-header { justify-content: center; padding: 14px 0 8px; }

.nb-user {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 10px 14px; background: none; border: none; cursor: pointer; text-align: left;
  border-top: 1px solid rgba(255, 255, 255, 0.08); color: var(--nb-sidebar-text);
  transition: background 0.15s;
}
.nb-user:hover { background: rgba(255, 255, 255, 0.06); }
.nb-sidebar--rail .nb-user { justify-content: center; padding: 12px 0; }
.nb-user-avatar {
  width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
  background: linear-gradient(135deg, var(--nb-primary-light), var(--nb-accent));
  color: #fff; font-weight: 800; font-size: 12.5px;
  display: flex; align-items: center; justify-content: center;
}
.nb-user-info { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.nb-user-name { color: #fff; font-weight: 700; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nb-user-role { font-size: 11.5px; color: rgba(203, 213, 225, 0.7); }
.nb-user-caret { color: rgba(203, 213, 225, 0.6) !important; }

/* ── Thanh trên ── */
.nb-topbar {
  background: rgba(255, 255, 255, 0.92) !important;
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--nb-border-light) !important;
  color: var(--nb-text) !important;
}
.nb-topbar :deep(.v-toolbar__content) { padding: 0 16px; gap: 8px; }
.nb-topbar-title { font-size: 17px; font-weight: 800; letter-spacing: -0.01em; white-space: nowrap; }
.nb-topbar-spacer { flex: 1; min-width: 0; }
.nb-topbar-search { max-width: 300px; flex: 0 1 300px; }
.nb-topbar-search :deep(.v-field) { background: var(--nb-bg) !important; border-radius: var(--nb-radius-sm) !important; }
:deep(.nb-icon-btn-wrap) > * {
  width: 38px; height: 38px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  color: var(--nb-text-2);
}
:deep(.nb-icon-btn-wrap) > *:hover { background: var(--nb-primary-50); color: var(--nb-primary); }

/* ── Nội dung ── */
.nb-main { background: var(--nb-bg); }
.nb-page { min-height: 100%; }
.nb-page--padded { padding: 20px 24px; }

/* Theme tối (legacy): menu & thanh trên theo nền tối */
.v-theme--legacy-dark .nb-topbar { background: #112240 !important; border-color: rgba(255, 255, 255, 0.08) !important; color: #E6F1FF !important; }
.v-theme--legacy-dark .nb-sidebar { background: #0A192F !important; }
.v-theme--legacy-dark .nb-main { background: #0A192F; }
</style>
