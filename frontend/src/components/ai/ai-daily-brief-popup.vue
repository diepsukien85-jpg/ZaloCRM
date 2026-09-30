<template>
  <div class="brief-root" :style="{ bottom: `${bottomOffset}px` }">
    <!-- ── Popup ───────────────────────────────────────────────────────── -->
    <transition name="brief-pop">
      <div v-if="open" class="brief-card" role="dialog" aria-label="Trợ lý AI khách hàng hôm nay">
        <header class="brief-head">
          <div class="brief-avatar"><v-icon size="18" color="white">mdi-robot-happy-outline</v-icon></div>
          <div class="brief-title">
            <div class="t">Trợ lý AI · Hôm nay</div>
            <div class="s">{{ subtitle }}</div>
          </div>
          <v-btn icon size="x-small" variant="text" title="Làm mới số liệu" :loading="loadingSnapshot" @click="refresh">
            <v-icon size="18">mdi-refresh</v-icon>
          </v-btn>
          <v-btn icon size="x-small" variant="text" title="Xoá hội thoại" :disabled="!messages.length" @click="clearChat">
            <v-icon size="18">mdi-broom</v-icon>
          </v-btn>
          <v-btn icon size="x-small" variant="text" title="Đóng" @click="close">
            <v-icon size="18">mdi-close</v-icon>
          </v-btn>
        </header>

        <!-- KPI nhanh -->
        <div v-if="snapshot" class="brief-kpis">
          <span class="kpi" title="Khách mới hôm nay"><b>{{ snapshot.kpi.newContacts }}</b> KH mới</span>
          <span class="kpi" title="Khách có tin nhắn đến hôm nay"><b>{{ snapshot.kpi.activeCustomers }}</b> đang tương tác</span>
          <span class="kpi" :class="{ warn: snapshot.kpi.unrepliedConversations > 0 }" title="Hội thoại chưa trả lời"><b>{{ snapshot.kpi.unrepliedConversations }}</b> chưa trả lời</span>
          <span class="kpi" title="Lịch hẹn hôm nay"><b>{{ snapshot.kpi.appointmentsToday }}</b> lịch hẹn</span>
          <span v-if="snapshot.kpi.stuckLeads > 0" class="kpi warn" title="Khách đình trệ"><b>{{ snapshot.kpi.stuckLeads }}</b> đình trệ</span>
        </div>

        <!-- Hội thoại -->
        <div ref="scrollRef" class="brief-body">
          <div class="msg msg--ai">
            <div class="bubble">
              Chào {{ firstName }} 👋 Hỏi mình bất cứ điều gì về khách hàng hôm nay: khách mới, ai đang chờ trả lời, lịch hẹn, việc nên ưu tiên…
            </div>
          </div>

          <div v-for="(m, i) in messages" :key="i" class="msg" :class="m.role === 'user' ? 'msg--user' : 'msg--ai'">
            <div class="bubble" :class="{ 'bubble--error': m.error }">{{ m.content }}</div>
            <div v-if="m.role === 'assistant' && !m.error" class="meta">
              <span v-if="m.source === 'fallback'" class="fallback-tag" title="AI chưa bật hoặc chưa có API key — đây là tóm tắt tự động">tóm tắt tự động</span>
              <button v-if="canSpeak" class="speak" :class="{ on: speakingIndex === i }" :title="speakingIndex === i ? 'Dừng đọc' : 'Đọc to câu trả lời'" @click="toggleSpeak(i, m.content)">
                <v-icon size="15">{{ speakingIndex === i ? 'mdi-stop-circle-outline' : 'mdi-volume-high' }}</v-icon>
              </button>
            </div>
          </div>

          <div v-if="asking" class="msg msg--ai">
            <div class="bubble typing"><span></span><span></span><span></span></div>
          </div>
        </div>

        <!-- Gợi ý câu hỏi -->
        <div class="brief-suggest">
          <button v-for="q in suggestions" :key="q" class="chip" :disabled="asking" @click="send(q)">{{ q }}</button>
        </div>

        <!-- Nhập câu hỏi -->
        <footer class="brief-input">
          <textarea
            ref="inputRef"
            v-model="draft"
            rows="1"
            maxlength="500"
            placeholder="Hỏi về khách hàng hôm nay… (Enter để gửi)"
            :disabled="asking"
            @keydown.enter.exact.prevent="send()"
          />
          <v-btn icon size="small" color="primary" variant="flat" :disabled="!draft.trim() || asking" :loading="asking" title="Gửi" @click="send()">
            <v-icon size="18">mdi-send</v-icon>
          </v-btn>
        </footer>
      </div>
    </transition>

    <!-- ── Nút nổi ─────────────────────────────────────────────────────── -->
    <button class="brief-fab" :class="{ open }" :title="open ? 'Đóng trợ lý AI' : 'Hỏi AI về khách hàng hôm nay'" @click="toggle">
      <v-icon size="24" color="white">{{ open ? 'mdi-close' : 'mdi-robot-happy-outline' }}</v-icon>
      <span v-if="!open && unrepliedBadge > 0" class="badge">{{ unrepliedBadge > 99 ? '99+' : unrepliedBadge }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, watch } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useToast } from '@/composables/use-toast';
import { useDailyBrief } from '@/composables/use-daily-brief';

withDefaults(defineProps<{ bottomOffset?: number }>(), { bottomOffset: 24 });

const auth = useAuthStore();
const toast = useToast();
const {
  open, messages, snapshot, asking, loadingSnapshot, lastError, unrepliedBadge, suggestions,
  loadSnapshot, ask, clear,
} = useDailyBrief();

const draft = ref('');
const scrollRef = ref<HTMLElement | null>(null);
const inputRef = ref<HTMLTextAreaElement | null>(null);

const firstName = computed(() => (auth.user?.fullName || '').trim().split(' ').pop() || 'bạn');
const subtitle = computed(() => {
  if (!snapshot.value) return 'Tình trạng khách hàng trong ngày';
  const [y, m, d] = snapshot.value.date.split('-');
  return `${d}/${m}/${y} · ${snapshot.value.scope === 'mine' ? 'khách của bạn' : 'toàn tổ chức'}`;
});

function scrollToBottom() {
  nextTick(() => {
    const el = scrollRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

async function refresh() {
  await loadSnapshot(true);
  if (lastError.value) toast.push(lastError.value, 'error');
}

async function send(preset?: string) {
  const question = (preset ?? draft.value).trim();
  if (!question || asking.value) return;
  if (!preset) draft.value = '';
  scrollToBottom();
  const err = await ask(question);
  if (err) toast.push(err, 'error');
  scrollToBottom();
  nextTick(() => inputRef.value?.focus());
}

function clearChat() {
  stopSpeaking();
  clear();
}

function toggle() {
  open.value ? close() : openPopup();
}
async function openPopup() {
  open.value = true;
  scrollToBottom();
  nextTick(() => inputRef.value?.focus());
  await loadSnapshot();
  if (lastError.value) toast.push(lastError.value, 'error');
}
function close() {
  stopSpeaking();
  open.value = false;
}

// ── Đọc to câu trả lời (Web Speech API, giọng tiếng Việt nếu trình duyệt có) ──
const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;
const speakingIndex = ref<number | null>(null);

function stopSpeaking() {
  if (!canSpeak) return;
  window.speechSynthesis.cancel();
  speakingIndex.value = null;
}
function toggleSpeak(index: number, text: string) {
  if (!canSpeak) return;
  if (speakingIndex.value === index) { stopSpeaking(); return; }
  stopSpeaking();
  const utter = new SpeechSynthesisUtterance(text.replace(/[•▪◦]/g, ' '));
  utter.lang = 'vi-VN';
  const viVoice = window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('vi'));
  if (viVoice) utter.voice = viVoice;
  utter.onend = () => { if (speakingIndex.value === index) speakingIndex.value = null; };
  utter.onerror = () => { if (speakingIndex.value === index) speakingIndex.value = null; };
  speakingIndex.value = index;
  window.speechSynthesis.speak(utter);
}

watch(open, (v) => { if (v) scrollToBottom(); });
watch(() => messages.value.length, scrollToBottom);
onBeforeUnmount(stopSpeaking);
</script>

<style scoped>
/* Đồng bộ với design system "Blue Light / Nunito" (noibo-theme.css, 29/09/2026).
   Dùng token --nb-* thay cho --smax-* cũ; giữ fallback để không vỡ nếu file
   token chưa nạp kịp. Khối cuối file xử lý theme tối cũ (legacy-dark). */
.brief-root {
  position: fixed;
  right: 20px;
  z-index: 1500;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 12px;
  pointer-events: none;
}
.brief-root > * { pointer-events: auto; }

/* ── Nút nổi ── */
.brief-fab {
  position: relative;
  width: 54px; height: 54px;
  border-radius: 50%;
  border: none; cursor: pointer;
  background: linear-gradient(135deg, var(--nb-primary, #2563EB), var(--nb-accent, #0EA5E9));
  box-shadow: var(--nb-shadow-lg, 0 8px 40px rgba(37, 99, 235, 0.18));
  display: flex; align-items: center; justify-content: center;
  transition: transform .18s var(--nb-ease, ease), box-shadow .18s var(--nb-ease, ease);
}
.brief-fab:hover { transform: translateY(-2px); box-shadow: 0 12px 44px rgba(37, 99, 235, .3); }
.brief-fab:active { transform: translateY(0) scale(.96); }
.brief-fab.open { background: var(--nb-sidebar, #1E3A5F); }
.brief-fab .badge {
  position: absolute; top: -4px; right: -4px;
  min-width: 21px; height: 21px; padding: 0 6px;
  border-radius: 11px;
  background: var(--nb-danger, #EF4444); color: #fff;
  font-size: 11px; font-weight: 800; line-height: 21px;
  border: 2px solid var(--nb-surface, #fff);
}

/* ── Khung popup ── */
.brief-card {
  width: min(404px, calc(100vw - 24px));
  height: min(576px, calc(100vh - 120px));
  background: var(--nb-surface, #fff);
  color: var(--nb-text, #0F172A);
  border: 1px solid var(--nb-border-light, #DBEAFE);
  border-radius: var(--nb-radius, 16px);
  box-shadow: var(--nb-shadow-lg, 0 8px 40px rgba(37, 99, 235, 0.18));
  display: flex; flex-direction: column;
  overflow: hidden;
}
.brief-head {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 10px 12px 14px;
  background: var(--nb-sidebar, #1E3A5F);
  color: #fff;
}
.brief-head :deep(.v-btn) { color: rgba(255, 255, 255, .82); }
.brief-avatar {
  width: 34px; height: 34px;
  border-radius: var(--nb-radius-sm, 10px);
  background: linear-gradient(135deg, var(--nb-primary-light, #3B82F6), var(--nb-accent, #0EA5E9));
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.brief-title { flex: 1; min-width: 0; }
.brief-title .t { font-size: 14.5px; font-weight: 800; line-height: 1.2; }
.brief-title .s {
  font-size: 11.5px; color: rgba(203, 213, 225, .8);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* ── Dải chỉ số ── */
.brief-kpis {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 11px 12px 7px;
  background: var(--nb-primary-50, #EFF6FF);
  border-bottom: 1px solid var(--nb-border-light, #DBEAFE);
}
.kpi {
  font-size: 11.5px; font-weight: 600;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--nb-surface, #fff);
  border: 1px solid var(--nb-border, #BFDBFE);
  color: var(--nb-text-2, #475569);
  white-space: nowrap;
}
.kpi b { color: var(--nb-primary-dark, #1D4ED8); margin-right: 3px; font-weight: 800; }
.kpi.warn {
  background: var(--nb-warning-bg, #FEF3C7);
  border-color: var(--nb-warning, #F59E0B);
  color: #92400E;
}
.kpi.warn b { color: #92400E; }

/* ── Vùng hội thoại ── */
.brief-body {
  flex: 1; overflow-y: auto;
  padding: 14px 12px;
  display: flex; flex-direction: column; gap: 10px;
  background: var(--nb-bg, #F0F7FF);
}
.msg { display: flex; flex-direction: column; max-width: 88%; }
.msg--ai { align-self: flex-start; }
.msg--user { align-self: flex-end; align-items: flex-end; }
.bubble {
  padding: 10px 13px;
  border-radius: var(--nb-radius-md, 12px);
  font-size: 13.5px; line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
  animation: nbSlideUp .24s var(--nb-ease, ease-out) both;
}
.msg--ai .bubble {
  background: var(--nb-surface, #fff);
  border: 1px solid var(--nb-border-light, #DBEAFE);
  border-bottom-left-radius: var(--nb-radius-xs, 8px);
  box-shadow: var(--nb-shadow-sm, 0 2px 8px rgba(37, 99, 235, .08));
}
.msg--ai .bubble--error {
  background: var(--nb-warning-bg, #FEF3C7);
  border-color: var(--nb-warning, #F59E0B);
  color: #92400E;
}
.msg--user .bubble {
  background: var(--nb-primary, #2563EB);
  color: #fff;
  border-bottom-right-radius: var(--nb-radius-xs, 8px);
  box-shadow: var(--nb-shadow-sm, 0 2px 8px rgba(37, 99, 235, .08));
}
.meta { display: flex; align-items: center; gap: 6px; margin-top: 4px; padding-left: 4px; }
.fallback-tag {
  font-size: 10.5px; font-weight: 700;
  color: var(--nb-text-2, #475569);
  background: var(--nb-border-light, #DBEAFE);
  padding: 2px 7px; border-radius: 999px;
}
.speak {
  border: none; background: transparent; cursor: pointer; padding: 3px;
  color: var(--nb-text-muted, #94A3B8);
  border-radius: var(--nb-radius-xs, 8px);
  display: flex;
  transition: background .15s var(--nb-ease, ease), color .15s var(--nb-ease, ease);
}
.speak:hover, .speak.on {
  color: var(--nb-primary, #2563EB);
  background: var(--nb-primary-50, #EFF6FF);
}

.typing { display: flex; gap: 4px; align-items: center; padding: 13px 15px; }
.typing span {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--nb-primary-200, #BFDBFE);
  animation: brief-bounce 1.2s infinite ease-in-out;
}
.typing span:nth-child(2) { animation-delay: .15s; }
.typing span:nth-child(3) { animation-delay: .3s; }
@keyframes brief-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: .55; }
  40% { transform: translateY(-4px); opacity: 1; }
}

/* ── Câu hỏi gợi ý ── */
.brief-suggest {
  display: flex; gap: 6px; overflow-x: auto;
  padding: 9px 12px 5px;
  background: var(--nb-surface, #fff);
  scrollbar-width: none;
}
.brief-suggest::-webkit-scrollbar { display: none; }
.chip {
  flex-shrink: 0;
  font-family: inherit;
  font-size: 12px; font-weight: 700;
  padding: 6px 11px;
  border-radius: 999px;
  border: 1px solid var(--nb-border, #BFDBFE);
  background: var(--nb-surface, #fff);
  color: var(--nb-text-2, #475569);
  cursor: pointer;
  transition: all .15s var(--nb-ease, ease);
}
.chip:hover:not(:disabled) {
  border-color: var(--nb-primary, #2563EB);
  color: var(--nb-primary-dark, #1D4ED8);
  background: var(--nb-primary-50, #EFF6FF);
}
.chip:active:not(:disabled) { transform: scale(.97); }
.chip:disabled { opacity: .5; cursor: default; }

/* ── Ô nhập ── */
.brief-input {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 9px 11px 11px 12px;
  background: var(--nb-surface, #fff);
  border-top: 1px solid var(--nb-border-light, #DBEAFE);
}
.brief-input textarea {
  flex: 1; resize: none;
  min-height: 40px; max-height: 96px;
  padding: 10px 13px;
  border-radius: var(--nb-radius-md, 12px);
  border: 1px solid var(--nb-border, #BFDBFE);
  background: var(--nb-bg, #F0F7FF);
  color: var(--nb-text, #0F172A);
  font: inherit; font-size: 13.5px; line-height: 1.45;
  outline: none;
  transition: border-color .15s var(--nb-ease, ease), background .15s var(--nb-ease, ease);
}
.brief-input textarea::placeholder { color: var(--nb-text-muted, #94A3B8); }
.brief-input textarea:focus {
  border-color: var(--nb-primary, #2563EB);
  background: var(--nb-surface, #fff);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, .12);
}

/* ── Chuyển cảnh mở/đóng ── */
.brief-pop-enter-active, .brief-pop-leave-active {
  transition: opacity .18s var(--nb-ease, ease), transform .18s var(--nb-ease, ease);
}
.brief-pop-enter-from, .brief-pop-leave-to { opacity: 0; transform: translateY(12px) scale(.98); }

@media (max-width: 600px) {
  .brief-root { right: 12px; }
  .brief-card { height: min(576px, calc(100vh - 160px)); }
}
@media (prefers-reduced-motion: reduce) {
  .bubble, .typing span { animation: none !important; }
  .brief-fab, .chip, .speak, .brief-input textarea { transition: none !important; }
  .brief-fab:hover, .brief-fab:active, .chip:active { transform: none !important; }
}

/* ── Theme tối cũ (legacy-dark) — app hiện pin sáng, giữ phòng khi bật lại ── */
:deep(.v-theme--legacy-dark) .brief-card { background: #112240; border-color: rgba(255,255,255,.08); color: #E6F1FF; }
:deep(.v-theme--legacy-dark) .brief-body { background: #0A192F; }
:deep(.v-theme--legacy-dark) .brief-kpis,
:deep(.v-theme--legacy-dark) .brief-suggest,
:deep(.v-theme--legacy-dark) .brief-input { background: #112240; border-color: rgba(255,255,255,.08); }
:deep(.v-theme--legacy-dark) .msg--ai .bubble,
:deep(.v-theme--legacy-dark) .kpi,
:deep(.v-theme--legacy-dark) .chip { background: #0A192F; border-color: rgba(255,255,255,.12); color: #CBD5E1; }
:deep(.v-theme--legacy-dark) .kpi b { color: #7FB0FF; }
:deep(.v-theme--legacy-dark) .brief-input textarea { background: #0A192F; border-color: rgba(255,255,255,.12); color: #E6F1FF; }
</style>
