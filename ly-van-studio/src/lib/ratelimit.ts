import { pool } from './db';
import { tooMany } from './errors';

/** Giới hạn tần suất theo cửa sổ phút, lưu trong Postgres (dùng được khi chạy nhiều instance). */
export async function rateLimit(bucket: string, max: number, windowSec = 60) {
  const r = await pool().query(
    `INSERT INTO rate_limits(bucket, window_start, hits)
     VALUES ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     ON CONFLICT (bucket, window_start) DO UPDATE SET hits = rate_limits.hits + 1
     RETURNING hits`, [bucket, windowSec]);
  if (r.rows[0].hits > max) throw tooMany();
  if (Math.random() < 0.01) await pool().query("DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'");
}
