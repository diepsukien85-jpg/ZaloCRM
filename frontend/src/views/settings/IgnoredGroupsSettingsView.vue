<!--
  IgnoredGroupsSettingsView.vue — nhóm Zalo bị bỏ qua (nhóm đăng bài).

  Tin nhắn của nhóm bỏ qua KHÔNG được lưu vào CRM: không vào thống kê, không tăng
  Chưa đọc/Chưa rep, không kích hoạt automation/AI. Đăng bài vào nhóm (API bot,
  broadcast, gửi tay) vẫn chạy bình thường.
-->
<template>
  <div class="ig">
    <div class="ig-title">
      <h2>Nhóm bỏ qua</h2>
      <p>
        Dành cho nhóm đăng bài nhiều tin. Tin nhắn trong các nhóm này <strong>không được lưu</strong> vào CRM
        nên không làm nhiễu thống kê, bộ đếm chưa đọc, thông báo. <strong>Việc đăng bài vào nhóm vẫn chạy bình thường.</strong>
        Tin đã lưu trước đó giữ nguyên.
      </p>
    </div>

    <v-card variant="outlined" class="mb-5">
      <v-card-title class="text-body-1">Đang bỏ qua ({{ ignored.length }})</v-card-title>
      <v-card-text>
        <v-alert v-if="ignored.length === 0" type="info" density="compact" variant="tonal">Chưa bỏ qua nhóm nào.</v-alert>
        <v-table v-else density="compact">
          <thead><tr><th>Nhóm</th><th>Group ID</th><th>Thêm lúc</th><th /></tr></thead>
          <tbody>
            <tr v-for="g in ignored" :key="g.groupThreadId">
              <td>{{ g.groupName || '(không tên)' }}</td>
              <td class="text-grey text-caption">{{ g.groupThreadId }}</td>
              <td class="text-caption">{{ new Date(g.createdAt).toLocaleString('vi-VN') }}</td>
              <td class="text-right">
                <v-btn v-if="isAdmin" size="small" variant="text" color="error" @click="unignore(g)">Bỏ khỏi danh sách</v-btn>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <v-card v-if="isAdmin" variant="outlined">
      <v-card-title class="d-flex align-center text-body-1">
        Chọn nhóm để bỏ qua
        <v-spacer />
        <v-btn color="primary" :disabled="selected.length === 0" :loading="adding" @click="addSelected">
          Bỏ qua {{ selected.length || '' }} nhóm đã chọn
        </v-btn>
      </v-card-title>
      <v-card-text>
        <v-text-field
          v-model="q"
          density="compact"
          prepend-inner-icon="mdi-magnify"
          label="Tìm theo tên nhóm"
          hide-details
          clearable
          class="mb-3"
          @update:model-value="debouncedLoad"
        />
        <p class="ig-hint">Sắp xếp theo số tin 7 ngày qua, nhóm "ồn" nhất lên đầu.</p>
        <div v-if="loadingCandidates" class="ig-hint">Đang tải…</div>
        <v-table v-else density="compact" class="ig-table">
          <thead>
            <tr>
              <th style="width: 40px;"><v-checkbox-btn :model-value="allChecked" :indeterminate="someChecked" @update:model-value="toggleAll" /></th>
              <th>Nhóm</th>
              <th class="text-right">Tin 7 ngày</th>
              <th class="text-right">Số nick</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="g in visibleCandidates" :key="g.groupThreadId">
              <td><v-checkbox-btn v-model="selected" :value="g.groupThreadId" /></td>
              <td>{{ g.groupName || '(không tên)' }}</td>
              <td class="text-right">{{ g.messages7d.toLocaleString('vi-VN') }}</td>
              <td class="text-right">{{ g.nickCount }}</td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api } from '@/api/index';
import { useToast } from '@/composables/use-toast';
import { useAuthStore } from '@/stores/auth';

interface IgnoredRow { groupThreadId: string; groupName: string | null; createdAt: string }
interface Candidate { groupThreadId: string; groupName: string | null; messages7d: number; nickCount: number }

const toast = useToast();
const auth = useAuthStore();
const isAdmin = computed(() => ['owner', 'admin'].includes(auth.user?.role || ''));

const ignored = ref<IgnoredRow[]>([]);
const candidates = ref<Candidate[]>([]);
const selected = ref<string[]>([]);
const q = ref('');
const adding = ref(false);
const loadingCandidates = ref(false);

const ignoredIds = computed(() => new Set(ignored.value.map((g) => g.groupThreadId)));
const visibleCandidates = computed(() => candidates.value.filter((c) => !ignoredIds.value.has(c.groupThreadId)));
const allChecked = computed(() => visibleCandidates.value.length > 0 && selected.value.length === visibleCandidates.value.length);
const someChecked = computed(() => selected.value.length > 0 && !allChecked.value);

function errorText(err: unknown, fallback: string) {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

function toggleAll(v: boolean) {
  selected.value = v ? visibleCandidates.value.map((c) => c.groupThreadId) : [];
}

async function loadIgnored() {
  const { data } = await api.get('/ignored-groups');
  ignored.value = data.groups;
}

async function loadCandidates() {
  if (!isAdmin.value) return;
  loadingCandidates.value = true;
  try {
    const { data } = await api.get('/ignored-groups/candidates', { params: { q: q.value || '' } });
    candidates.value = data.groups;
    selected.value = selected.value.filter((id) => candidates.value.some((c) => c.groupThreadId === id));
  } catch (err) {
    toast.error(errorText(err, 'Không tải được danh sách nhóm'));
  } finally {
    loadingCandidates.value = false;
  }
}

let t: ReturnType<typeof setTimeout> | null = null;
function debouncedLoad() {
  if (t) clearTimeout(t);
  t = setTimeout(loadCandidates, 350);
}

async function addSelected() {
  adding.value = true;
  try {
    const { data } = await api.post('/ignored-groups', { groupThreadIds: selected.value });
    toast.success(`Đã bỏ qua ${data.added} nhóm`);
    selected.value = [];
    await loadIgnored();
  } catch (err) {
    toast.error(errorText(err, 'Không thêm được'));
  } finally {
    adding.value = false;
  }
}

async function unignore(g: IgnoredRow) {
  try {
    await api.delete(`/ignored-groups/${g.groupThreadId}`);
    ignored.value = ignored.value.filter((x) => x.groupThreadId !== g.groupThreadId);
    toast.success('Nhóm sẽ được lưu tin trở lại từ bây giờ');
  } catch (err) {
    toast.error(errorText(err, 'Không bỏ được'));
  }
}

onMounted(async () => {
  try {
    await loadIgnored();
  } catch (err) {
    toast.error(errorText(err, 'Không tải được danh sách nhóm bỏ qua'));
  }
  await loadCandidates();
});
</script>

<style scoped>
.ig { max-width: 980px; }
.ig-title h2 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
.ig-title p { color: rgba(var(--v-theme-on-surface), 0.7); margin-bottom: 16px; line-height: 1.5; }
.ig-hint { font-size: 13px; color: rgba(var(--v-theme-on-surface), 0.65); margin: 0 0 8px; }
.ig-table { max-height: 560px; overflow-y: auto; }
</style>
