<template>
  <nav class="nb-bottom-nav" aria-label="Điều hướng nhanh">
    <RouterLink
      v-for="tab in tabs"
      :key="tab.path"
      :to="tab.path"
      class="nb-bn-item"
      :class="{ active: isActive(tab.path) }"
    >
      <v-icon size="22">{{ tab.icon }}</v-icon>
      <span>{{ tab.title }}</span>
    </RouterLink>
    <!-- Mở menu đầy đủ (Bạn bè, Cài đặt, đăng xuất…) -->
    <button class="nb-bn-item" type="button" @click="emit('open-menu')">
      <v-icon size="22">mdi-menu</v-icon>
      <span>Menu</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { useRoute, RouterLink } from 'vue-router';

const emit = defineEmits<{ 'open-menu': [] }>();
const route = useRoute();

const tabs = [
  { title: 'Tin nhắn', icon: 'mdi-message-text-outline', path: '/chat' },
  { title: 'Khách hàng', icon: 'mdi-account-box-multiple-outline', path: '/contacts' },
  { title: 'Lịch hẹn', icon: 'mdi-calendar-clock-outline', path: '/appointments' },
  { title: 'Tổng quan', icon: 'mdi-view-dashboard-outline', path: '/' },
];

function isActive(path: string) {
  return path === '/' ? route.path === '/' : route.path === path || route.path.startsWith(path + '/');
}
</script>

<style scoped>
.nb-bottom-nav {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 100;
  display: flex; background: #fff;
  border-top: 1px solid var(--nb-border-light);
  box-shadow: 0 -4px 20px rgba(37, 99, 235, 0.08);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.nb-bn-item {
  flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  min-height: 58px; padding: 6px 0;
  color: var(--nb-text-muted); text-decoration: none; font-size: 11.5px; font-weight: 700;
  background: none; border: none; cursor: pointer;
  transition: color 0.15s ease;
}
.nb-bn-item :deep(.v-icon) { color: inherit !important; }
.nb-bn-item.active { color: var(--nb-primary); }
.nb-bn-item.active :deep(.v-icon) { transform: translateY(-1px); }
.v-theme--legacy-dark .nb-bottom-nav { background: #112240; border-color: rgba(255, 255, 255, 0.08); }
</style>
