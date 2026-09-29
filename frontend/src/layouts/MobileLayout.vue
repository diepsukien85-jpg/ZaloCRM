<template>
  <v-app class="nb-app nb-mobile">
    <OfflineIndicator />

    <!-- Thanh trên (navy như App nội bộ) -->
    <v-app-bar density="compact" flat class="nb-m-bar">
      <v-btn icon variant="text" size="small" class="ml-1" aria-label="Mở menu" @click="drawer = true">
        <v-icon color="white">mdi-menu</v-icon>
      </v-btn>
      <div class="nb-m-brand">
        <span class="nb-m-logo"><img src="/brand/zalocrm-logo.png" alt="" /></span>
        <span class="nb-m-title">{{ pageTitle }}</span>
      </div>
      <v-spacer />
      <NotificationBell class="nb-m-bell" />
    </v-app-bar>

    <!-- Menu đầy đủ (trượt từ trái) — gồm cả Cài đặt, tài khoản, đăng xuất -->
    <v-navigation-drawer v-model="drawer" temporary :width="280" class="nb-sidebar-m">
      <div class="nb-m-drawer-head">
        <span class="nb-m-avatar">{{ initials }}</span>
        <div class="nb-m-user">
          <div class="nb-m-user-name">{{ authStore.user?.fullName || 'Tài khoản' }}</div>
          <div class="nb-m-user-mail">{{ authStore.user?.email || '' }}</div>
        </div>
      </div>
      <nav class="nb-m-nav" aria-label="Menu chính">
        <template v-for="(group, gi) in NAV_GROUPS" :key="gi">
          <div v-if="group.label" class="nb-m-label">{{ group.label }}</div>
          <RouterLink
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            class="nb-m-item"
            :class="{ active: isNavActive(item, route.path) }"
            @click="drawer = false"
          >
            <v-icon size="20">{{ item.icon }}</v-icon>
            <span>{{ item.label }}</span>
          </RouterLink>
        </template>
        <div class="nb-m-label">Tài khoản</div>
        <RouterLink to="/profile" class="nb-m-item" @click="drawer = false">
          <v-icon size="20">mdi-card-account-details-outline</v-icon>
          <span>Hồ sơ nick Zalo</span>
        </RouterLink>
        <button class="nb-m-item nb-m-logout" type="button" @click="logout">
          <v-icon size="20">mdi-logout</v-icon>
          <span>Đăng xuất</span>
        </button>
      </nav>
    </v-navigation-drawer>

    <!-- Main content with padding for bottom nav -->
    <v-main class="nb-m-main">
      <div :key="route.path.split('/')[1] || 'home'" class="nb-page-enter" style="padding-bottom: 72px;">
        <slot />
      </div>
    </v-main>

    <!-- Popup nổi: hỏi AI về tình trạng khách hàng hôm nay -->
    <AiDailyBriefPopup />

    <BottomNav @open-menu="drawer = true" />
  </v-app>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useTheme } from 'vuetify';
import { useAuthStore } from '@/stores/auth';
import { useRoute, useRouter, RouterLink } from 'vue-router';
import NotificationBell from '@/components/NotificationBell.vue';
import BottomNav from '@/components/BottomNav.vue';
import OfflineIndicator from '@/components/OfflineIndicator.vue';
import AiDailyBriefPopup from '@/components/ai/ai-daily-brief-popup.vue';
import { NAV_GROUPS, isNavActive, activeNavLabel } from '@/constants/nav-menu';

const theme = useTheme();
const authStore = useAuthStore();
const route = useRoute();
const router = useRouter();
const drawer = ref(false);
// Chỉ giao diện sáng (đồng bộ App nội bộ). Xoá lựa chọn tối cũ nếu còn lưu.
onMounted(() => {
  theme.global.name.value = 'smax-light';
  try { localStorage.setItem('theme', 'smax-light'); } catch { /* bỏ qua */ }
});

const pageTitle = computed(() => activeNavLabel(route.path) || 'ZaloCRM');
const initials = computed(() => {
  const name = authStore.user?.fullName || 'U';
  return name.split(' ').map((p) => p[0]).slice(-2).join('').toUpperCase();
});

function logout() {
  drawer.value = false;
  authStore.logout();
  router.push('/login');
}
</script>

<style scoped>
.nb-m-bar { background: var(--nb-sidebar) !important; color: #fff !important; }
.nb-m-brand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.nb-m-logo { width: 28px; height: 28px; border-radius: 8px; background: #fff; padding: 2px; display: flex; flex-shrink: 0; }
.nb-m-logo img { width: 100%; height: 100%; object-fit: contain; }
.nb-m-title { font-weight: 800; font-size: 16px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nb-m-bell :deep(*) { color: #fff; }
.nb-m-main { background: var(--nb-bg); }

.nb-sidebar-m { background: var(--nb-sidebar) !important; color: var(--nb-sidebar-text) !important; }
.nb-m-drawer-head { display: flex; align-items: center; gap: 10px; padding: 18px 16px 12px; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
.nb-m-avatar {
  width: 40px; height: 40px; border-radius: 50%; flex-shrink: 0;
  background: linear-gradient(135deg, var(--nb-primary-light), var(--nb-accent));
  color: #fff; font-weight: 800; display: flex; align-items: center; justify-content: center;
}
.nb-m-user { min-width: 0; }
.nb-m-user-name { color: #fff; font-weight: 800; font-size: 14.5px; }
.nb-m-user-mail { font-size: 12px; color: rgba(203, 213, 225, 0.7); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nb-m-nav { padding: 6px 10px 24px; }
.nb-m-label { font-size: 11px; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase; color: rgba(203, 213, 225, 0.5); padding: 14px 10px 6px; }
.nb-m-item {
  display: flex; align-items: center; gap: 12px; width: 100%;
  padding: 11px 12px; margin-bottom: 2px; border-radius: var(--nb-radius-sm);
  color: var(--nb-sidebar-text); text-decoration: none; font-size: 15px; font-weight: 600;
  background: none; border: none; text-align: left; cursor: pointer;
}
.nb-m-item.active { background: var(--nb-primary); color: #fff; box-shadow: 0 2px 8px rgba(37, 99, 235, 0.3); }
.nb-m-item :deep(.v-icon) { color: inherit !important; }
.nb-m-logout { color: #FCA5A5; }
</style>
