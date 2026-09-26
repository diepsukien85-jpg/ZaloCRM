<!--
  AiAutoReplySettingsView.vue — AI tự trả lời khách 1-1 theo THẺ PHÂN LOẠI.

  Chỉ hội thoại có một trong các thẻ kích hoạt (Tag CRM hoặc thẻ phân loại Zalo)
  mới được AI trả lời → không phải gọi AI cho mọi tin đến. AI bám kho kịch bản
  (bộ khung trả lời) khi nói về giá, chính sách; không có thì hẹn kiểm tra lại.
  Phỏng theo phần AI của ZL-CRM (Thầy Nguyễn Tất Kiểm, Apache-2.0).
-->
<template>
  <div class="aar">
    <div class="aar-title">
      <h2>AI tự trả lời khách</h2>
      <p>
        AI chỉ trả lời <strong>chat 1-1</strong> của khách đang mang <strong>thẻ kích hoạt</strong>.
        Gắn thẻ đó cho khách (trên app Zalo hoặc Tag CRM) là AI bắt đầu trả lời; gỡ thẻ là AI dừng.
        Mọi tin khác không tốn lượt gọi AI.
      </p>
    </div>

    <v-alert v-if="loadError" type="error" density="compact" class="mb-4">{{ loadError }}</v-alert>

    <!-- ════════ Bật/tắt + cổng thẻ ════════ -->
    <v-card variant="outlined" class="mb-5">
      <v-card-text>
        <div class="aar-row">
          <v-switch
            v-model="config.enabled"
            color="primary"
            inset
            hide-details
            :label="config.enabled ? 'Đang bật' : 'Đang tắt'"
          />
          <v-btn-toggle v-model="config.mode" mandatory density="compact" color="primary" variant="outlined">
            <v-btn value="auto">Tự gửi cho khách</v-btn>
            <v-btn value="dry_run">Chạy thử (không gửi)</v-btn>
          </v-btn-toggle>
        </div>
        <p v-if="config.mode === 'dry_run'" class="aar-hint mt-2">
          Chạy thử: AI vẫn đọc tin và viết câu trả lời vào nhật ký bên dưới nhưng KHÔNG gửi cho khách.
          Nên chạy thử vài ngày, xem nhật ký ổn rồi mới chuyển sang tự gửi.
        </p>

        <v-autocomplete
          v-model="config.triggerTags"
          :items="tagItems"
          label="Thẻ kích hoạt AI"
          multiple
          chips
          closable-chips
          class="mt-4"
          :hint="config.triggerTags.length ? 'Khách mang MỘT trong các thẻ này thì AI trả lời.' : 'Chưa chọn thẻ nào → AI không trả lời ai cả.'"
          persistent-hint
        >
          <template #chip="{ props: chipProps, item }">
            <v-chip v-bind="chipProps" :color="item.color" variant="tonal" size="small">{{ item.title }}</v-chip>
          </template>
        </v-autocomplete>
        <p class="aar-hint">
          Mẹo: tạo một thẻ phân loại riêng trên app Zalo (vd "AI trả lời"), gắn cho khách muốn giao cho AI.
          Thẻ Zalo đồng bộ về CRM khoảng 1 phút.
        </p>

        <v-divider class="my-4" />

        <div class="aar-grid">
          <v-select
            v-model="config.accountIds"
            :items="accountItems"
            label="Áp dụng cho nick Zalo"
            multiple
            chips
            closable-chips
            hint="Để trống = mọi nick"
            persistent-hint
          />
          <div class="aar-hours">
            <v-text-field v-model.number="config.hourStart" type="number" label="Từ giờ" min="0" max="23" density="comfortable" />
            <span>→</span>
            <v-text-field v-model.number="config.hourEnd" type="number" label="Đến giờ" min="1" max="24" density="comfortable" />
          </div>
          <v-text-field
            v-model.number="config.debounceSeconds"
            type="number" min="3" max="300"
            label="Gom tin khách nhắn dồn (giây)"
            hint="Đợi khách nhắn xong mới trả lời 1 lần"
            persistent-hint
          />
          <v-text-field
            v-model.number="config.skipIfStaffRepliedWithinMin"
            type="number" min="0"
            label="Nhường nhân viên (phút)"
            hint="Nhân viên vừa nhắn khách trong khoảng này thì AI im"
            persistent-hint
          />
          <v-text-field
            v-model.number="config.maxRepliesPerDay"
            type="number" min="1"
            label="Tối đa tin AI mỗi ngày (toàn shop)"
            persistent-hint
            hint="Chặn đốt quota AI"
          />
          <v-text-field
            v-model.number="config.maxRepliesPerConvPerDay"
            type="number" min="1"
            label="Tối đa tin AI mỗi khách mỗi ngày"
          />
        </div>

        <v-combobox
          v-model="config.blockedKeywords"
          label="Từ khoá chuyển người thật"
          multiple chips closable-chips
          class="mt-4"
          hint="Khách nhắn trúng những từ này thì AI không trả lời. Gõ rồi Enter để thêm."
          persistent-hint
        />

        <v-textarea
          v-model="config.persona"
          label="Vai trò & xưng hô"
          rows="2"
          class="mt-4"
          counter="1000"
          placeholder='nhân viên CSKH của Kho Sỉ Shin Su, xưng "em", gọi khách là "anh/chị"'
        />
        <v-textarea
          v-model="config.extraInstruction"
          label="Lời dặn riêng cho AI"
          rows="4"
          counter="4000"
          hint="Ví dụ: luôn mời khách để lại SĐT khi hỏi sỉ; không báo giá sỉ qua chat; đơn trên 500k miễn ship."
          persistent-hint
        />
        <v-switch
          v-model="config.verifyGrounding"
          color="primary"
          inset
          hide-details
          class="mt-3"
          label="Kiểm duyệt căn cứ trước khi gửi (thêm 1 lượt AI soát giá/chính sách bịa)"
        />
      </v-card-text>
      <v-card-actions>
        <div class="aar-stats">
          Hôm nay: gửi {{ today.sent || 0 }} · chạy thử {{ today.dry_run || 0 }} · chuyển người {{ today.handoff || 0 }} · lỗi {{ today.error || 0 }}
        </div>
        <v-spacer />
        <v-btn color="primary" :loading="saving" @click="save">Lưu cài đặt</v-btn>
      </v-card-actions>
    </v-card>

    <!-- ════════ Kho kịch bản ════════ -->
    <v-card variant="outlined" class="mb-5">
      <v-card-title class="d-flex align-center text-body-1">
        Bộ khung trả lời (kho kịch bản)
        <v-spacer />
        <v-btn size="small" color="primary" variant="tonal" @click="openNew">Thêm mục</v-btn>
      </v-card-title>
      <v-card-text>
        <p class="aar-hint">
          AI chỉ được nêu giá, phí ship, chính sách, khuyến mãi dựa trên các mục ở đây. Mục có từ khoá khớp tin khách
          được ưu tiên đưa cho AI. Kho trống thì AI tránh mọi con số và hẹn khách kiểm tra lại.
        </p>
        <v-alert v-if="playbook.length === 0" type="info" density="compact" variant="tonal">
          Chưa có mục nào. Nên thêm: bảng giá, phí ship, chính sách đổi trả, câu hỏi thường gặp.
        </v-alert>
        <v-table v-else density="compact">
          <thead>
            <tr>
              <th>Tiêu đề</th>
              <th>Nhóm</th>
              <th>Từ khoá</th>
              <th class="text-center">Ưu tiên</th>
              <th class="text-center">Bật</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in playbook" :key="entry.id">
              <td class="aar-cell-title">{{ entry.title }}</td>
              <td>{{ entry.category || '—' }}</td>
              <td>
                <span v-if="!entry.keywords?.length" class="text-grey">luôn cân nhắc</span>
                <v-chip v-for="kw in entry.keywords" :key="kw" size="x-small" class="mr-1">{{ kw }}</v-chip>
              </td>
              <td class="text-center">{{ entry.priority }}</td>
              <td class="text-center">{{ entry.enabled ? '✓' : '—' }}</td>
              <td class="text-right">
                <v-btn size="x-small" variant="text" icon="mdi-pencil" @click="openEdit(entry)" />
                <v-btn size="x-small" variant="text" icon="mdi-delete-outline" color="error" @click="remove(entry)" />
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <!-- ════════ Chạy thử 1 hội thoại ════════ -->
    <v-card variant="outlined" class="mb-5">
      <v-card-title class="text-body-1">Chạy thử với một hội thoại</v-card-title>
      <v-card-text>
        <p class="aar-hint">
          Dán link hội thoại (vd <code>crm…/chat/&lt;id&gt;</code>). AI viết thử câu trả lời cho các tin gần nhất của khách,
          <strong>không gửi</strong>, bỏ qua công tắc/khung giờ. Hội thoại vẫn phải có thẻ kích hoạt.
        </p>
        <div class="aar-row">
          <v-text-field v-model="testInput" label="Link hoặc ID hội thoại" density="compact" hide-details class="flex-grow-1" />
          <v-btn :loading="testing" color="primary" variant="tonal" @click="runTest">Chạy thử</v-btn>
        </div>
        <v-alert v-if="testResult" class="mt-3" density="compact" :type="testResult.decision === 'dry_run' ? 'success' : 'info'" variant="tonal">
          <div><strong>{{ decisionLabel(testResult.decision) }}</strong> · {{ testResult.reason }}</div>
          <div v-if="testResult.content" class="aar-reply">{{ testResult.content }}</div>
        </v-alert>
      </v-card-text>
    </v-card>

    <!-- ════════ Nhật ký ════════ -->
    <v-card variant="outlined">
      <v-card-title class="d-flex align-center text-body-1">
        Nhật ký gần đây
        <v-spacer />
        <v-btn size="small" variant="text" icon="mdi-refresh" @click="loadLogs" />
      </v-card-title>
      <v-card-text>
        <v-alert v-if="logs.length === 0" type="info" density="compact" variant="tonal">Chưa có lượt nào.</v-alert>
        <v-table v-else density="compact">
          <thead>
            <tr><th>Lúc</th><th>Khách · nick</th><th>Kết quả</th><th>Nội dung / lý do</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in logs" :key="l.id">
              <td class="aar-nowrap">{{ fmtTime(l.createdAt) }}</td>
              <td>
                <router-link :to="`/chat/${l.conversationId}`">{{ l.customerName || 'Khách' }}</router-link>
                <div class="text-grey text-caption">{{ l.nickName }}</div>
              </td>
              <td><v-chip size="x-small" :color="decisionColor(l.decision)" variant="tonal">{{ decisionLabel(l.decision) }}</v-chip></td>
              <td>
                <div v-if="l.content" class="aar-reply">{{ l.content }}</div>
                <div class="text-grey text-caption">{{ l.reason }}</div>
              </td>
            </tr>
          </tbody>
        </v-table>
      </v-card-text>
    </v-card>

    <!-- ════════ Hộp thoại mục kịch bản ════════ -->
    <v-dialog v-model="dialog" max-width="640">
      <v-card>
        <v-card-title>{{ editing?.id ? 'Sửa mục kịch bản' : 'Thêm mục kịch bản' }}</v-card-title>
        <v-card-text>
          <v-alert v-if="formError" type="error" density="compact" class="mb-3">{{ formError }}</v-alert>
          <v-text-field v-model="form.title" label="Tiêu đề" counter="200" class="mb-2" />
          <v-text-field v-model="form.category" label="Nhóm (tuỳ chọn)" placeholder="bảng giá / ship / đổi trả / FAQ" class="mb-2" />
          <v-combobox
            v-model="form.keywords"
            label="Từ khoá kích hoạt"
            multiple chips closable-chips
            hint="Khách nhắn trúng một từ thì mục được ưu tiên. Để trống = luôn cân nhắc."
            persistent-hint
            class="mb-2"
          />
          <v-textarea v-model="form.content" label="Nội dung" rows="8" counter="8000" class="mt-3" />
          <div class="d-flex align-center" style="gap: 24px;">
            <v-text-field v-model.number="form.priority" type="number" label="Ưu tiên (0-100)" min="0" max="100" density="compact" style="max-width: 180px;" />
            <v-switch v-model="form.enabled" color="primary" inset label="Đang bật" hide-details />
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="dialog = false">Huỷ</v-btn>
          <v-btn color="primary" :loading="savingEntry" @click="saveEntry">Lưu</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { api } from '@/api/index';
import { useToast } from '@/composables/use-toast';

interface PlaybookEntry {
  id: string; title: string; category: string | null; keywords: string[];
  content: string; priority: number; enabled: boolean;
}
interface LogRow {
  id: string; conversationId: string; decision: string; reason: string | null; content: string | null;
  createdAt: string; customerName: string | null; nickName: string | null;
}

const toast = useToast();

const config = reactive({
  enabled: false,
  mode: 'auto' as 'auto' | 'dry_run',
  triggerTags: [] as string[],
  accountIds: [] as string[],
  hourStart: 7,
  hourEnd: 22,
  debounceSeconds: 20,
  maxRepliesPerDay: 300,
  maxRepliesPerConvPerDay: 15,
  skipIfStaffRepliedWithinMin: 10,
  blockedKeywords: [] as string[],
  persona: '' as string | null,
  extraInstruction: '' as string | null,
  verifyGrounding: true,
});
const today = ref<Record<string, number>>({});
const tagItems = ref<Array<{ title: string; value: string; color: string }>>([]);
const accountItems = ref<Array<{ title: string; value: string }>>([]);
const playbook = ref<PlaybookEntry[]>([]);
const logs = ref<LogRow[]>([]);
const saving = ref(false);
const loadError = ref('');

const dialog = ref(false);
const savingEntry = ref(false);
const formError = ref('');
const editing = ref<PlaybookEntry | null>(null);
const form = reactive({ title: '', category: '', keywords: [] as string[], content: '', priority: 0, enabled: true });

const testInput = ref('');
const testing = ref(false);
const testResult = ref<{ decision: string; reason: string; content?: string } | null>(null);

function errorText(err: unknown, fallback: string) {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}

function decisionLabel(d: string) {
  return ({ sent: 'Đã gửi', dry_run: 'Chạy thử', handoff: 'Chuyển người', skipped: 'Bỏ qua', error: 'Lỗi' } as Record<string, string>)[d] || d;
}
function decisionColor(d: string) {
  return ({ sent: 'success', dry_run: 'info', handoff: 'warning', skipped: 'grey', error: 'error' } as Record<string, string>)[d] || 'grey';
}
function fmtTime(iso: string) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${d.getDate()}/${d.getMonth() + 1}`;
}

async function loadLogs() {
  try {
    const { data } = await api.get('/ai/auto-reply/logs', { params: { limit: 50 } });
    logs.value = data.logs;
  } catch { /* nhật ký lỗi không chặn trang */ }
}

async function loadAll() {
  try {
    const [cfg, tags, pb, accounts] = await Promise.all([
      api.get('/ai/auto-reply/config'),
      api.get('/ai/auto-reply/tags'),
      api.get('/ai/auto-reply/playbook'),
      api.get('/zalo-accounts').catch(() => ({ data: [] })),
    ]);
    Object.assign(config, cfg.data.config, {
      persona: cfg.data.config.persona ?? '',
      extraInstruction: cfg.data.config.extraInstruction ?? '',
    });
    today.value = cfg.data.today || {};
    tagItems.value = (tags.data.tags as Array<{ name: string; color: string }>).map((t) => ({
      title: t.name, value: t.name, color: t.color,
    }));
    // Thẻ đã lưu nhưng không còn trong danh sách (vd thẻ Zalo bị xoá) vẫn hiện để gỡ được.
    for (const t of config.triggerTags) {
      if (!tagItems.value.some((i) => i.value === t)) tagItems.value.push({ title: t, value: t, color: 'grey' });
    }
    playbook.value = pb.data.entries;
    const list = Array.isArray(accounts.data) ? accounts.data : (accounts.data?.items ?? accounts.data?.accounts ?? []);
    accountItems.value = list.map((a: { id: string; displayName?: string; phone?: string }) => ({
      title: a.displayName || a.phone || a.id.slice(0, 8),
      value: a.id,
    }));
    loadError.value = '';
  } catch (err) {
    loadError.value = errorText(err, 'Không tải được cài đặt AI tự trả lời');
  }
  await loadLogs();
}

async function save() {
  if (config.enabled && config.triggerTags.length === 0) {
    toast.warning('Chưa chọn thẻ kích hoạt nào: AI sẽ không trả lời ai cả.');
  }
  saving.value = true;
  try {
    const { data } = await api.put('/ai/auto-reply/config', { ...config });
    Object.assign(config, data.config, { persona: data.config.persona ?? '', extraInstruction: data.config.extraInstruction ?? '' });
    toast.success('Đã lưu cài đặt AI tự trả lời');
  } catch (err) {
    toast.error(errorText(err, 'Không lưu được cài đặt'));
  } finally {
    saving.value = false;
  }
}

function openNew() {
  editing.value = null;
  Object.assign(form, { title: '', category: '', keywords: [], content: '', priority: 0, enabled: true });
  formError.value = '';
  dialog.value = true;
}
function openEdit(entry: PlaybookEntry) {
  editing.value = entry;
  Object.assign(form, { ...entry, category: entry.category ?? '', keywords: [...(entry.keywords || [])] });
  formError.value = '';
  dialog.value = true;
}
async function saveEntry() {
  savingEntry.value = true;
  formError.value = '';
  try {
    const body = { ...form, category: form.category || null };
    if (editing.value?.id) await api.put(`/ai/auto-reply/playbook/${editing.value.id}`, body);
    else await api.post('/ai/auto-reply/playbook', body);
    dialog.value = false;
    playbook.value = (await api.get('/ai/auto-reply/playbook')).data.entries;
  } catch (err) {
    formError.value = errorText(err, 'Không lưu được mục kịch bản');
  } finally {
    savingEntry.value = false;
  }
}
async function remove(entry: PlaybookEntry) {
  if (!window.confirm(`Xoá mục "${entry.title}"?`)) return;
  try {
    await api.delete(`/ai/auto-reply/playbook/${entry.id}`);
    playbook.value = playbook.value.filter((e) => e.id !== entry.id);
  } catch (err) {
    toast.error(errorText(err, 'Không xoá được'));
  }
}

async function runTest() {
  const m = testInput.value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  if (!m) {
    toast.warning('Không thấy ID hội thoại trong link');
    return;
  }
  testing.value = true;
  testResult.value = null;
  try {
    const { data } = await api.post(`/ai/auto-reply/test/${m[0]}`);
    testResult.value = data;
  } catch (err) {
    toast.error(errorText(err, 'Chạy thử lỗi'));
  } finally {
    testing.value = false;
  }
}

onMounted(loadAll);
</script>

<style scoped>
.aar { max-width: 980px; }
.aar-title h2 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
.aar-title p { color: rgba(var(--v-theme-on-surface), 0.7); margin-bottom: 16px; line-height: 1.5; }
.aar-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.aar-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
.aar-hours { display: flex; align-items: center; gap: 8px; }
.aar-hint { font-size: 13px; color: rgba(var(--v-theme-on-surface), 0.65); margin: 6px 0 0; }
.aar-stats { font-size: 13px; color: rgba(var(--v-theme-on-surface), 0.7); padding-left: 8px; }
.aar-cell-title { font-weight: 500; }
.aar-reply { white-space: pre-wrap; margin-top: 4px; }
.aar-nowrap { white-space: nowrap; }
</style>
