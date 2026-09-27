/**
 * clone-service.ts — "Học theo nick khác".
 *
 * Nick mẫu (vd Minh Mẫn) đã được dạy tốt → nick mới (nhân viên) chép TOÀN BỘ những gì
 * nick mẫu đã học: hướng dẫn / skill + tài liệu tham khảo, bài học (chủ shop dạy + tự rút),
 * kịch bản riêng của nick, cách tư vấn (tra kho, gửi ảnh, xưng hô theo giới tính…).
 *
 * Chép xong là của RIÊNG nick mới: dạy thêm / sửa / tự học ở nick mới không đụng nick mẫu
 * và ngược lại. Không chép: thẻ kích hoạt (thẻ Zalo mỗi nick khác nhau), công tắc bật/tắt,
 * Telegram riêng nick.
 *
 * Chép lại lần nữa ("Cập nhật từ nick mẫu"): thay hướng dẫn + bài học ĐÃ CHÉP bằng bản mới
 * của nick mẫu; bài học nick mới tự học hoặc chủ shop dạy riêng cho nick mới được GIỮ.
 */
import { prisma } from '../../../shared/database/prisma-client.js';
import { getProfile, saveProfile, type AutoReplyProfile } from './config-service.js';
import { fold } from './guardrails.js';
import { MAX_ACTIVE_LESSONS } from './learning-service.js';

export type CloneResult = {
  profile: AutoReplyProfile;
  sourceName: string;
  lessons: number;
  playbook: number;
  guideFiles: number;
};

export class CloneError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

/** Các phần của cấu hình được chép sang (hàm thuần — dễ test). */
export function clonedSettings(source: AutoReplyProfile, target: AutoReplyProfile | null) {
  return {
    // Kiến thức + cách tư vấn của nick mẫu
    persona: source.persona,
    extraInstruction: source.extraInstruction,
    guideFileName: source.guideFileName,
    guideFiles: source.guideFiles,
    addressByGender: source.addressByGender,
    selfPronoun: source.selfPronoun,
    useProductCatalog: source.useProductCatalog,
    sendProductImages: source.sendProductImages,
    verifyGrounding: source.verifyGrounding,
    learningEnabled: source.learningEnabled,
    blockedKeywords: source.blockedKeywords,
    notifyHandoff: source.notifyHandoff,
    handoffPauseMinutes: source.handoffPauseMinutes,
    mode: source.mode,
    hourStart: source.hourStart,
    hourEnd: source.hourEnd,
    debounceSeconds: source.debounceSeconds,
    maxRepliesPerDay: source.maxRepliesPerDay,
    maxRepliesPerConvPerDay: source.maxRepliesPerConvPerDay,
    skipIfStaffRepliedWithinMin: source.skipIfStaffRepliedWithinMin,
    // Của riêng nick mới — giữ nguyên
    triggerTags: target?.triggerTags ?? [],
    enabled: target?.enabled ?? false,
    handoffChatId: target?.handoffChatId ?? null,
  };
}

export async function cloneProfileFrom(orgId: string, targetAccountId: string, sourceAccountId: string): Promise<CloneResult> {
  if (targetAccountId === sourceAccountId) throw new CloneError('Không thể học theo chính nick này');
  const [targetAcc, sourceAcc] = await Promise.all([
    prisma.zaloAccount.findFirst({ where: { id: targetAccountId, orgId }, select: { id: true } }),
    prisma.zaloAccount.findFirst({ where: { id: sourceAccountId, orgId }, select: { id: true, displayName: true, phone: true } }),
  ]);
  if (!targetAcc || !sourceAcc) throw new CloneError('Không tìm thấy nick', 404);
  const source = await getProfile(orgId, sourceAccountId, { fresh: true });
  if (!source) throw new CloneError('Nick mẫu chưa được cấu hình AI');
  const target = await getProfile(orgId, targetAccountId, { fresh: true });

  const profile = await saveProfile(orgId, targetAccountId, clonedSettings(source, target));

  // Bài học: bỏ bản đã chép lần trước (chưa bị sửa) rồi chép bản hiện tại của nick mẫu.
  // Bài của chính nick mới (tự học / dạy riêng / đã sửa) giữ nguyên và không bị chép trùng.
  const sourceLessons = await prisma.aiLesson.findMany({
    where: { zaloAccountId: sourceAccountId, active: true },
    orderBy: { updatedAt: 'desc' },
    take: MAX_ACTIVE_LESSONS,
    select: { content: true, source: true, evidence: true },
  });
  const playbook = await prisma.aiPlaybookEntry.findMany({ where: { orgId, zaloAccountId: sourceAccountId } });

  const result = await prisma.$transaction(async (tx) => {
    await tx.aiLesson.deleteMany({ where: { zaloAccountId: targetAccountId, inheritedFromAccountId: sourceAccountId } });
    const own = await tx.aiLesson.findMany({ where: { zaloAccountId: targetAccountId, active: true }, select: { content: true } });
    const seen = new Set(own.map((l) => fold(l.content)));
    const lessons = sourceLessons.filter((l) => !seen.has(fold(l.content)));
    // Tạo theo thứ tự cũ → mới để giữ thứ tự ưu tiên như ở nick mẫu.
    for (const l of [...lessons].reverse()) {
      await tx.aiLesson.create({
        data: { orgId, zaloAccountId: targetAccountId, content: l.content, source: l.source, inheritedFromAccountId: sourceAccountId },
      });
    }

    // Kịch bản riêng của nick mẫu → chép thành kịch bản riêng của nick mới (bỏ mục trùng tiêu đề).
    const existingTitles = new Set(
      (await tx.aiPlaybookEntry.findMany({ where: { orgId, zaloAccountId: targetAccountId }, select: { title: true } }))
        .map((p) => fold(p.title)),
    );
    let copiedPlaybook = 0;
    for (const p of playbook) {
      if (existingTitles.has(fold(p.title))) continue;
      await tx.aiPlaybookEntry.create({
        data: {
          orgId, zaloAccountId: targetAccountId, title: p.title, category: p.category,
          keywords: p.keywords ?? [], content: p.content, priority: p.priority, enabled: p.enabled,
        },
      });
      copiedPlaybook++;
    }

    await tx.aiAutoReplyProfile.update({
      where: { zaloAccountId: targetAccountId },
      data: { clonedFromAccountId: sourceAccountId, clonedAt: new Date() },
    });
    return { lessons: lessons.length, playbook: copiedPlaybook };
  });

  return {
    profile: (await getProfile(orgId, targetAccountId, { fresh: true }))!,
    sourceName: sourceAcc.displayName || sourceAcc.phone || sourceAcc.id.slice(0, 8),
    lessons: result.lessons,
    playbook: result.playbook,
    guideFiles: profile.guideFiles.length,
  };
}
