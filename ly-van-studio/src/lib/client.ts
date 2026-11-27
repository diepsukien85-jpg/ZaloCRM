'use client';
 
import { useCallback, useEffect, useRef, useState } from 'react';

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string, public details?: unknown) { super(message); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) { location.href = '/login'; }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* không phải JSON */ }
  if (!res.ok) throw new ApiError(data?.error ?? `Lỗi ${res.status}`, res.status, data?.code, data?.details);
  return data as T;
}

/** Tải dữ liệu GET + reload thủ công. `path` = null để tạm dừng. */
export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const my = ++seq.current;
    setLoading(true);
    try { const d = await api<T>(path); if (my === seq.current) { setData(d); setError(null); } }
    catch (e) { if (my === seq.current) setError((e as Error).message); }
    finally { if (my === seq.current) setLoading(false); }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

export const fmtNum = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('vi-VN').format(n));
export const fmtVnd = (n: number | null | undefined) => (n == null ? '—' : new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND', maximumFractionDigits: 0 }).format(n));
export const fmtUsd = (n: number | null | undefined, d = 4) => (n == null ? '—' : `$${Number(n).toFixed(d)}`);
export const fmtPct = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(2)}%`);
export const fmtRatio = (n: number | null | undefined) => (n == null ? '—' : n.toFixed(2));
export const fmtDate = (s: string | Date | null | undefined) => (s ? new Date(s).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }) : '—');
export const fmtDateTime = (s: string | Date | null | undefined) => (s ? new Date(s).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false }) : '—');
export const vnDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });

export const STATUS_LABEL: Record<string, string> = {
  idea: 'Ý tưởng', researching: 'Đang nghiên cứu', writing: 'Đang viết', draft: 'Bản nháp', pending_review: 'Chờ duyệt', changes_requested: 'Yêu cầu sửa', approved: 'Đã duyệt',
  in_production: 'Đang sản xuất', ready_to_publish: 'Sẵn sàng đăng', scheduled: 'Đã lên lịch', published: 'Đã đăng', failed: 'Thất bại', archived: 'Lưu trữ',
};
export const PLATFORM_LABEL: Record<string, string> = {
  facebook_profile: 'Facebook cá nhân', facebook_page: 'Facebook Page', facebook_reels: 'Facebook Reels', tiktok: 'TikTok', youtube: 'YouTube', youtube_shorts: 'YouTube Shorts', youtube_long: 'YouTube dài', other: 'Khác',
};
export const TYPE_LABEL: Record<string, string> = { post: 'Bài đăng', video_script: 'Kịch bản video', carousel: 'Carousel', infographic: 'Infographic', youtube_description: 'Mô tả YouTube' };
export const FORMAT_LABEL: Record<string, string> = { post: 'Bài đăng', short_video: 'Video ngắn', long_video: 'Video dài', carousel: 'Carousel', infographic: 'Infographic' };
export const TIER_LABEL: Record<number, string> = { 1: 'Tầng 1 · Đại chúng', 2: 'Tầng 2 · Vấn đề & mong muốn', 3: 'Tầng 3 · Câu chuyện & tình huống', 4: 'Tầng 4 · Chuyên môn ngành', 5: 'Tầng 5 · Sản phẩm & chuyển đổi' };
export const FUNNEL_LABEL: Record<string, string> = { awareness: 'Nhận biết', consideration: 'Cân nhắc', decision: 'Quyết định', retention: 'Giữ chân' };
export const LEAD_STATUS_LABEL: Record<string, string> = { new: 'Mới', contacted: 'Đã liên hệ', qualified: 'Đủ điều kiện', quoted: 'Đã báo giá', negotiating: 'Đàm phán', won: 'Thành công', lost: 'Không thành công' };
export const PRIVACY_LABEL: Record<string, string> = { private: 'Riêng tư', internal: 'Nội bộ', public: 'Được phép công khai' };

export function download(filename: string, content: string, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function copyText(t: string) { await navigator.clipboard.writeText(t); }
