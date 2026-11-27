'use client';
import { useState } from 'react';
import { Download, ExternalLink, Trash2 } from 'lucide-react';
import { api, fmtDateTime, STATUS_LABEL } from '@/lib/client';
import { Button, Card, CopyButton, ErrorNote, Field, Input, Modal, Notice, Select, StatusBadge, Textarea, useUi } from '@/components/ui';

// Phải khớp NEXT trong src/lib/services/content.ts; backend vẫn là nơi kiểm tra cuối cùng.
export const NEXT: Record<string, string[]> = {
  idea: ['researching', 'writing', 'draft', 'archived'], researching: ['writing', 'draft', 'archived'], writing: ['draft', 'archived'], draft: ['pending_review', 'archived'],
  pending_review: ['approved', 'changes_requested', 'draft', 'archived'], changes_requested: ['draft', 'pending_review', 'archived'],
  approved: ['in_production', 'ready_to_publish', 'scheduled', 'draft', 'archived'], in_production: ['ready_to_publish', 'scheduled', 'draft', 'archived'],
  ready_to_publish: ['scheduled', 'published', 'draft', 'archived'], scheduled: ['published', 'failed', 'ready_to_publish', 'archived'], published: ['archived'],
  failed: ['ready_to_publish', 'scheduled', 'draft', 'archived'], archived: ['draft'],
};
const LABEL: Record<string, string> = {
  researching: 'Đang nghiên cứu', writing: 'Đang viết', draft: 'Về bản nháp', pending_review: 'Gửi duyệt', approved: 'Duyệt', changes_requested: 'Yêu cầu sửa…', in_production: 'Chuyển sang sản xuất',
  ready_to_publish: 'Sẵn sàng đăng', scheduled: 'Lên lịch…', published: 'Đánh dấu ĐÃ ĐĂNG thủ công…', failed: 'Đánh dấu thất bại', archived: 'Lưu trữ',
};
const ACTION_LABEL: Record<string, string> = { request_review: 'Gửi duyệt', approve: 'Duyệt', request_changes: 'Yêu cầu sửa', reschedule_confirm: 'Xác nhận lên lịch', publish_confirm: 'Xác nhận đã đăng thủ công' };

export type Approval = { action: string; note: string; created_at: string; actor: string | null };
export type ExportParts = { title: string; hooks: string[]; body: string; caption: string; hashtags: string[]; cta: string };

export function fullText(p: ExportParts) {
  const hooks = p.hooks.filter((h) => h.trim());
  return [p.title, hooks.length ? `HOOK:\n${hooks.map((h, i) => `${i + 1}. ${h}`).join('\n')}` : '', p.body, p.caption && `CAPTION:\n${p.caption}`, p.hashtags.length ? p.hashtags.join(' ') : '', p.cta && `CTA: ${p.cta}`].filter((x) => x && x.trim()).join('\n\n');
}

export function WorkflowPanel({ id, status, scheduledAt, publishedAt, channelId, isAdmin, channels, approvals, parts, dirty, ensureSaved, onChanged, onDeleted }: {
  id: string; status: string; scheduledAt: string | null; publishedAt: string | null; channelId: string | null; isAdmin: boolean; channels: { id: string; name: string }[];
  approvals: Approval[]; parts: ExportParts; dirty: boolean; ensureSaved: () => Promise<boolean>; onChanged: () => Promise<void>; onDeleted: () => void;
}) {
  const { confirm, toast } = useUi();
  const [modal, setModal] = useState<null | 'changes' | 'schedule' | 'publish'>(null);
  const [note, setNote] = useState('');
  const [at, setAt] = useState('');
  const [chan, setChan] = useState(channelId ?? '');
  const [url, setUrl] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const next = NEXT[status] ?? [];
  const canAct = (to: string) => !(['approved', 'changes_requested'].includes(to) && status === 'pending_review' && !isAdmin);

  const go = async (to: string, extra: Record<string, unknown> = {}, ok?: string) => {
    setErr(null); setBusy(to);
    try {
      if (!(await ensureSaved())) throw new Error('Chưa lưu được thay đổi — sửa lỗi lưu trước khi chuyển trạng thái');
      await api(`/contents/${id}/transition`, { body: { to, ...extra } });
      toast(ok ?? `Đã chuyển sang “${STATUS_LABEL[to]}”`);
      setModal(null);
      await onChanged();
    } catch (e) { setErr((e as Error).message); toast((e as Error).message, 'err'); }
    finally { setBusy(null); }
  };

  const click = async (to: string) => {
    setErr(null);
    if (to === 'changes_requested') { setNote(''); setModal('changes'); return; }
    if (to === 'scheduled') { setAt(''); setChan(channelId ?? ''); setModal('schedule'); return; }
    if (to === 'published') { setUrl(''); setAck(false); setModal('publish'); return; }
    if (to === 'approved') {
      if (!(await confirm({ title: 'Duyệt nội dung này?', body: 'Bạn xác nhận nội dung đã được kiểm tra và đủ điều kiện đăng. Sửa nội dung sau khi duyệt sẽ đưa bài về bản nháp để duyệt lại.', confirmLabel: 'Duyệt' }))) return;
      void go(to, { note: '' }); return;
    }
    if (to === 'archived') {
      if (!(await confirm({ title: 'Lưu trữ nội dung?', body: 'Nội dung đã lưu trữ không thể sửa cho đến khi chuyển về bản nháp.', confirmLabel: 'Lưu trữ' }))) return;
    }
    if (to === 'failed' && !(await confirm({ title: 'Đánh dấu đăng thất bại?', body: 'Dùng khi bài đã lên lịch nhưng bạn đăng không thành công.', confirmLabel: 'Đánh dấu thất bại' }))) return;
    void go(to);
  };

  const del = async () => {
    if (!(await confirm({ title: 'Xoá vĩnh viễn nội dung này?', body: 'Toàn bộ phiên bản, biến thể và lịch sử duyệt sẽ bị xoá. Không thể hoàn tác.', confirmLabel: 'Xoá', danger: true }))) return;
    setBusy('delete'); setErr(null);
    try { await api(`/contents/${id}`, { method: 'DELETE' }); toast('Đã xoá nội dung'); onDeleted(); }
    catch (e) { setErr((e as Error).message); toast((e as Error).message, 'err'); }
    finally { setBusy(null); }
  };

  const urlOk = !url.trim() || /^https?:\/\//i.test(url.trim());
  const text = fullText(parts);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Card title="Quy trình phê duyệt">
          <div className="flex flex-wrap items-center gap-2"><span className="text-sm text-muted">Trạng thái hiện tại:</span><StatusBadge status={status} />
            {scheduledAt && status === 'scheduled' && <span className="text-xs text-muted">đăng dự kiến {fmtDateTime(scheduledAt)}</span>}
            {publishedAt && status === 'published' && <span className="text-xs text-muted">đã đăng {fmtDateTime(publishedAt)}</span>}
          </div>
          {dirty && <div className="mt-3"><Notice tone="amber">Còn thay đổi chưa lưu — hệ thống sẽ lưu trước khi chuyển trạng thái.</Notice></div>}
          {['approved', 'ready_to_publish'].includes(status) && <div className="mt-3"><Notice tone="amber">Sửa nội dung (tiêu đề, hook, thân bài, caption) sau khi đã duyệt sẽ tự đưa bài về “Bản nháp” để duyệt lại.</Notice></div>}
          <div className="mt-3"><ErrorNote message={err} /></div>
          <div className="mt-3 flex flex-wrap gap-2">
            {next.filter(canAct).map((to) => (
              <Button key={to} variant={to === 'published' ? 'gold' : ['pending_review', 'approved', 'scheduled'].includes(to) ? 'primary' : 'secondary'} busy={busy === to} disabled={!!busy} onClick={() => void click(to)}>{LABEL[to] ?? STATUS_LABEL[to]}</Button>
            ))}
            {next.length === 0 && <p className="text-sm text-muted">Không có bước chuyển tiếp.</p>}
          </div>
          {status === 'pending_review' && !isAdmin && <p className="mt-3 text-xs text-muted">Chỉ quản trị viên / chủ sở hữu được duyệt hoặc yêu cầu sửa. Bạn có thể đưa bài về bản nháp hoặc chờ người duyệt.</p>}
          {status === 'draft' && <p className="mt-3 text-xs text-muted">Bản nháp cần được gửi duyệt trước khi lên lịch hoặc đăng.</p>}
        </Card>

        <Card title="Lịch sử phê duyệt" pad={false}>
          {approvals.length === 0 ? <p className="p-4 text-sm text-muted">Chưa có hoạt động duyệt nào.</p> : (
            <ul className="divide-y divide-line">
              {approvals.map((a, i) => (
                <li key={i} className="px-4 py-2.5 text-sm">
                  <div className="flex flex-wrap justify-between gap-1"><span className="font-medium">{ACTION_LABEL[a.action] ?? a.action}</span><span className="text-xs text-muted">{fmtDateTime(a.created_at)}</span></div>
                  <p className="text-xs text-muted">{a.actor ?? 'Hệ thống'}</p>
                  {a.note && <p className="mt-1 whitespace-pre-wrap break-words text-sm">{a.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <div className="space-y-4">
        <Card title="Xuất & đăng thủ công">
          <Notice tone="blue">Hệ thống KHÔNG tự đăng bài. Facebook cá nhân không có API đăng bài, các nền tảng khác cũng chỉ ghi nhận khi bạn xác nhận đã đăng.</Notice>
          <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
            <li>Duyệt nội dung, rồi sao chép toàn bộ hoặc từng phần (hoặc tải file Markdown).</li>
            <li>Mở nền tảng đích, dán nội dung, kiểm tra hình/video và đăng bằng tài khoản của bạn.</li>
            <li>Quay lại đây bấm “Đánh dấu ĐÃ ĐĂNG thủ công” và dán đường dẫn bài (nếu có).</li>
          </ol>
          {dirty && <p className="mt-2 text-xs text-warn">Có thay đổi chưa lưu: bản sao chép dùng nội dung đang soạn, còn file .md tải từ bản đã lưu.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <CopyButton size="md" text={text} label="Sao chép toàn bộ" />
            <a href={`/api/contents/${id}/export.md`} className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 text-sm font-medium hover:bg-surface2"><Download className="h-4 w-4" />Tải Markdown</a>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-1.5"><span className="text-xs text-muted">Từng phần:</span>
            {parts.hooks.filter((h) => h.trim()).length > 0 && <CopyButton text={parts.hooks.filter((h) => h.trim()).join('\n')} label="Hook" />}
            {parts.body.trim() && <CopyButton text={parts.body} label="Thân bài" />}
            {parts.caption.trim() && <CopyButton text={parts.caption} label="Caption" />}
            {parts.hashtags.length > 0 && <CopyButton text={parts.hashtags.join(' ')} label="Hashtag" />}
            {parts.cta.trim() && <CopyButton text={parts.cta} label="CTA" />}
          </div>
        </Card>

        {isAdmin && (
          <Card title="Vùng nguy hiểm">
            <p className="mb-2 text-xs text-muted">Chỉ quản trị viên được xoá, và chỉ khi nội dung đang ở trạng thái Bản nháp hoặc Lưu trữ.</p>
            <Button variant="danger" busy={busy === 'delete'} disabled={!['draft', 'archived'].includes(status) || !!busy} onClick={() => void del()}><Trash2 className="h-4 w-4" />Xoá nội dung</Button>
          </Card>
        )}
      </div>

      <Modal open={modal === 'changes'} onClose={() => setModal(null)} title="Yêu cầu sửa"
        footer={<><Button onClick={() => setModal(null)}>Huỷ</Button><Button variant="primary" busy={busy === 'changes_requested'} disabled={!note.trim()} onClick={() => void go('changes_requested', { note: note.trim() })}>Gửi yêu cầu sửa</Button></>}>
        <Field label="Ghi chú cho người soạn (bắt buộc)"><Textarea value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} autoFocus /></Field>
        <div className="mt-2"><ErrorNote message={err} /></div>
      </Modal>

      <Modal open={modal === 'schedule'} onClose={() => setModal(null)} title="Lên lịch đăng"
        footer={<><Button onClick={() => setModal(null)}>Huỷ</Button><Button variant="primary" busy={busy === 'scheduled'} disabled={!at} onClick={() => void go('scheduled', { scheduled_at: new Date(at).toISOString(), channel_id: chan || null, confirm: true, note: note.trim() || undefined }, 'Đã lên lịch (nhắc đăng thủ công)')}>Xác nhận lên lịch</Button></>}>
        <div className="space-y-3">
          <Notice tone="blue">Lên lịch chỉ là kế hoạch và lời nhắc. Hệ thống không tự đăng — đến giờ bạn tự đăng rồi đánh dấu “Đã đăng”.</Notice>
          <Field label="Ngày giờ đăng (theo múi giờ trình duyệt)"><Input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
          <Field label="Kênh"><Select value={chan} onChange={(e) => setChan(e.target.value)}><option value="">— Giữ kênh hiện tại / chưa chọn —</option>{channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <Field label="Ghi chú (tuỳ chọn)"><Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></Field>
          <ErrorNote message={err} />
        </div>
      </Modal>

      <Modal open={modal === 'publish'} onClose={() => setModal(null)} title="Đánh dấu đã đăng thủ công"
        footer={<><Button onClick={() => setModal(null)}>Huỷ</Button><Button variant="gold" busy={busy === 'published'} disabled={!ack || !urlOk} onClick={() => void go('published', { confirm: true, external_url: url.trim() || null }, 'Đã ghi nhận đăng thủ công')}>Xác nhận đã đăng</Button></>}>
        <div className="space-y-3">
          <Notice tone="amber">Chỉ xác nhận khi bạn ĐÃ tự đăng bài này trên nền tảng. Hệ thống không đăng giúp bạn và không kiểm tra được bài có thật sự lên hay chưa.</Notice>
          <Field label="Đường dẫn bài đã đăng (tuỳ chọn)" hint={!urlOk ? <span className="text-danger">Đường dẫn phải bắt đầu bằng http:// hoặc https://</span> : undefined}>
            <div className="flex items-center gap-2"><Input type="url" inputMode="url" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} /><ExternalLink className="h-4 w-4 shrink-0 text-muted" aria-hidden /></div>
          </Field>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />Tôi xác nhận đã đăng bài này trên nền tảng.</label>
          <ErrorNote message={err} />
        </div>
      </Modal>
    </div>
  );
}
