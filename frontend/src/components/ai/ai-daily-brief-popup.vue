<template>
  <Teleport to="body">
    <!-- Nút nổi (mobile: ẩn khi panel mở toàn màn hình, header đã có nút đóng) -->
    <button
      v-if="authStore.isAuthenticated && !(isMobile && isOpen) && (!onChat || isOpen)"
      class="adb-fab"
      :class="{ 'adb-fab--open': isOpen, 'adb-fab--mobile': isMobile }"
      type="button"
      :title="isOpen ? 'Đóng trợ lý AI' : 'Hỏi AI về khách hôm nay'"
      :aria-expanded="isOpen"
      aria-controls="adb-panel"
      @click="toggle"
    >
      <span class="adb-fab__icon" aria-hidden="true">
        <v-icon size="20">{{ isOpen ? 'mdi-close' : 'mdi-creation' }}</v-icon>
      </span>
      <span v-if="!isMobile" class="adb-fab__label">{{ isOpen ? 'Đóng' : 'Hỏi AI về khách hôm nay' }}</span>
      <span v-if="unseenAnswers > 0 && !isOpen" class="adb-fab__badge">{{ unseenAnswers }}</span>
    </button>

    <!-- Panel -->
    <Transition name="adb-panel">
      <section
        v-if="isOpen && authStore.isAuthenticated"
        id="adb-panel"
        class="adb-panel"
        :class="{ 'adb-panel--mobile': isMobile }"
        role="dialog"
        aria-label="Trợ lý AI — tình trạng khách hàng hôm nay"
        @keydown.esc="close"
      >
        <!-- Header: bảng ngày -->
        <header class="adb-head">
          <div class="adb-head__row">
            <span class="adb-eyebrow"><v-icon size="13">mdi-creation</v-icon> Trợ lý AI · Khách hôm nay</span>
            <div class="adb-head__actions">
              <button class="adb-iconbtn" type="button" title="Tải lại số liệu" :disabled="snapshotLoading" @click="loadSnapshot(true)">
                <v-icon size="17" :class="{ 'adb-spin': snapshotLoading }">mdi-refresh</v-icon>
              </button>
              <button v-if="hasMessages" class="adb-iconbtn" type="button" title="Xoá hội thoại" @click="clearChat">
                <v-icon size="17">mdi-broom</v-icon>
              </button>
              <button class="adb-iconbtn" type="button" title="Đóng (Esc)" @click="close">
                <v-icon size="18">mdi-close</v-icon>
              </button>
            </div>
          </div>
          <div class="adb-date">
            <span class="adb-date__day">{{ dayNumber }}</span>
            <span class="adb-date__rest">
              <span class="adb-date__weekday">{{ weekdayLabel }}</span>
              <span class="adb-date__month">{{ monthLabel }}<template v-if="snapshot?.scope === 'user'"> · theo nick của bạn</template></span>
            </span>
          </div>
        </header>

        <!-- Sổ ngày: 4 ô số liệu -->
        <div class="adb-ledger" :class="{ 'adb-ledger--loading': snapshotLoading && !snapshot }">
          <template v-if="snapshot">
            <div class="adb-cell">
              <span class="adb-cell__n">{{ snapshot.counts.newContacts }}</span>
              <span class="adb-cell__l">Khách mới</span>
            </div>
            <div class="adb-cell">
              <span class="adb-cell__n">{{ snapshot.counts.inboundMessages }}</span>
              <span class="adb-cell__l">Tin đến</span>
            </div>
            <div
              class="adb-cell"
              :class="{ 'adb-cell--warn': snapshot.counts.unrepliedConversations > 0 }"
              :title="snapshot.counts.unrepliedBacklog ? `Khách nhắn hôm nay chưa được trả lời. Còn ${snapshot.counts.unrepliedBacklog} hội thoại tồn từ các ngày trước.` : 'Khách nhắn hôm nay chưa được trả lời'"
            >
              <span class="adb-cell__n">{{ snapshot.counts.unrepliedConversations }}<span v-if="snapshot.counts.unrepliedBacklog" class="adb-cell__sub">+{{ formatCompact(snapshot.counts.unrepliedBacklog) }}</span></span>
              <span class="adb-cell__l">Chờ trả lời</span>
            </div>
            <div class="adb-cell">
              <span class="adb-cell__n">{{ snapshot.counts.appointmentsScheduled }}<span class="adb-cell__sub">/{{ snapshot.counts.appointmentsTotal }}</span></span>
              <span class="adb-cell__l">Lịch hẹn</span>
            </div>
          </template>
          <template v-else-if="snapshotError">
            <div class="adb-ledger__error">
              {{ snapshotError }}
              <button type="button" class="adb-link" @click="loadSnapshot(true)">Thử lại</button>
            </div>
          </template>
          <template v-else>
            <div v-for="i in 4" :key="i" class="adb-cell adb-cell--skeleton"><span class="adb-cell__n">&nbsp;</span><span class="adb-cell__l">&nbsp;</span></div>
          </template>
        </div>

        <!-- Hội thoại -->
        <div ref="scrollRef" class="adb-body">
          <div v-if="!hasMessages" class="adb-empty">
            <p class="adb-empty__title">Hỏi gì về khách hôm nay?</p>
            <p class="adb-empty__hint">Trợ lý chỉ dựa trên số liệu CRM của ngày {{ snapshot?.date ? formatShort(snapshot.date) : 'hôm nay' }}, không tự bịa.</p>
            <div class="adb-chips">
              <button
                v-for="q in SUGGESTED_QUESTIONS"
                :key="q"
                type="button"
                class="adb-chip"
                :disabled="asking"
                @click="send(q)"
              >{{ q }}</button>
            </div>
          </div>

          <template v-for="m in messages" :key="m.id">
            <div v-if="m.role === 'user'" class="adb-msg adb-msg--user">
              <div class="adb-msg__pill">{{ m.content }}</div>
            </div>
            <article v-else class="adb-msg adb-msg--ai" :class="{ 'adb-msg--error': m.error }">
              <div class="adb-msg__meta">
                <span>{{ m.error ? 'Không trả lời được' : 'Trợ lý' }}</span>
                <span>{{ clock(m.at) }}</span>
              </div>
              <div class="adb-msg__note" v-html="renderBrief(m.content)" />
            </article>
          </template>

          <article v-if="asking" class="adb-msg adb-msg--ai adb-msg--typing" aria-live="polite">
            <div class="adb-msg__meta"><span>Trợ lý</span><span>đang xem số liệu…</span></div>
            <div class="adb-msg__note"><span class="adb-dot" /><span class="adb-dot" /><span class="adb-dot" /></div>
          </article>
        </div>

        <!-- Ô nhập -->
        <form class="adb-input" @submit.prevent="send(draft)">
          <textarea
            ref="inputRef"
            v-model="draft"
            class="adb-input__field"
            rows="1"
            maxlength="600"
            placeholder="Ví dụ: khách nào cần gọi lại trước 5 giờ chiều?"
            :disabled="asking"
            @keydown.enter.exact.prevent="send(draft)"
            @input="autoGrow"
          />
          <button type="submit" class="adb-send" :disabled="asking || !draft.trim()" title="Gửi (Enter)">
            <v-icon size="18">mdi-send</v-icon>
          </button>
        </form>
      </section>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useMobile } from '@/composables/use-mobile';
import { useAiDailyBrief, SUGGESTED_QUESTIONS } from '@/composables/use-ai-daily-brief';
import { formatInOrgTz, getOrgParts } from '@/composables/use-org-timezone';

const authStore = useAuthStore();
const route = useRoute();
// Trang Tin nhắn dày đặc (ô soạn tin, ghi chú, nút gửi ở mọi góc) → ẩn nút nổi, dùng ở các trang khác.
const onChat = computed(() => route.path.startsWith('/chat'));
const { isMobile } = useMobile();
const {
  isOpen, snapshot, snapshotLoading, snapshotError, messages, asking, hasMessages, unseenAnswers,
  toggle, close, ask, loadSnapshot, clearChat,
} = useAiDailyBrief();

const draft = ref('');
const scrollRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLTextAreaElement | null>(null);

const WEEKDAY = ['Chủ nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
const todayParts = computed(() => getOrgParts(snapshot.value?.generatedAt || new Date()));
const dayNumber = computed(() => String(todayParts.value?.day ?? '').padStart(2, '0'));
const weekdayLabel = computed(() => (todayParts.value ? WEEKDAY[todayParts.value.dayOfWeek] : ''));
const monthLabel = computed(() => (todayParts.value ? `tháng ${todayParts.value.month}, ${todayParts.value.year}` : ''));

/** 3549 → "3,5k" cho ô số liệu chật. */
function formatCompact(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.0', '').replace('.', ',')}k` : String(n);
}
function formatShort(dateKey: string): string {
  const [y, m, d] = dateKey.split('-');
  return `${d}/${m}/${y}`;
}
function clock(iso: string): string {
  return formatInOrgTz(iso, undefined, { timeOnly: true });
}

/** Markdown-lite an toàn: escape HTML → **đậm**, dòng "- " thành list. */
function renderBrief(text: string): string {
  const esc = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const lines = esc.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    const li = /^\s*(?:[-•*]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${li[1]}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    if (line.trim()) out.push(`<p>${line}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

async function send(text: string) {
  const q = text.trim();
  if (!q || asking.value) return;
  draft.value = '';
  autoGrow();
  await ask(q);
  nextTick(() => inputRef.value?.focus());
}

function autoGrow() {
  const el = inputRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
}

function scrollToBottom() {
  nextTick(() => {
    const el = scrollRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => messages.value.length, scrollToBottom);
watch(asking, scrollToBottom);
watch(isOpen, (open) => {
  if (open) {
    nextTick(() => { inputRef.value?.focus(); scrollToBottom(); });
  }
});
</script>

<style scoped>
/* ── Nút nổi ─────────────────────────────────────────────────────────── */
/* Máy tính: nút tròn gọn, rê chuột mới hiện chữ (nút dài cũ che phân trang / thông báo / ô soạn tin). */
.adb-fab {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 1003; /* dưới menu trượt (drawer) của Vuetify */
  display: inline-flex;
  align-items: center;
  gap: 9px;
  height: 46px;
  padding: 0 18px 0 12px;
  border: none;
  border-radius: 999px;
  background: var(--smax-header-bg, #1f2330);
  color: #fff;
  font: 600 13.5px/1 inherit;
  font-family: inherit;
  letter-spacing: 0.1px;
  cursor: pointer;
  box-shadow: 0 8px 24px rgba(31, 35, 48, 0.28), 0 1px 0 rgba(255,255,255,0.06) inset;
  transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}
.adb-fab:not(.adb-fab--mobile):not(.adb-fab--open) { height: 42px; padding: 0 8px; gap: 0; }
.adb-fab:not(.adb-fab--mobile):not(.adb-fab--open) .adb-fab__label {
  max-width: 0; overflow: hidden; white-space: nowrap; transition: max-width 0.2s ease, margin 0.2s ease;
}
.adb-fab:not(.adb-fab--mobile):not(.adb-fab--open):hover .adb-fab__label,
.adb-fab:not(.adb-fab--mobile):not(.adb-fab--open):focus-visible .adb-fab__label { max-width: 220px; margin: 0 8px 0 9px; }

.adb-fab:hover { transform: translateY(-1px); box-shadow: 0 12px 28px rgba(31, 35, 48, 0.32); }
.adb-fab:focus-visible { outline: 3px solid rgba(41, 98, 255, 0.45); outline-offset: 2px; }
.adb-fab--open { background: var(--smax-grey-700, #5a6478); }
.adb-fab--mobile { width: 52px; height: 52px; padding: 0; justify-content: center; bottom: 84px; right: 16px; }
.adb-fab__icon {
  width: 26px; height: 26px; border-radius: 50%;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--smax-primary, #2962ff);
  color: #fff;
}
.adb-fab--open .adb-fab__icon { background: rgba(255,255,255,0.14); }
.adb-fab__badge {
  position: absolute; top: -4px; right: -2px;
  min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 9px; background: var(--smax-warning, #ff9100);
  color: #1f2330; font-size: 11px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
  border: 2px solid #fff;
}

/* ── Panel ───────────────────────────────────────────────────────────── */
.adb-panel {
  position: fixed;
  right: 22px;
  bottom: 80px;
  z-index: 1199;
  width: 400px;
  max-width: calc(100vw - 32px);
  height: min(640px, calc(100vh - 110px));
  display: flex;
  flex-direction: column;
  background: var(--smax-bg, #fff);
  color: var(--smax-text, #212121);
  border-radius: 14px;
  border: 1px solid var(--smax-grey-200, #ebedf0);
  box-shadow: 0 24px 60px rgba(31, 35, 48, 0.22);
  overflow: hidden;
  font-size: 13.5px;
}
.adb-panel--mobile {
  inset: 0;
  width: auto; max-width: none; height: auto;
  border-radius: 0; border: none;
  padding-bottom: env(safe-area-inset-bottom);
}
.adb-panel-enter-active, .adb-panel-leave-active { transition: opacity 0.18s ease, transform 0.18s ease; }
.adb-panel-enter-from, .adb-panel-leave-to { opacity: 0; transform: translateY(12px) scale(0.98); }

/* Header — "sổ ngày" */
.adb-head {
  background: var(--smax-header-bg, #1f2330);
  color: #fff;
  padding: 12px 14px 12px 16px;
  flex-shrink: 0;
}
.adb-head__row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.adb-eyebrow {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.9px; text-transform: uppercase;
  color: rgba(255,255,255,0.72);
}
.adb-head__actions { display: flex; gap: 2px; }
.adb-iconbtn {
  width: 30px; height: 30px; border-radius: 8px; border: none;
  background: transparent; color: rgba(255,255,255,0.78); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
}
.adb-iconbtn:hover:not(:disabled) { background: rgba(255,255,255,0.1); color: #fff; }
.adb-iconbtn:disabled { opacity: 0.5; cursor: default; }
.adb-iconbtn:focus-visible { outline: 2px solid rgba(255,255,255,0.6); }
.adb-spin { animation: adb-spin 0.9s linear infinite; }
@keyframes adb-spin { to { transform: rotate(360deg); } }

.adb-date { display: flex; align-items: baseline; gap: 10px; margin-top: 6px; }
.adb-date__day {
  font-size: 34px; font-weight: 700; line-height: 1; letter-spacing: -1.2px;
  font-variant-numeric: tabular-nums;
}
.adb-date__rest { display: flex; flex-direction: column; line-height: 1.2; }
.adb-date__weekday { font-size: 14px; font-weight: 600; }
.adb-date__month { font-size: 12px; color: rgba(255,255,255,0.62); }

/* Ledger */
.adb-ledger {
  display: grid; grid-template-columns: repeat(4, 1fr);
  background: var(--smax-grey-50, #fafbfc);
  border-bottom: 1px solid var(--smax-grey-200, #ebedf0);
  flex-shrink: 0;
}
.adb-cell {
  padding: 10px 6px 9px; text-align: center;
  border-right: 1px solid var(--smax-grey-200, #ebedf0);
  display: flex; flex-direction: column; gap: 2px;
}
.adb-cell:last-child { border-right: none; }
.adb-cell__n { font-size: 20px; font-weight: 700; line-height: 1.1; letter-spacing: -0.4px; font-variant-numeric: tabular-nums; }
.adb-cell__sub { font-size: 12px; font-weight: 500; color: var(--smax-grey-700, #5a6478); }
.adb-cell__l { font-size: 10.5px; color: var(--smax-grey-700, #5a6478); text-transform: uppercase; letter-spacing: 0.5px; }
.adb-cell--warn .adb-cell__n { color: #ef6c00; }
.adb-cell--skeleton .adb-cell__n, .adb-cell--skeleton .adb-cell__l {
  background: var(--smax-grey-200, #ebedf0); border-radius: 4px; margin: 0 auto; width: 60%;
  animation: adb-pulse 1.2s ease-in-out infinite;
}
@keyframes adb-pulse { 50% { opacity: 0.45; } }
.adb-ledger__error { grid-column: 1 / -1; padding: 10px 14px; font-size: 12.5px; color: #c62828; }
.adb-link { background: none; border: none; color: var(--smax-primary, #2962ff); cursor: pointer; font-weight: 600; padding: 0 0 0 6px; font-family: inherit; }

/* Body */
.adb-body { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.adb-empty { margin-top: 6px; }
.adb-empty__title { font-size: 15.5px; font-weight: 700; margin: 0 0 4px; letter-spacing: -0.2px; }
.adb-empty__hint { margin: 0 0 12px; font-size: 12.5px; color: var(--smax-grey-700, #5a6478); }
.adb-chips { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.adb-chip {
  text-align: left; font-family: inherit; font-size: 12.5px; line-height: 1.3;
  padding: 7px 11px; border-radius: 9px;
  border: 1px solid var(--smax-grey-300, #d4d8de); background: var(--smax-bg, #fff);
  color: var(--smax-text, #212121); cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.adb-chip:hover:not(:disabled) { border-color: var(--smax-primary, #2962ff); background: var(--smax-primary-soft, #e3f2fd); }
.adb-chip:disabled { opacity: 0.5; cursor: default; }

.adb-msg--user { display: flex; justify-content: flex-end; }
.adb-msg__pill {
  max-width: 85%; padding: 8px 12px; border-radius: 13px 13px 3px 13px;
  background: var(--smax-bubble-self, #d0e6ff); color: var(--smax-text, #212121);
  white-space: pre-wrap; word-break: break-word; line-height: 1.4;
}
.adb-msg--ai { border-left: 2px solid var(--smax-primary, #2962ff); padding-left: 12px; }
.adb-msg--error { border-left-color: #ef5350; }
.adb-msg__meta {
  display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px;
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.7px; text-transform: uppercase;
  color: var(--smax-grey-700, #5a6478);
}
.adb-msg--error .adb-msg__meta { color: #c62828; }
.adb-msg__note { line-height: 1.5; word-break: break-word; }
.adb-msg__note :deep(p) { margin: 0 0 6px; }
.adb-msg__note :deep(p:last-child) { margin-bottom: 0; }
.adb-msg__note :deep(ul) { margin: 0 0 6px; padding-left: 18px; }
.adb-msg__note :deep(li) { margin: 2px 0; }
.adb-msg__note :deep(strong) { font-weight: 700; }

.adb-msg--typing .adb-msg__note { display: flex; gap: 4px; padding: 4px 0; }
.adb-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--smax-grey-300, #d4d8de); animation: adb-bounce 1.1s infinite ease-in-out; }
.adb-dot:nth-child(2) { animation-delay: 0.15s; }
.adb-dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes adb-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: 0.5; } 40% { transform: translateY(-4px); opacity: 1; } }

/* Input */
.adb-input {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 10px 12px; border-top: 1px solid var(--smax-grey-200, #ebedf0);
  background: var(--smax-bg, #fff); flex-shrink: 0;
}
.adb-input__field {
  flex: 1; resize: none; min-height: 38px; max-height: 120px;
  padding: 9px 12px; border-radius: 10px;
  border: 1px solid var(--smax-grey-300, #d4d8de);
  font: inherit; font-size: 13.5px; line-height: 1.4; color: var(--smax-text, #212121);
  background: var(--smax-grey-50, #fafbfc);
}
.adb-input__field:focus { outline: none; border-color: var(--smax-primary, #2962ff); box-shadow: 0 0 0 3px rgba(41, 98, 255, 0.12); background: #fff; }
.adb-input__field:disabled { opacity: 0.6; }
.adb-send {
  width: 38px; height: 38px; border-radius: 10px; border: none; flex-shrink: 0;
  background: var(--smax-primary, #2962ff); color: #fff; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center;
  transition: background 0.15s, opacity 0.15s;
}
.adb-send:hover:not(:disabled) { background: var(--smax-primary-hover, #1565c0); }
.adb-send:disabled { opacity: 0.4; cursor: default; }
.adb-send:focus-visible { outline: 3px solid rgba(41, 98, 255, 0.4); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  .adb-fab, .adb-panel-enter-active, .adb-panel-leave-active, .adb-chip, .adb-send { transition: none; }
  .adb-spin, .adb-dot, .adb-cell--skeleton .adb-cell__n, .adb-cell--skeleton .adb-cell__l { animation: none; }
}
</style>
