/**
 * ignored-groups-service.ts — nhóm Zalo bị "bỏ qua" (nhóm đăng bài).
 *
 * Tin đến (và echo tin mình gửi) của các nhóm này KHÔNG được lưu vào DB → không
 * vào thống kê, không tăng chưa đọc, không kích hoạt automation/AI.
 *
 * Đăng bài vào nhóm vẫn chạy bình thường vì đường gửi (public API broadcast,
 * chat UI) không phụ thuộc bảng messages — TRỪ một chỗ: retry gửi ảnh an toàn
 * (public-api-routes.ts › countSelfImagesSince) đếm echo ảnh self trong DB để
 * biết lần gửi lỗi đã giao được ảnh nào chưa. Nhóm bỏ qua không lưu echo, nên
 * ở đây giữ một bộ đếm echo ảnh TRONG BỘ NHỚ (10 phút) để hàm đó vẫn đếm đúng,
 * không gửi trùng ảnh.
 *
 * Tra cứu chạy trên mọi tin đến → giữ cache in-memory, nạp lại mỗi 30 giây và
 * ngay sau khi thêm/xoá qua API.
 */
import { prisma } from '../../shared/database/prisma-client.js';
import { logger } from '../../shared/utils/logger.js';

const REFRESH_MS = 30_000;
const ECHO_TTL_MS = 10 * 60_000;

/** groupThreadId → tập orgId đã bỏ qua nhóm đó */
let ignored = new Map<string, Set<string>>();
let loadedAt = 0;
let loading: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

async function reload(): Promise<void> {
  const rows = await prisma.ignoredGroup.findMany({ select: { orgId: true, groupThreadId: true } });
  const next = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = next.get(r.groupThreadId) ?? new Set<string>();
    set.add(r.orgId);
    next.set(r.groupThreadId, set);
  }
  ignored = next;
  loadedAt = Date.now();
}

export function refreshIgnoredGroups(): Promise<void> {
  if (!loading) {
    loading = reload()
      .catch((err) => logger.warn('[ignored-groups] nạp danh sách lỗi:', err))
      .finally(() => { loading = null; });
  }
  return loading;
}

/** Gọi 1 lần lúc khởi động: nạp ngay + nạp lại định kỳ. */
export function startIgnoredGroupsCache(): void {
  if (timer) return;
  void refreshIgnoredGroups();
  timer = setInterval(() => void refreshIgnoredGroups(), REFRESH_MS);
  timer.unref?.();
}

/**
 * Nhóm có bị bỏ qua không. orgId = null khi caller chưa biết org (listener vừa
 * khởi động) → khớp nếu BẤT KỲ org nào bỏ qua nhóm đó (group id Zalo là toàn cục).
 */
export function isGroupIgnored(orgId: string | null | undefined, groupThreadId: string | null | undefined): boolean {
  if (!groupThreadId) return false;
  if (Date.now() - loadedAt > REFRESH_MS * 2) void refreshIgnoredGroups();
  const orgs = ignored.get(groupThreadId);
  if (!orgs || orgs.size === 0) return false;
  return orgId ? orgs.has(orgId) : true;
}

// ── Bộ đếm echo ảnh self trong bộ nhớ (cho retry gửi ảnh an toàn) ──────────

const imageEchoes = new Map<string, number[]>(); // `${accountId}:${threadId}` → sentAt ms

function echoKey(accountId: string, threadId: string) {
  return `${accountId}:${threadId}`;
}

function prune(list: number[], now: number) {
  const cutoff = now - ECHO_TTL_MS;
  let i = 0;
  while (i < list.length && list[i] < cutoff) i++;
  if (i > 0) list.splice(0, i);
}

/** Ghi nhận 1 echo tin self của nhóm bỏ qua (chỉ ảnh mới cần đếm). */
export function recordIgnoredSelfEcho(accountId: string, threadId: string, contentType: string, sentAtMs: number): void {
  if (contentType !== 'image') return;
  const key = echoKey(accountId, threadId);
  const list = imageEchoes.get(key) ?? [];
  const now = Date.now();
  prune(list, now);
  // Echo gần như luôn về theo thứ tự thời gian, chèn giữ mảng tăng dần cho chắc.
  const ts = Number.isFinite(sentAtMs) ? sentAtMs : now;
  let idx = list.length;
  while (idx > 0 && list[idx - 1] > ts) idx--;
  list.splice(idx, 0, ts);
  imageEchoes.set(key, list);
}

/** Số echo ảnh self của nhóm bỏ qua kể từ `since` (0 nếu không có). */
export function countIgnoredSelfImageEchoes(accountId: string, threadId: string, since: Date): number {
  const list = imageEchoes.get(echoKey(accountId, threadId));
  if (!list) return 0;
  prune(list, Date.now());
  const from = since.getTime();
  return list.filter((t) => t >= from).length;
}

/** Chỉ cho test. */
export function _resetIgnoredGroupsForTest(entries: Array<{ orgId: string; groupThreadId: string }> = []): void {
  ignored = new Map();
  for (const e of entries) {
    const set = ignored.get(e.groupThreadId) ?? new Set<string>();
    set.add(e.orgId);
    ignored.set(e.groupThreadId, set);
  }
  loadedAt = Date.now();
  imageEchoes.clear();
}
