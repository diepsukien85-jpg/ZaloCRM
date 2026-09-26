<!--
  AiAutoReplySettingsView.vue — AI tự trả lời khách 1-1, CẤU HÌNH RIÊNG TỪNG NICK.

  Mỗi nick Zalo là một thẻ: xưng hô, lời dặn, khung giờ, thẻ kích hoạt, trần tin,
  bộ khung trả lời riêng. Bấm thẻ để sửa; "+ Thêm nick" để cấu hình nick khác.
  Chỉ khách mang thẻ kích hoạt của nick đó mới được AI trả lời → tin khác không
  tốn lượt gọi AI. Phỏng theo phần AI của ZL-CRM (Thầy Nguyễn Tất Kiểm, Apache-2.0).
-->
<template>
  <div class="aar">
    <div class="aar-title">
      <h2>AI tự trả lời khách</h2>
      <p>
        Mỗi nick Zalo có <strong>cấu hình riêng</strong> (xưng hô, lời dặn, bảng giá, khung giờ…).
        AI chỉ trả lời <strong>chat 1-1</strong> của khách đang mang <strong>thẻ kích hoạt</strong> của nick đó;
        tin khác không tốn lượt gọi AI.
      </p>
    </div>

    <v-alert v-if="loadError" type="error" density="compact" class="mb-4">{{ loadError }}</v-alert>

    <!-- ════════ Thẻ cấu hình từng nick ════════ -->
    <div class="aar-section-title">Cấu hình theo nick</div>
    <div class="aar-cards mb-6">
      <button v-for="p in profiles" :key="p.zaloAccountId" type="button" class="aar-card" @click="openProfile(p.zaloAccountId)">
        <div class="aar-card-head">
          <div class="aar-avatar">{{ (p.accountName || '?').charAt(0).toUpperCase() }}</div>
          <div class="aar-card-name">
            <div class="aar-card-title">{{ p.accountName }}</div>
            <div class="aar-card-sub">{{ p.accountStatus === 'connected' ? 'Đang kết nối' : 'Mất kết nối' }}</div>
          </div>
          <v-chip size="small" :color="statusColor(p)" variant="flat">{{ statusLabel(p) }}</v-chip>
        </div>
        <div class="aar-card-row">
          <span class="aar-card-label">Thẻ:</span>
          <span v-if="!p.triggerTags.length" class="text-warning">chưa chọn thẻ</span>
          <v-chip v-for="t in p.triggerTags" :key="t" size="x-small" class="mr-1" variant="tonal">{{ cleanTag(t) }}</v-chip>
        </div>
        <div class="aar-card-row">
          <span class="aar-card-label">Xưng hô:</span>
          <span class="aar-ellipsis">{{ p.persona || 'mặc định (em / anh chị)' }}</span>
        </div>
        <div class="aar-card-row">
          <span class="aar-card-label">Giờ:</span> {{ p.hourStart }}h → {{ p.hourEnd }}h
        </div>
        <div class="aar-card-foot">
          Hôm nay: gửi {{ p.today.sent || 0 }} · thử {{ p.today.dry_run || 0 }} · chuyển người {{ p.today.handoff || 0 }} · lỗi {{ p.today.error || 0 }}
        </div>
      </button>
      <button v-if="isAdmin" type="button" class="aar-card aar-card-add" :disabled="!unconfiguredAccounts.length" @click="openNew">
        <div class="aar-add-plus">＋</div>
        <div>{{ unconfiguredAccounts.length ? 'Thêm cấu hình cho nick khác' : 'Mọi nick đều đã có cấu hình' }}</div>
      </button>
    </div>

    <!-- ════════ Bộ khung dùng chung ════════ -->
    <v-card variant="outlined" class="mb-5">
      <v-card-title class="d-flex align-center text-body-1">
        Bộ khung trả lời dùng chung (mọi nick)
        <v-spacer />
        <v-btn v-if="isAdmin" size="small" color="primary" variant="tonal" @click="openEntry(null, null)">Thêm mục</v-btn>
      </v-card-title>
      <v-card-text>
        <p class="aar-hint">
          Mục ở đây áp dụng cho mọi nick. Mục riêng của từng nick (bảng giá riêng…) thêm trong thẻ cấu hình của nick đó.
          AI chỉ được nêu giá, ship, chính sách có trong bộ khung; không có thì hẹn khách kiểm tra lại.
        </p>
        <PlaybookTable :entries="sharedEntries" :editable="isAdmin" @edit="(e: PlaybookEntry) => openEntry(e, null)" @remove="removeEntry" />
      </v-card-text>
    </v-card>

    <!-- ════════ Chạy thử 1 hội thoại ════════ -->
    <v-card variant="outlined" class="mb-5">
      <v-card-title class="text-body-1">Chạy thử với một hội thoại</v-card-title>
      <v-card-text>
        <p class="aar-hint">
          Dán link hội thoại (vd <code>crm…/chat/&lt;id&gt;</code>). AI dùng cấu hình của nick nhận tin để viết thử câu trả lời,
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
        <v-select
          v-model="logAccount"
          :items="logAccountItems"
          density="compact"
          hide-details
          style="max-width: 220px;"
          @update:model-value="loadLogs"
        />
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

    <!-- ════════ Hộp thoại cấu hình 1 nick ════════ -->
    <v-dialog v-model="editorOpen" max-width="960" scrollable>
      <v-card>
        <v-card-title class="d-flex align-center">
          <span v-if="editingAccountId">Cấu hình AI · nick <strong class="ml-1">{{ accountName(editingAccountId) }}</strong></span>
          <span v-else>Thêm cấu hình cho nick</span>
          <v-spacer />
          <v-btn icon="mdi-close" variant="text" size="small" @click="editorOpen = false" />
        </v-card-title>
        <v-divider />
        <v-card-text class="aar-editor">
          <!-- Chọn nick (chỉ khi thêm mới) -->
          <template v-if="!editingConfigured">
            <div class="aar-step">Chọn nick Zalo</div>
            <v-select
              v-model="newAccountId"
              :items="unconfiguredAccounts.map((a) => ({ title: a.name, value: a.id }))"
              label="Nick Zalo chưa có cấu hình"
              @update:model-value="selectNewAccount"
            />
          </template>

          <template v-if="editingAccountId">
            <div class="aar-row mb-2">
              <v-switch
                v-model="form.enabled"
                color="success"
                base-color="grey-darken-1"
                inset
                hide-details
                :label="form.enabled ? 'Đang bật' : 'Đang tắt'"
              />
              <v-btn-toggle v-model="form.mode" mandatory density="compact" color="primary" variant="outlined">
                <v-btn value="auto">Tự gửi cho khách</v-btn>
                <v-btn value="dry_run">Chạy thử (không gửi)</v-btn>
              </v-btn-toggle>
            </div>
            <p v-if="form.mode === 'dry_run'" class="aar-hint">
              Chạy thử: AI viết câu trả lời vào nhật ký nhưng KHÔNG gửi cho khách.
            </p>

            <!-- Thẻ kích hoạt của đúng nick này -->
            <div class="aar-step mt-4">Thẻ kích hoạt</div>
            <div v-if="loadingTags" class="aar-hint">Đang tải thẻ…</div>
            <template v-else>
              <div class="aar-taggroup-title">Thẻ phân loại Zalo của nick <strong>{{ accountName(editingAccountId) }}</strong></div>
              <div v-if="zaloTags.length === 0" class="aar-hint">
                Nick này chưa có thẻ phân loại nào. Tạo thẻ trên app Zalo (vd "Bot AI"), khoảng 1 phút sau mở lại.
              </div>
              <v-chip-group v-else v-model="form.triggerTags" multiple column filter>
                <v-chip v-for="l in zaloTags" :key="l.value" :value="l.value" :color="l.color" variant="outlined" size="small">
                  {{ l.emoji ? l.emoji + ' ' : '' }}{{ l.text }} <span class="aar-count">{{ l.count }} khách</span>
                </v-chip>
              </v-chip-group>
              <template v-if="crmTags.length">
                <div class="aar-taggroup-title mt-2">Tag CRM</div>
                <v-chip-group v-model="form.triggerTags" multiple column filter>
                  <v-chip v-for="t in crmTags" :key="t.value" :value="t.value" :color="t.color" variant="outlined" size="small">
                    {{ t.text }} <span class="aar-count">{{ t.count }} khách</span>
                  </v-chip>
                </v-chip-group>
              </template>
              <v-alert :type="form.triggerTags.length ? 'success' : 'warning'" variant="tonal" density="compact" class="mt-2">
                <template v-if="form.triggerTags.length">
                  AI sẽ trả lời khách của nick này đang mang thẻ: <strong>{{ form.triggerTags.map(cleanTag).join(', ') }}</strong>
                  (hiện khoảng <strong>{{ selectedCount }}</strong> khách).
                </template>
                <template v-else>Chưa chọn thẻ nào → AI không trả lời ai cả.</template>
              </v-alert>
            </template>

            <!-- Xưng hô + lời dặn riêng -->
            <div class="aar-step mt-5">Xưng hô & lời dặn của nick này</div>
            <v-textarea
              v-model="form.persona"
              label="Vai trò & xưng hô"
              rows="2"
              counter="1000"
              placeholder='vd: Kim Mỹ, chủ kho sỉ ăn vặt, xưng "chị", gọi khách là "em"'
            />
            <v-textarea
              v-model="form.extraInstruction"
              label="Lời dặn riêng cho AI"
              rows="3"
              counter="4000"
              hint="vd: khách hỏi giá sỉ thì xin SĐT để nhân viên gọi lại; đơn trên 500k miễn ship."
              persistent-hint
            />

            <!-- Bộ khung riêng của nick -->
            <div class="aar-step mt-5 d-flex align-center">
              Bộ khung trả lời riêng của nick này
              <v-spacer />
              <v-btn v-if="isAdmin" size="small" color="primary" variant="tonal" @click="openEntry(null, editingAccountId)">Thêm mục</v-btn>
            </div>
            <p class="aar-hint">AI dùng mục riêng của nick này + mục dùng chung. Mục riêng được ưu tiên khi cùng độ ưu tiên.</p>
            <PlaybookTable :entries="nickEntries" :editable="isAdmin" @edit="(e: PlaybookEntry) => openEntry(e, editingAccountId)" @remove="removeEntry" />

            <!-- Hàng rào -->
            <div class="aar-step mt-5">Khung giờ & giới hạn</div>
            <div class="aar-grid">
              <div class="aar-hours">
                <v-text-field v-model.number="form.hourStart" type="number" label="Từ giờ" min="0" max="23" density="comfortable" />
                <span>→</span>
                <v-text-field v-model.number="form.hourEnd" type="number" label="Đến giờ" min="1" max="24" density="comfortable" />
              </div>
              <v-text-field v-model.number="form.debounceSeconds" type="number" min="3" max="300" label="Gom tin khách nhắn dồn (giây)" hint="Khách ngừng nhắn chừng này giây thì AI trả lời 1 lần" persistent-hint />
              <v-text-field v-model.number="form.skipIfStaffRepliedWithinMin" type="number" min="0" label="Nhường nhân viên (phút)" hint="Nhân viên vừa nhắn khách trong khoảng này thì AI im" persistent-hint />
              <v-text-field v-model.number="form.maxRepliesPerDay" type="number" min="1" label="Tối đa tin AI mỗi ngày (nick này)" />
              <v-text-field v-model.number="form.maxRepliesPerConvPerDay" type="number" min="1" label="Tối đa tin AI mỗi khách mỗi ngày" />
            </div>
            <v-combobox
              v-model="form.blockedKeywords"
              label="Từ khoá chuyển người thật"
              multiple chips closable-chips
              class="mt-3"
              hint="Khách nhắn trúng những từ này thì AI không trả lời. Gõ rồi Enter để thêm."
              persistent-hint
            />
            <v-switch
              v-model="form.verifyGrounding"
              color="primary"
              inset
              hide-details
              class="mt-3"
              label="Kiểm duyệt căn cứ trước khi gửi (thêm 1 lượt AI soát giá/chính sách bịa)"
            />
          </template>
        </v-card-text>
        <v-divider />
        <v-card-actions>
          <v-btn v-if="editingConfigured && isAdmin" color="error" variant="text" @click="removeProfile">Xoá cấu hình nick này</v-btn>
          <v-spacer />
          <v-btn variant="text" @click="editorOpen = false">Huỷ</v-btn>
          <v-btn v-if="isAdmin" color="primary" variant="flat" :disabled="!editingAccountId" :loading="saving" @click="saveProfile">Lưu cấu hình</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <!-- ════════ Hộp thoại mục kịch bản ════════ -->
    <v-dialog v-model="entryDialog" max-width="640">
      <v-card>
        <v-card-title>
          {{ editingEntry?.id ? 'Sửa mục' : 'Thêm mục' }}
          <span class="text-body-2 text-grey ml-2">
            {{ entryForm.zaloAccountId ? `riêng nick ${accountName(entryForm.zaloAccountId)}` : 'dùng chung mọi nick' }}
          </span>
        </v-card-title>
        <v-card-text>
          <v-alert v-if="entryError" type="error" density="compact" class="mb-3">{{ entryError }}</v-alert>
          <v-text-field v-model="entryForm.title" label="Tiêu đề" counter="200" class="mb-2" />
          <v-text-field v-model="entryForm.category" label="Nhóm (tuỳ chọn)" placeholder="bảng giá / ship / đổi trả / FAQ" class="mb-2" />
          <v-combobox
            v-model="entryForm.keywords"
            label="Từ khoá kích hoạt"
            multiple chips closable-chips
            hint="Khách nhắn trúng một từ thì mục được ưu tiên. Để trống = luôn cân nhắc."
            persistent-hint
            class="mb-2"
          />
          <v-textarea v-model="entryForm.content" label="Nội dung" rows="8" counter="8000" class="mt-3" />
          <div class="d-flex align-center" style="gap: 24px;">
            <v-text-field v-model.number="entryForm.priority" type="number" label="Ưu tiên (0-100)" min="0" max="100" density="compact" style="max-width: 180px;" />
            <v-switch v-model="entryForm.enabled" color="primary" inset label="Đang bật" hide-details />
          </div>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="entryDialog = false">Huỷ</v-btn>
          <v-btn color="primary" :loading="savingEntry" @click="saveEntry">Lưu</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted, defineComponent, h, type PropType } from 'vue';
import { VBtn, VChip, VTable, VAlert } from 'vuetify/components';
import { api } from '@/api/index';
import { useToast } from '@/composables/use-toast';
import { useAuthStore } from '@/stores/auth';

interface PlaybookEntry {
  id: string; zaloAccountId: string | null; title: string; category: string | null; keywords: string[];
  content: string; priority: number; enabled: boolean;
}
interface Profile {
  zaloAccountId: string; enabled: boolean; mode: 'auto' | 'dry_run'; triggerTags: string[];
  hourStart: number; hourEnd: number; debounceSeconds: number; maxRepliesPerDay: number;
  maxRepliesPerConvPerDay: number; skipIfStaffRepliedWithinMin: number; blockedKeywords: string[];
  persona: string | null; extraInstruction: string | null; verifyGrounding: boolean;
}
interface ProfileCard extends Profile {
  accountName: string; accountStatus: string; today: Record<string, number>;
}
interface AccountRow { id: string; name: string; status: string; configured: boolean }
interface LogRow {
  id: string; conversationId: string; decision: string; reason: string | null; content: string | null;
  createdAt: string; customerName: string | null; nickName: string | null;
}
type TagOption = { value: string; text: string; color: string; emoji?: string | null; count: number };

/** Bảng mục kịch bản (dùng cho cả khung chung lẫn khung riêng từng nick). */
const PlaybookTable = defineComponent({
  props: {
    entries: { type: Array as PropType<PlaybookEntry[]>, required: true },
    editable: { type: Boolean, default: false },
  },
  emits: ['edit', 'remove'],
  setup(props, { emit }) {
    return () => props.entries.length === 0
      ? h(VAlert, { type: 'info', density: 'compact', variant: 'tonal' }, () => 'Chưa có mục nào. Nên thêm: bảng giá, phí ship, chính sách đổi trả, câu hỏi thường gặp.')
      : h(VTable, { density: 'compact' }, () => [
        h('thead', h('tr', ['Tiêu đề', 'Nhóm', 'Từ khoá', 'Ưu tiên', 'Bật', ''].map((t) => h('th', t)))),
        h('tbody', props.entries.map((e) => h('tr', { key: e.id }, [
          h('td', { class: 'aar-cell-title' }, e.title),
          h('td', e.category || '—'),
          h('td', e.keywords?.length
            ? e.keywords.map((k) => h(VChip, { size: 'x-small', class: 'mr-1' }, () => k))
            : h('span', { class: 'text-grey' }, 'luôn cân nhắc')),
          h('td', String(e.priority)),
          h('td', e.enabled ? '✓' : '—'),
          h('td', { class: 'text-right' }, props.editable ? [
            h(VBtn, { size: 'x-small', variant: 'text', icon: 'mdi-pencil', onClick: () => emit('edit', e) }),
            h(VBtn, { size: 'x-small', variant: 'text', icon: 'mdi-delete-outline', color: 'error', onClick: () => emit('remove', e) }),
          ] : []),
        ]))),
      ]);
  },
});

const toast = useToast();
const auth = useAuthStore();
const isAdmin = computed(() => ['owner', 'admin'].includes(auth.user?.role || ''));

const profiles = ref<ProfileCard[]>([]);
const accounts = ref<AccountRow[]>([]);
const playbook = ref<PlaybookEntry[]>([]);
const logs = ref<LogRow[]>([]);
const logAccount = ref('');
const loadError = ref('');

const unconfiguredAccounts = computed(() => accounts.value.filter((a) => !a.configured));
const sharedEntries = computed(() => playbook.value.filter((e) => !e.zaloAccountId));
const logAccountItems = computed(() => [
  { title: 'Mọi nick', value: '' },
  ...profiles.value.map((p) => ({ title: p.accountName, value: p.zaloAccountId })),
]);

// ── Editor 1 nick ──
const editorOpen = ref(false);
const editingAccountId = ref<string | null>(null);
const editingConfigured = ref(false);
const newAccountId = ref<string | null>(null);
const saving = ref(false);
const loadingTags = ref(false);
const zaloTags = ref<TagOption[]>([]);
const crmTags = ref<TagOption[]>([]);
const form = reactive<Omit<Profile, 'zaloAccountId'>>({
  enabled: false, mode: 'dry_run', triggerTags: [], hourStart: 7, hourEnd: 22, debounceSeconds: 20,
  maxRepliesPerDay: 300, maxRepliesPerConvPerDay: 15, skipIfStaffRepliedWithinMin: 10, blockedKeywords: [],
  persona: '', extraInstruction: '', verifyGrounding: true,
});
const nickEntries = computed(() => playbook.value.filter((e) => e.zaloAccountId === editingAccountId.value));
const selectedCount = computed(() =>
  [...zaloTags.value, ...crmTags.value].filter((o) => form.triggerTags.includes(o.value)).reduce((s, o) => s + o.count, 0));

// ── Mục kịch bản ──
const entryDialog = ref(false);
const savingEntry = ref(false);
const entryError = ref('');
const editingEntry = ref<PlaybookEntry | null>(null);
const entryForm = reactive({
  zaloAccountId: null as string | null, title: '', category: '', keywords: [] as string[], content: '', priority: 0, enabled: true,
});

// ── Chạy thử ──
const testInput = ref('');
const testing = ref(false);
const testResult = ref<{ decision: string; reason: string; content?: string } | null>(null);

function errorText(err: unknown, fallback: string) {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback;
}
function cleanTag(t: string) { return t.replace(/^🔵\s*/, ''); }
function accountName(id: string | null) {
  return accounts.value.find((a) => a.id === id)?.name || '';
}
function statusLabel(p: Profile) {
  if (!p.enabled) return 'Đang tắt';
  return p.mode === 'auto' ? 'Tự gửi' : 'Chạy thử';
}
function statusColor(p: Profile) {
  if (!p.enabled) return 'grey';
  return p.mode === 'auto' ? 'success' : 'info';
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

async function loadProfiles() {
  const { data } = await api.get('/ai/auto-reply/profiles');
  profiles.value = data.profiles;
  accounts.value = data.accounts;
}
async function loadPlaybook() {
  playbook.value = (await api.get('/ai/auto-reply/playbook')).data.entries;
}
async function loadLogs() {
  try {
    const { data } = await api.get('/ai/auto-reply/logs', { params: { limit: 50, ...(logAccount.value ? { accountId: logAccount.value } : {}) } });
    logs.value = data.logs;
  } catch { /* nhật ký lỗi không chặn trang */ }
}

async function loadAll() {
  try {
    await Promise.all([loadProfiles(), loadPlaybook()]);
    loadError.value = '';
  } catch (err) {
    loadError.value = errorText(err, 'Không tải được cài đặt AI tự trả lời');
  }
  await loadLogs();
}

async function loadTagsFor(accountId: string) {
  loadingTags.value = true;
  try {
    const res = await api.get('/ai/auto-reply/tags', { params: { accountIds: accountId } });
    zaloTags.value = res.data.zalo[0]?.labels ?? [];
    crmTags.value = res.data.crm ?? [];
  } finally {
    loadingTags.value = false;
  }
}

async function loadEditor(accountId: string) {
  const [{ data }] = await Promise.all([api.get(`/ai/auto-reply/profiles/${accountId}`), loadTagsFor(accountId)]);
  const p = data.profile as Profile;
  Object.assign(form, p, { persona: p.persona ?? '', extraInstruction: p.extraInstruction ?? '' });
  editingConfigured.value = !!data.configured;
  // Thẻ đã lưu mà nick không còn (vd thẻ Zalo bị xoá) vẫn hiện để bỏ chọn được.
  const available = new Set([...zaloTags.value, ...crmTags.value].map((o) => o.value));
  const missing = form.triggerTags.filter((t) => !available.has(t));
  if (missing.length) crmTags.value = [...crmTags.value, ...missing.map((t) => ({ value: t, text: `${cleanTag(t)} (không còn)`, color: 'grey', count: 0 }))];
}

async function openProfile(accountId: string) {
  editingAccountId.value = accountId;
  editingConfigured.value = true;
  newAccountId.value = null;
  editorOpen.value = true;
  try {
    await loadEditor(accountId);
  } catch (err) {
    toast.error(errorText(err, 'Không tải được cấu hình nick'));
  }
}
function openNew() {
  editingAccountId.value = null;
  newAccountId.value = null;
  editingConfigured.value = false;
  editorOpen.value = true;
}
async function selectNewAccount(id: string | null) {
  if (!id) return;
  editingAccountId.value = id;
  try {
    await loadEditor(id);
    editingConfigured.value = false; // nick mới — vẫn cho đổi nick trước khi lưu
  } catch (err) {
    toast.error(errorText(err, 'Không tải được thẻ của nick'));
  }
}

async function saveProfile() {
  if (!editingAccountId.value) return;
  if (form.enabled && form.triggerTags.length === 0) {
    toast.warning('Chưa chọn thẻ kích hoạt nào: AI sẽ không trả lời ai cả.');
  }
  saving.value = true;
  try {
    await api.put(`/ai/auto-reply/profiles/${editingAccountId.value}`, { ...form });
    toast.success(`Đã lưu cấu hình AI cho nick ${accountName(editingAccountId.value)}`);
    editorOpen.value = false;
    await loadProfiles();
  } catch (err) {
    toast.error(errorText(err, 'Không lưu được cấu hình'));
  } finally {
    saving.value = false;
  }
}
async function removeProfile() {
  const id = editingAccountId.value;
  if (!id || !window.confirm(`Xoá cấu hình AI của nick "${accountName(id)}"? AI sẽ ngừng trả lời khách của nick này.`)) return;
  try {
    await api.delete(`/ai/auto-reply/profiles/${id}`);
    editorOpen.value = false;
    await loadProfiles();
    toast.success('Đã xoá cấu hình');
  } catch (err) {
    toast.error(errorText(err, 'Không xoá được'));
  }
}

function openEntry(entry: PlaybookEntry | null, accountId: string | null) {
  editingEntry.value = entry;
  Object.assign(entryForm, entry
    ? { ...entry, category: entry.category ?? '', keywords: [...(entry.keywords || [])] }
    : { zaloAccountId: accountId, title: '', category: '', keywords: [], content: '', priority: 0, enabled: true });
  entryError.value = '';
  entryDialog.value = true;
}
async function saveEntry() {
  savingEntry.value = true;
  entryError.value = '';
  try {
    const body = { ...entryForm, category: entryForm.category || null };
    if (editingEntry.value?.id) await api.put(`/ai/auto-reply/playbook/${editingEntry.value.id}`, body);
    else await api.post('/ai/auto-reply/playbook', body);
    entryDialog.value = false;
    await loadPlaybook();
  } catch (err) {
    entryError.value = errorText(err, 'Không lưu được mục kịch bản');
  } finally {
    savingEntry.value = false;
  }
}
async function removeEntry(entry: PlaybookEntry) {
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
.aar { max-width: 1100px; }
.aar-title h2 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
.aar-title p { color: rgba(var(--v-theme-on-surface), 0.7); margin-bottom: 16px; line-height: 1.5; }
.aar-section-title { font-weight: 600; margin-bottom: 8px; }
.aar-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; }
.aar-card {
  text-align: left; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 10px; padding: 14px; background: rgb(var(--v-theme-surface)); cursor: pointer;
  display: flex; flex-direction: column; gap: 6px; transition: box-shadow 0.15s, border-color 0.15s;
}
.aar-card:hover { border-color: rgb(var(--v-theme-primary)); box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08); }
.aar-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
.aar-avatar {
  width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0;
  background: rgb(var(--v-theme-primary)); color: #fff; font-weight: 600;
}
.aar-card-name { flex: 1; min-width: 0; }
.aar-card-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.aar-card-sub { font-size: 12px; color: rgba(var(--v-theme-on-surface), 0.6); }
.aar-card-row { font-size: 13px; display: flex; align-items: center; flex-wrap: wrap; gap: 2px; }
.aar-card-label { color: rgba(var(--v-theme-on-surface), 0.6); margin-right: 4px; }
.aar-ellipsis { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
.aar-card-foot { font-size: 12px; color: rgba(var(--v-theme-on-surface), 0.6); margin-top: 4px; }
.aar-card-add {
  border-style: dashed; align-items: center; justify-content: center; min-height: 150px;
  color: rgb(var(--v-theme-primary)); font-weight: 500;
}
.aar-card-add:disabled { color: rgba(var(--v-theme-on-surface), 0.4); cursor: default; }
.aar-add-plus { font-size: 28px; line-height: 1; }
.aar-editor { max-height: 72vh; }
.aar-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.aar-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.aar-hours { display: flex; align-items: center; gap: 8px; }
.aar-step { font-weight: 600; margin-bottom: 8px; }
.aar-taggroup-title { font-size: 13px; margin-bottom: 4px; }
.aar-count { margin-left: 6px; font-size: 11px; opacity: 0.7; }
.aar-hint { font-size: 13px; color: rgba(var(--v-theme-on-surface), 0.65); margin: 4px 0 8px; }
.aar-reply { white-space: pre-wrap; margin-top: 4px; }
.aar-nowrap { white-space: nowrap; }
:deep(.aar-cell-title) { font-weight: 500; }
</style>
