/**
 * Seed: tạo tài khoản + workspace mặc định với DNA Ly Vân / Trang Tùng Khang, 5 kênh, prompt, workflow (TẮT), ngân sách.
 * KHÔNG tạo số liệu hiệu quả giả. Dữ liệu demo (nếu có) chỉ phát sinh khi chạy Daily Agent ở chế độ DEMO và luôn gắn nhãn.
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Thiếu DATABASE_URL');
  const email = process.env.SEED_EMAIL ?? 'lyvan@example.local';
  const password = process.env.SEED_PASSWORD ?? 'ChangeMe-12345';
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const ex = await c.query('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
  if (ex.rowCount) { console.log(`Tài khoản ${email} đã tồn tại — bỏ qua.`); await c.end(); return; }
  await c.end();
  // Dùng đúng logic đăng ký của ứng dụng để workspace được khởi tạo giống người dùng thật
  process.env.DATABASE_URL = url;
  const { registerUser } = await import('../src/lib/auth');
  const { bootstrapWorkspace } = await import('../src/lib/services/bootstrap');
  const r = await registerUser(email, password, 'Nguyễn Thị Ly Vân', 'Ly Vân Studio');
  if (!r) throw new Error('Không tạo được tài khoản');
  await bootstrapWorkspace(r.workspaceId, r.userId);
  console.log(`Đã tạo tài khoản: ${email} / ${password}  (ĐỔI MẬT KHẨU NGAY khi triển khai thật)`);
  void bcrypt;
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
