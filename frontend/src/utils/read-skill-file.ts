/**
 * read-skill-file.ts — đọc file skill cho "AI tự trả lời" ngay trên trình duyệt.
 *
 * Nhận:
 *   - .skill / .zip : gói skill (thư mục chứa SKILL.md + references/*.md…).
 *                     SKILL.md → hướng dẫn chính; các file .md/.txt khác → tài liệu tham khảo.
 *   - .md / .markdown / .txt : một file hướng dẫn duy nhất.
 * Giải nén bằng DecompressionStream('deflate-raw') có sẵn của trình duyệt — không cần thư viện.
 */

export type SkillDoc = { path: string; content: string };
export type ParsedSkill = { name: string; main: string; mainPath: string | null; references: SkillDoc[] };

const TEXT_EXT = /\.(md|markdown|txt)$/i;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Đọc danh sách file trong zip qua "central directory" (đủ cho zip thường, không mã hoá). */
export async function unzip(buf: ArrayBuffer): Promise<Array<{ path: string; data: Uint8Array }>> {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  // Tìm "end of central directory" (chữ ký 0x06054b50) từ cuối file.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('File không phải zip hợp lệ');
  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out: Array<{ path: string; data: Uint8Array }> = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error('Zip hỏng (central directory)');
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const path = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;
    if (path.endsWith('/')) continue; // thư mục
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);
    if (method === 0) out.push({ path, data: raw });
    else if (method === 8) out.push({ path, data: await inflateRaw(raw) });
    // phương thức nén khác: bỏ qua
  }
  return out;
}

function stripRoot(paths: string[]): (p: string) => string {
  // Bỏ thư mục gốc chung (vd "ai-chatbot/") cho đường dẫn gọn.
  const firsts = new Set(paths.map((p) => (p.includes('/') ? p.split('/')[0] : '')));
  if (firsts.size === 1 && !firsts.has('')) {
    const root = [...firsts][0] + '/';
    return (p) => (p.startsWith(root) ? p.slice(root.length) : p);
  }
  return (p) => p;
}

export async function readSkillFile(file: File): Promise<ParsedSkill> {
  const baseName = file.name.replace(/\.[^.]+$/, '');
  if (TEXT_EXT.test(file.name)) {
    return { name: baseName, main: (await file.text()).replace(/\r\n/g, '\n').trim(), mainPath: file.name, references: [] };
  }
  if (!/\.(skill|zip)$/i.test(file.name)) throw new Error('Chỉ nhận file .skill, .zip, .md, .txt');
  if (typeof DecompressionStream === 'undefined') throw new Error('Trình duyệt quá cũ, không giải nén được. Hãy dùng Chrome mới.');

  const entries = (await unzip(await file.arrayBuffer()))
    .filter((e) => TEXT_EXT.test(e.path) && !/(^|\/)(__MACOSX|\.)/.test(e.path));
  if (entries.length === 0) throw new Error('Không thấy file .md / .txt nào trong gói skill');
  const rel = stripRoot(entries.map((e) => e.path));
  const decoder = new TextDecoder();
  const docs = entries.map((e) => ({ path: rel(e.path), content: decoder.decode(e.data).replace(/\r\n/g, '\n').trim() }))
    .filter((d) => d.content);
  // Hướng dẫn chính: SKILL.md (nông nhất), nếu không có thì file ở gốc đầu tiên.
  const mainDoc = docs
    .filter((d) => /(^|\/)skill\.md$/i.test(d.path))
    .sort((a, b) => a.path.split('/').length - b.path.split('/').length)[0]
    ?? docs.filter((d) => !d.path.includes('/'))[0]
    ?? null;
  const rootName = entries[0].path.includes('/') ? entries[0].path.split('/')[0] : baseName;
  return {
    name: rootName || baseName,
    main: mainDoc?.content ?? '',
    mainPath: mainDoc?.path ?? null,
    references: docs.filter((d) => d !== mainDoc).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Chế độ mặc định cho tài liệu tham khảo, đoán theo tên file (chủ shop đổi được). */
export function defaultReferenceMode(path: string): 'always' | 'auto' | 'off' {
  const p = path.toLowerCase();
  if (/(readme|huong-dan-gan|viec-con-treo|changelog|todo)/.test(p)) return 'off';
  if (/(cam|cấm|forbidden|system-prompt|quy-tac|rules?|giong|mau-cau|voice|tone)/.test(p)) return 'always';
  return 'auto';
}
