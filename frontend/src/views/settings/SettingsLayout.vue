<template>
  <div class="settings-layout" :class="{ 'sl-mobile-open': mobileNavOpen }">
    <!-- Điện thoại: danh mục cài đặt gấp lại thành 1 nút (trước chiếm 2/3 màn hình, nội dung còn ~100px) -->
    <button type="button" class="sl-mobile-toggle" :aria-expanded="mobileNavOpen" @click="mobileNavOpen = !mobileNavOpen">
      <span>☰ Danh mục cài đặt</span>
      <span class="sl-mobile-current">{{ activeItem?.item.label || '' }}</span>
      <span class="sl-chevron">{{ mobileNavOpen ? '▴' : '▾' }}</span>
    </button>
    <!-- Sidebar -->
    <aside class="sl-sidebar" aria-label="Cài đặt sidebar">
      <header class="sl-header">
        <h1 class="sl-title">
          <span class="sl-icon">⚙</span>
          <span>Cài đặt</span>
        </h1>
      </header>

      <div class="sl-search">
        <span class="ic">🔍</span>
        <input
          v-model="searchQuery"
          type="text"
          placeholder="Tìm cài đặt..."
          aria-label="Tìm cài đặt"
        />
        <button v-if="searchQuery" type="button" class="sl-search-clear" @click="searchQuery = ''" aria-label="Xoá tìm kiếm">✕</button>
      </div>

      <nav class="sl-nav" :aria-label="searchQuery ? 'Kết quả tìm kiếm' : 'Cài đặt'">
        <!-- Search results -->
        <div v-if="searchQuery" class="sl-search-results">
          <div v-if="searchResults.length === 0" class="sl-empty">
            Không tìm thấy "{{ searchQuery }}"
          </div>
          <RouterLink
            v-for="item in searchResults"
            :key="`sr-${item.route}`"
            :to="item.route"
            class="sl-item"
            :class="{ active: $route.path === item.route }"
          >
            <span class="sl-item-icon">{{ item.icon }}</span>
            <span class="sl-item-label">{{ item.label }}</span>
          </RouterLink>
        </div>

        <!-- Grouped nav -->
        <div v-else>
          <div v-for="group in visibleGroups" :key="group.id" class="sl-group">
            <button
              type="button"
              class="sl-group-header"
              :class="{ collapsed: !openGroups[group.id] }"
              @click="toggleGroup(group.id)"
            >
              <span class="sl-group-icon">{{ group.icon }}</span>
              <span class="sl-group-label">{{ group.label }}</span>
              <span class="sl-chevron">▾</span>
            </button>
            <div v-if="openGroups[group.id]" class="sl-group-body">
              <RouterLink
                v-for="item in group.items"
                :key="item.route"
                :to="item.route"
                class="sl-item"
                :class="{ active: $route.path === item.route }"
              >
                <span class="sl-item-icon">{{ item.icon }}</span>
                <span class="sl-item-label">{{ item.label }}</span>
              </RouterLink>
            </div>
          </div>
        </div>
      </nav>
    </aside>

    <!-- Content panel -->
    <main class="sl-content" role="main">
      <header class="sl-breadcrumb" v-if="activeItem">
        <RouterLink to="/settings" class="bc-root">Cài đặt</RouterLink>
        <span class="bc-sep">/</span>
        <span class="bc-group">{{ activeItem.group.label }}</span>
        <span class="bc-sep">/</span>
        <span class="bc-current">{{ activeItem.item.label }}</span>
      </header>
      <div class="sl-content-body">
        <RouterView />
      </div>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSettingsNav } from '@/composables/use-settings-nav';

const route = useRoute();
const router = useRouter();
const mobileNavOpen = ref(false);
watch(() => route.path, () => { mobileNavOpen.value = false; });
const { visibleGroups, activeItem, searchItems, defaultRoute } = useSettingsNav();

const searchQuery = ref('');

// Group collapsed state — persist in localStorage
const SECTION_KEY_PREFIX = 'settings-nav.group.';
function loadGroupState(): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  for (const g of visibleGroups.value) {
    const raw = localStorage.getItem(SECTION_KEY_PREFIX + g.id);
    // Default open = true, except 'dev' which defaults closed for cleaner first impression
    const defaultOpen = g.id !== 'dev';
    result[g.id] = raw === null ? defaultOpen : raw === '1';
  }
  return result;
}
const openGroups = reactive<Record<string, boolean>>(loadGroupState());

function toggleGroup(id: string) {
  openGroups[id] = !openGroups[id];
  localStorage.setItem(SECTION_KEY_PREFIX + id, openGroups[id] ? '1' : '0');
}

// Auto-open group of active item
watch(activeItem, (info) => {
  if (info) openGroups[info.group.id] = true;
}, { immediate: true });

// Re-init openGroups when visibleGroups changes (e.g., role loads after login)
watch(visibleGroups, (groups) => {
  for (const g of groups) {
    if (!(g.id in openGroups)) {
      const raw = localStorage.getItem(SECTION_KEY_PREFIX + g.id);
      const defaultOpen = g.id !== 'dev';
      openGroups[g.id] = raw === null ? defaultOpen : raw === '1';
    }
  }
});

const searchResults = computed(() => searchItems(searchQuery.value));

// Redirect /settings (no subroute) to default item
onMounted(() => {
  if (route.path === '/settings' || route.path === '/settings/') {
    router.replace(defaultRoute.value);
  }
});
</script>

<style scoped>
.settings-layout {
  display: grid;
  grid-template-columns: 260px 1fr;
  height: calc(100vh - var(--smax-topnav-h, 52px));
  background: var(--nb-bg, #F0F7FF);
  font-family: inherit;
  font-size: 13.5px;
  color: #1F2D3D;
  -webkit-font-smoothing: antialiased;
  letter-spacing: -0.005em;
}

/* ── Sidebar ── */
.sl-sidebar {
  background: white;
  border-right: 1px solid #E4E5E9;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sl-header {
  padding: 16px 18px 12px;
  border-bottom: 1px solid #E4E5E9;
  flex-shrink: 0;
}
.sl-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
  color: #1F2D3D;
  margin: 0;
}
.sl-icon {
  font-size: 16px;
}

.sl-search {
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #E4E5E9;
  background: white;
  flex-shrink: 0;
}
.sl-search input {
  flex: 1;
  border: none;
  outline: none;
  background: #F4F4F7;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 12.5px;
  font-family: inherit;
  color: #1F2D3D;
  min-width: 0;
  border: 1px solid transparent;
}
.sl-search input:focus {
  background: white;
  border-color: #5E6AD2;
  box-shadow: 0 0 0 2px rgba(94, 106, 210, 0.12);
}
.sl-search .ic {
  color: #97A0AC;
  font-size: 13px;
}
.sl-search-clear {
  background: transparent;
  border: none;
  color: #97A0AC;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 4px;
  font-family: inherit;
  font-size: 10px;
}
.sl-search-clear:hover { color: #EF4444; background: #FEF2F2; }

.sl-nav {
  flex: 1;
  overflow-y: auto;
  padding: 8px 6px 16px;
}
.sl-nav::-webkit-scrollbar { width: 5px; }
.sl-nav::-webkit-scrollbar-thumb { background: #D4D6DB; border-radius: 2px; }

.sl-group {
  margin-bottom: 4px;
}
.sl-group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  user-select: none;
}
.sl-group-header:hover { background: #F4F4F7; }
.sl-group-icon {
  font-size: 13px;
  flex-shrink: 0;
}
.sl-group-label {
  flex: 1;
  font-size: 11px;
  font-weight: 700;
  color: #6B7785;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.sl-chevron {
  color: #97A0AC;
  font-size: 10px;
  transition: transform 0.15s;
}
.sl-group-header.collapsed .sl-chevron {
  transform: rotate(-90deg);
}

.sl-group-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0 6px 8px;
}
.sl-search-results {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sl-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 7px 10px;
  border-radius: 6px;
  text-decoration: none;
  color: #1F2D3D;
  font-size: 12.5px;
  font-weight: 500;
  transition: all 0.12s;
}
.sl-item:hover {
  background: #F4F4F7;
}
.sl-item.active,
.sl-item.router-link-exact-active {
  background: #EEF0FF;
  color: #5E6AD2;
  font-weight: 600;
  box-shadow: inset 3px 0 0 #5E6AD2;
}
.sl-item-icon {
  font-size: 14px;
  flex-shrink: 0;
}
.sl-item-label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sl-empty {
  padding: 20px 14px;
  font-size: 12px;
  color: #97A0AC;
  text-align: center;
  font-style: italic;
}

/* ── Content ── */
.sl-content {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--nb-bg, #F0F7FF);
}
.sl-breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 24px;
  font-size: 12px;
  color: #6B7785;
  background: white;
  border-bottom: 1px solid #E4E5E9;
  flex-shrink: 0;
}
.bc-root {
  color: #5E6AD2;
  text-decoration: none;
  font-weight: 500;
}
.bc-root:hover { text-decoration: underline; }
.bc-sep {
  color: #D4D6DB;
}
.bc-group {
  color: #6B7785;
}
.bc-current {
  color: #1F2D3D;
  font-weight: 600;
}
.sl-content-body {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}
.sl-mobile-toggle { display: none; }
@media (max-width: 768px) {
  .settings-layout { display: flex; flex-direction: column; height: auto; min-height: calc(100vh - 120px); }
  .sl-mobile-toggle {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 12px 16px; background: #fff; border: none; border-bottom: 1px solid var(--nb-border-light, #DBEAFE);
    font: inherit; font-weight: 800; color: var(--nb-primary, #2563EB); cursor: pointer; text-align: left;
  }
  .sl-mobile-current { flex: 1; min-width: 0; color: var(--nb-text-2, #475569); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .settings-layout .sl-sidebar { display: none; border-right: none; border-bottom: 1px solid var(--nb-border-light, #DBEAFE); max-height: 70vh; overflow-y: auto; }
  .settings-layout.sl-mobile-open .sl-sidebar { display: flex; }
  .sl-breadcrumb { display: none; }
  .sl-content { overflow: visible; }
  .sl-content-body { padding: 14px 12px; overflow-x: auto; }
}
.sl-content-body::-webkit-scrollbar { width: 8px; }
.sl-content-body::-webkit-scrollbar-thumb { background: #D4D6DB; border-radius: 4px; }
</style>
