<template>
  <v-app>
    <OfflineIndicator />

    <!-- Slim mobile app bar -->
    <v-app-bar density="compact" flat>
      <div class="d-flex align-center ml-3" style="gap: 8px;">
        <div class="d-flex align-center justify-center" style="width: 28px; height: 28px; background: linear-gradient(135deg, #00F2FF, #0077B6); border-radius: 8px;">
          <v-icon size="16" color="white">mdi-robot</v-icon>
        </div>
        <span class="font-weight-bold text-body-1">Zalo<span style="color: #00F2FF;">CRM</span></span>
      </div>

      <v-spacer />

      <NotificationBell />
      <v-btn icon size="small" variant="text" @click="toggleTheme">
        <v-icon size="20">{{ isDark ? 'mdi-weather-sunny' : 'mdi-weather-night' }}</v-icon>
      </v-btn>
      <v-btn icon size="small" variant="text" @click="logout">
        <v-icon size="20">mdi-logout</v-icon>
      </v-btn>
    </v-app-bar>

    <!-- Main content with padding for bottom nav -->
    <v-main>
      <div style="padding-bottom: 72px;">
        <slot />
      </div>
    </v-main>

    <!-- Popup nổi: hỏi AI về tình trạng khách hàng hôm nay -->
    <AiDailyBriefPopup />

    <BottomNav />
  </v-app>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useTheme } from 'vuetify';
import { useAuthStore } from '@/stores/auth';
import { useRouter } from 'vue-router';
import NotificationBell from '@/components/NotificationBell.vue';
import BottomNav from '@/components/BottomNav.vue';
import OfflineIndicator from '@/components/OfflineIndicator.vue';
import AiDailyBriefPopup from '@/components/ai/ai-daily-brief-popup.vue';

const theme = useTheme();
const authStore = useAuthStore();
const router = useRouter();
// Dùng chung tên theme với DefaultLayout ('smax-light' | 'legacy-dark'), mặc định SÁNG.
// Trước đây so với 'light' → giá trị mặc định 'smax-light' bị coi là dark và bật
// theme 'dark' built-in của Vuetify (chữ trắng trên các nền trắng hard-code).
// Giá trị cũ 'dark' (do bản mobile trước lưu) vẫn được hiểu là dark.
const savedTheme = localStorage.getItem('theme');
const isDark = ref(savedTheme === 'legacy-dark' || savedTheme === 'dark');

onMounted(() => {
  theme.global.name.value = isDark.value ? 'legacy-dark' : 'smax-light';
});

function toggleTheme() {
  isDark.value = !isDark.value;
  const next = isDark.value ? 'legacy-dark' : 'smax-light';
  theme.global.name.value = next;
  localStorage.setItem('theme', next);
}

function logout() {
  authStore.logout();
  router.push('/login');
}
</script>
