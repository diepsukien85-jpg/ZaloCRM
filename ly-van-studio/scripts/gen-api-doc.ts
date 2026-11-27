// Sinh docs/API.md từ định nghĩa route thật để tài liệu luôn khớp mã nguồn.
import fs from 'node:fs';
process.env.APP_SECRET ??= 'x'.repeat(32);
const mods = await Promise.all([import('../src/lib/api/auth'), import('../src/lib/api/brands'), import('../src/lib/api/research'), import('../src/lib/api/content'), import('../src/lib/api/video'), import('../src/lib/api/ops'), import('../src/lib/api/system')]);
const groups: [string, import('../src/lib/router').RouteDef[]][] = [
  ['Xác thực, workspace, thành viên', mods[0].authRoutes], ['Thương hiệu, DNA, kênh, nhân vật', mods[1].brandRoutes], ['Nghiên cứu: từ khoá, xu hướng, giải mã viral', mods[2].researchRoutes],
  ['Nhật ký, ý tưởng, Content Factory', mods[3].contentRoutes], ['Video Studio', mods[4].videoRoutes], ['Dashboard, analytics, lịch, lead, workflow, media', mods[5].opsRoutes], ['AI, cài đặt, copilot, hệ thống', mods[6].systemRoutes],
];
let out = `# API REST\n\n> Tệp này được sinh tự động bằng \`npx tsx scripts/gen-api-doc.ts\` từ định nghĩa route trong \`src/lib/api/*\`. Mọi endpoint nằm dưới \`/api\`.\n\n` +
`**Quy ước chung**\n- Xác thực bằng cookie HttpOnly \`lv_session\` (JWT). Workspace hiện hành lấy từ cookie \`lv_ws\` nhưng **vai trò luôn được tra lại từ DB**.\n- Vai trò tối thiểu: GET = \`viewer\`, ghi = \`editor\`; một số route yêu cầu \`admin\`/\`owner\` (cột "Quyền").\n- Mọi request ghi kiểm tra header \`Origin\` cùng host (chống CSRF).\n- Body JSON được validate bằng Zod; lỗi trả \`{error, code, details}\` với HTTP 400/401/402/403/404/409/429/5xx.\n- \`402\` = vượt ngân sách AI; \`409\` = xung đột/cần xác nhận; \`429\` = giới hạn tần suất.\n- Các endpoint AI (cột "Giới hạn") có rate limit theo người dùng.\n\n`;
let total = 0;
for (const [title, routes] of groups) {
  out += `## ${title}\n\n| Method | Path | Quyền | Ghi chú |\n|---|---|---|---|\n`;
  for (const r of routes) {
    total++;
    const min = r.public ? 'công khai' : ((r as { min?: string }).min ?? (r.method === 'GET' ? 'viewer' : 'editor'));
    const notes = [r.schema ? 'body Zod' : '', r.rate ? `rate ${r.rate.max}/phút` : ''].filter(Boolean).join(', ');
    out += `| ${r.method} | \`/api${r.path}\` | ${min} | ${notes} |\n`;
  }
  out += '\n';
}
out += `**Tổng: ${total} endpoint.**\n\nKhông có endpoint "giả" cho Meta/TikTok/YouTube/Google Drive/Google Flow: các tích hợp này chưa triển khai (xem INTEGRATION_STATUS.md).\n`;
fs.writeFileSync('docs/API.md', out);
console.log('docs/API.md', total, 'endpoint');
