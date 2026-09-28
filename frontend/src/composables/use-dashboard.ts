import { ref } from 'vue';
import { api } from '@/api';

export interface KpiData {
  messagesToday: number;
  messagesUnreplied: number;
  messagesUnread: number;
  appointmentsToday: number;
  newContactsThisWeek: number;
  totalContacts: number;
}

export interface MessageVolumeItem {
  date: string;
  sent: number;
  received: number;
}

export interface PipelineItem {
  status: string | null;
  _count: { _all: number } | number;
}

export interface SourceItem {
  source: string;
  _count: { _all: number } | number;
}

export interface AppointmentStatusItem {
  status: string;
  _count: { _all: number } | number;
}

// API trả { data: [{ ..., count }] } — chuẩn hoá về field `_count` mà các chart đang dùng
function unwrapCounts<T>(body: any): T[] {
  const rows = Array.isArray(body) ? body : (body?.data ?? []);
  return rows.map((r: any) => ({ ...r, _count: r._count ?? r.count ?? 0 }));
}

export function useDashboard() {
  const kpi = ref<KpiData | null>(null);
  const messageVolume = ref<MessageVolumeItem[]>([]);
  const pipeline = ref<PipelineItem[]>([]);
  const sources = ref<SourceItem[]>([]);
  const appointments = ref<AppointmentStatusItem[]>([]);
  const loading = ref(false);

  async function fetchAll() {
    loading.value = true;
    try {
      const [kpiRes, volRes, pipRes, srcRes, aptRes] = await Promise.all([
        api.get('/dashboard/kpi'),
        api.get('/dashboard/message-volume'),
        api.get('/dashboard/pipeline'),
        api.get('/dashboard/sources'),
        api.get('/dashboard/appointments'),
      ]);
      kpi.value = kpiRes.data;
      messageVolume.value = volRes.data.data || volRes.data;
      pipeline.value = unwrapCounts<PipelineItem>(pipRes.data);
      sources.value = unwrapCounts<SourceItem>(srcRes.data);
      appointments.value = unwrapCounts<AppointmentStatusItem>(aptRes.data);
    } catch (err) {
      console.error('Dashboard fetch error:', err);
    } finally {
      loading.value = false;
    }
  }

  return {
    kpi, messageVolume, pipeline, sources, appointments,
    loading, fetchAll,
  };
}
