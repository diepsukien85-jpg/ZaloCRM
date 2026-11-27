/** Trình dựng prompt Google Flow cho từng cảnh (xác định, không tốn chi phí AI). Không giả lập việc tạo video. */
export type FlowScene = {
  scene_no: number; duration_sec: number; shot_description: string; dialogue: string; voiceover: string; camera: string; lighting: string;
  audio: string; environment: string; outfit: string; on_screen_text?: string;
};
export type FlowCharacter = { name: string; tag?: string | null; description?: string; consent_confirmed?: boolean } | null;

export const FLOW_DURATIONS = [4, 6, 8, 10] as const;
export const NEGATIVE_DEFAULT = 'không chữ/watermark lạ, không biến dạng mặt hoặc tay, không đổi khuôn mặt giữa các cảnh, không logo thương hiệu khác, không nội dung bản quyền, không chuyển động giật';

export function snapFlowDuration(sec: number): number {
  return FLOW_DURATIONS.reduce((best, d) => (Math.abs(d - sec) < Math.abs(best - sec) ? d : best), FLOW_DURATIONS[0]);
}

export function buildFlowPrompt(scene: FlowScene, opts: { character: FlowCharacter; aspectRatio: string; prev?: FlowScene | null; projectTitle?: string }): string {
  const c = opts.character;
  // Chỉ dùng @tag khi nhân vật đã được thiết lập trong công cụ đích (có tag); nếu không dùng mô tả bằng chữ.
  const charLine = c
    ? (c.tag ? `Character reference: ${c.tag.startsWith('@') ? c.tag : '@' + c.tag} (${c.name}). Giữ nguyên khuôn mặt, kiểu tóc, vóc dáng.` : `Character reference: ${c.name}${c.description ? ' — ' + c.description : ''}. Giữ nguyên khuôn mặt, kiểu tóc, vóc dáng.`)
    : 'Character reference: (chưa chọn nhân vật — thêm ở Thư viện nhân vật nếu cần nhất quán)';
  const cont = opts.prev ? `Tiếp nối cảnh ${opts.prev.scene_no}: giữ cùng nhân vật, trang phục, bối cảnh và hướng ánh sáng; chuyển cảnh mượt.` : 'Cảnh mở đầu: thiết lập nhân vật, trang phục, bối cảnh sẽ dùng xuyên suốt.';
  const lines = [
    `# Cảnh ${scene.scene_no}${opts.projectTitle ? ' — ' + opts.projectTitle : ''}`,
    charLine,
    `Identity consistency: cùng một người, cùng ngoại hình ở mọi cảnh.`,
    `Outfit: ${scene.outfit || 'giữ nguyên trang phục của cảnh trước'}`,
    `Environment: ${scene.environment || '(chưa mô tả)'}`,
    `Action: ${scene.shot_description || '(chưa mô tả)'}`,
    `Camera movement: ${scene.camera || 'máy ổn định, chuyển động nhẹ'}`,
    `Lighting: ${scene.lighting || 'ánh sáng tự nhiên, mềm'}`,
    `Dialogue: ${scene.dialogue ? `"${scene.dialogue}"` : '(không thoại)'}${scene.voiceover ? ` | Voiceover: "${scene.voiceover}"` : ''}`,
    `Audio: ${scene.audio || 'âm thanh môi trường, nhạc nền nhỏ'}`,
    `Aspect ratio: ${opts.aspectRatio}`,
    `Duration: ${snapFlowDuration(scene.duration_sec)} giây${snapFlowDuration(scene.duration_sec) !== scene.duration_sec ? ` (làm tròn từ ${scene.duration_sec}s theo mốc 4/6/8/10s — kiểm tra khả năng thực tế của công cụ)` : ''}`,
    `Continuity: ${cont}`,
    `Negative constraints: ${NEGATIVE_DEFAULT}`,
  ];
  if (c && !c.consent_confirmed) lines.push('⚠ Lưu ý: chưa xác nhận được cấp quyền sử dụng khuôn mặt/giọng nói của nhân vật này.');
  return lines.join('\n');
}

export function buildAllFlowPrompts(scenes: FlowScene[], opts: { character: FlowCharacter; aspectRatio: string; projectTitle?: string }) {
  const sorted = [...scenes].sort((a, b) => a.scene_no - b.scene_no);
  return sorted.map((s, i) => ({ scene_no: s.scene_no, prompt: buildFlowPrompt(s, { ...opts, prev: sorted[i - 1] ?? null }) }));
}

export function fmtSrtTime(sec: number): string {
  const ms = Math.round((sec % 1) * 1000), s = Math.floor(sec);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)},${p(ms, 3)}`;
}

/** Xuất SRT từ lời thoại/voiceover/chữ trên màn hình theo timeline cộng dồn thời lượng cảnh. */
export function buildSrt(scenes: Pick<FlowScene, 'scene_no' | 'duration_sec' | 'dialogue' | 'voiceover' | 'on_screen_text'>[]): string {
  let t = 0, idx = 1;
  const out: string[] = [];
  for (const s of [...scenes].sort((a, b) => a.scene_no - b.scene_no)) {
    const text = [s.dialogue, s.voiceover].filter(Boolean).join('\n') || s.on_screen_text || '';
    if (text.trim()) out.push(`${idx++}\n${fmtSrtTime(t)} --> ${fmtSrtTime(t + s.duration_sec)}\n${text.trim()}\n`);
    t += s.duration_sec;
  }
  return out.join('\n');
}
