export type Script = {
  title?: string; main_keyword?: string; audience?: string; problem?: string; desire?: string; hooks?: string[]; cta?: string; caption?: string; hashtags?: string[];
  youtube?: { titles: string[]; description: string; chapters: { time: string; title: string }[] } | null;
};
export type Project = {
  id: string; title: string; aspect_ratio: string; duration_sec: number; content_id: string | null; status: string; script: Script | null; notes: string | null; is_demo: boolean;
  scene_count?: number | string; created_at?: string;
};
export type Scene = {
  id: string; project_id: string; scene_no: number; duration_sec: number; shot_description: string; dialogue: string; voiceover: string; camera: string; lighting: string; audio: string;
  on_screen_text: string | null; environment: string; outfit: string; prompt: string | null; character_id: string | null; reference_asset_id: string | null; generated_asset_id: string | null;
  approval_status: 'draft' | 'approved' | 'rejected';
};
export type Character = {
  id: string; kind: 'character' | 'product' | 'location' | 'logo' | 'voice' | 'outfit'; name: string; tag: string | null; description: string; reference_asset_id: string | null; consent_confirmed: boolean;
};
export type MediaItem = {
  id: string; kind: 'image' | 'video' | 'audio' | 'document'; filename: string; mime: string; size_bytes: number; privacy: string; tags: string[] | null; has_transcript?: boolean; created_at: string; url: string;
};
export const PROJECT_STATUS: Record<string, string> = { planning: 'Lên kế hoạch', scripted: 'Đã có kịch bản', in_production: 'Đang sản xuất', done: 'Hoàn thành', archived: 'Lưu trữ' };
export const KIND_LABEL: Record<string, string> = { character: 'Nhân vật', product: 'Sản phẩm', location: 'Bối cảnh', logo: 'Logo', voice: 'Giọng nói', outfit: 'Trang phục' };
export const APPROVAL_LABEL: Record<string, string> = { draft: 'Nháp', approved: 'Đã duyệt', rejected: 'Từ chối' };
export const ASPECTS = ['9:16', '16:9', '1:1', '4:5'] as const;
