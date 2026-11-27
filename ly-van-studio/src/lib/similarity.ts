/** Phát hiện ý tưởng trùng lặp: so khớp theo tập từ (Jaccard) sau khi bỏ dấu & stopword. */
const STOP = new Set(['va', 'la', 'cua', 'cho', 'nhung', 'mot', 'cac', 'co', 'khong', 'the', 'nao', 'tai', 'sao', 'khi', 'de', 'ma', 'thi', 'duoc', 'voi', 'trong', 'ban', 'minh', 'toi', 'nguoi']);

export function normalize(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)));
}
export function fingerprint(s: string): string {
  return [...tokens(s)].sort().join('-').slice(0, 200);
}
export function jaccard(a: string, b: string): number {
  const A = tokens(a), B = tokens(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}
export function findDuplicate(title: string, existing: { id: string; title: string }[], threshold = 0.6) {
  let best: { id: string; title: string; score: number } | null = null;
  for (const e of existing) {
    const score = jaccard(title, e.title);
    if (score >= threshold && (!best || score > best.score)) best = { ...e, score };
  }
  return best;
}
