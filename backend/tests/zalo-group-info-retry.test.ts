/**
 * zalo-group-info-retry.test.ts
 * resolveGroupInfo / resolveZaloName: retry lỗi mạng chập chờn (ECONNRESET) + cache +
 * KHÔNG log ERROR (console.warn → *-error.log → Tiểu Linh báo oan) khi chỉ là mạng chập chờn.
 * Gốc lỗi 19/09/2026: getGroupInfo gọi mỗi tin nhóm, Zalo hay reset TLS → 13 dòng "[cause] read ECONNRESET"/60p.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}));

vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: {} }));
vi.mock('../src/shared/utils/logger.js', () => ({ logger: loggerMock }));
vi.mock('../src/modules/chat/message-handler.js', () => ({ handleIncomingMessage: vi.fn(), handleMessageUndo: vi.fn() }));
vi.mock('../src/modules/chat/reaction-echo-cache.js', () => ({ consumeIfExpected: vi.fn() }));

const { resolveGroupInfo, resolveZaloName, isTransientNetErr } = await import(
  '../src/modules/zalo/zalo-listener-factory.js'
);

// Lỗi ECONNRESET y như Zalo/undici bắn ra: TypeError('fetch failed') + cause.code
function econnreset() {
  const cause: any = new Error('read ECONNRESET');
  cause.code = 'ECONNRESET';
  cause.errno = -54;
  cause.syscall = 'read';
  const err: any = new TypeError('fetch failed');
  err.cause = cause;
  return err;
}

let gid = 0;
const newGid = () => 'group-' + (++gid) + '-' + Date.now();

beforeEach(() => { vi.clearAllMocks(); });

describe('isTransientNetErr', () => {
  it('nhận diện ECONNRESET (TypeError fetch failed + cause.code)', () => {
    expect(isTransientNetErr(econnreset())).toBe(true);
  });
  it('nhận diện qua message "read ECONNRESET"', () => {
    expect(isTransientNetErr(new Error('read ECONNRESET'))).toBe(true);
  });
  it('lỗi nghiệp vụ Zalo ([zalo:112], 404) KHÔNG coi là mạng', () => {
    expect(isTransientNetErr(new Error('[zalo:112] permission denied'))).toBe(false);
    const e: any = new Error('Request failed with status code 404'); e.code = null;
    expect(isTransientNetErr(e)).toBe(false);
  });
});

describe('resolveGroupInfo', () => {
  it('ECONNRESET rồi thành công → tự retry, trả tên nhóm, KHÔNG log warn', async () => {
    const groupId = newGid();
    const getGroupInfo = vi.fn()
      .mockRejectedValueOnce(econnreset())
      .mockResolvedValueOnce({ gridInfoMap: { [groupId]: { name: 'Nhóm Sỉ', avt: 'a.jpg', totalMember: 12 } } });
    const r = await resolveGroupInfo({ getGroupInfo }, groupId);
    expect(r).toEqual({ name: 'Nhóm Sỉ', avatar: 'a.jpg', membersCount: 12 });
    expect(getGroupInfo).toHaveBeenCalledTimes(2);      // đã retry
    expect(loggerMock.warn).not.toHaveBeenCalled();      // không rác error log
  });

  it('ECONNRESET cả 3 lần → KHÔNG log warn (chỉ debug), trả rỗng', async () => {
    const groupId = newGid();
    const getGroupInfo = vi.fn().mockRejectedValue(econnreset());
    const r = await resolveGroupInfo({ getGroupInfo }, groupId);
    expect(r).toEqual({ name: '', avatar: '', membersCount: null });
    expect(getGroupInfo).toHaveBeenCalledTimes(3);
    expect(loggerMock.warn).not.toHaveBeenCalled();      // <-- điều Tiểu Linh cần: không vào *-error.log
    expect(loggerMock.debug).toHaveBeenCalled();
  });

  it('cache: lần 2 KHÔNG gọi lại Zalo (giảm số lần gọi → ít reset)', async () => {
    const groupId = newGid();
    const getGroupInfo = vi.fn().mockResolvedValue({ gridInfoMap: { [groupId]: { name: 'G', avt: '', totalMember: 3 } } });
    await resolveGroupInfo({ getGroupInfo }, groupId);
    await resolveGroupInfo({ getGroupInfo }, groupId);
    expect(getGroupInfo).toHaveBeenCalledTimes(1);        // lần 2 lấy từ cache
  });

  it('lỗi nghiệp vụ (không phải mạng) → KHÔNG retry, log warn 1 lần', async () => {
    const groupId = newGid();
    const bizErr: any = new Error('Request failed with status code 404'); bizErr.code = null;
    const getGroupInfo = vi.fn().mockRejectedValue(bizErr);
    const r = await resolveGroupInfo({ getGroupInfo }, groupId);
    expect(r).toEqual({ name: '', avatar: '', membersCount: null });
    expect(getGroupInfo).toHaveBeenCalledTimes(1);        // không retry lỗi nghiệp vụ
    expect(loggerMock.warn).toHaveBeenCalledTimes(1);
  });

  it('còn cache cũ mà mạng lỗi → dùng cache cũ thay vì rỗng', async () => {
    const groupId = newGid();
    // Nạp cache thành công (TTL 10 phút, còn hạn)
    const okApi = { getGroupInfo: vi.fn().mockResolvedValue({ gridInfoMap: { [groupId]: { name: 'Cũ', avt: 'c.jpg', totalMember: 5 } } }) };
    await resolveGroupInfo(okApi, groupId);
    // Cache còn hạn -> lần sau lấy cache luôn, không gọi API (đúng thiết kế TTL 10p)
    const badApi = { getGroupInfo: vi.fn().mockRejectedValue(econnreset()) };
    const r = await resolveGroupInfo(badApi, groupId);
    expect(r.name).toBe('Cũ');
    expect(badApi.getGroupInfo).not.toHaveBeenCalled();
  });
});

describe('resolveZaloName', () => {
  it('ECONNRESET cả 3 lần → không log warn (chỉ debug), trả rỗng', async () => {
    const cache = new Map();
    const getUserInfo = vi.fn().mockRejectedValue(econnreset());
    const r = await resolveZaloName({ getUserInfo }, 'uid-' + Date.now(), cache);
    expect(r.zaloName).toBe('');
    expect(getUserInfo).toHaveBeenCalledTimes(3);
    expect(loggerMock.warn).not.toHaveBeenCalled();
    expect(loggerMock.debug).toHaveBeenCalled();
  });

  it('ECONNRESET rồi thành công → retry, trả tên', async () => {
    const cache = new Map();
    const uid = 'uid-ok-' + Date.now();
    const getUserInfo = vi.fn()
      .mockRejectedValueOnce(econnreset())
      .mockResolvedValueOnce({ changed_profiles: { [uid]: { zaloName: 'Anh A', avatar: 'x.jpg', globalId: 'g1', username: 't_a' } } });
    const r = await resolveZaloName({ getUserInfo }, uid, cache);
    expect(r.zaloName).toBe('Anh A');
    expect(getUserInfo).toHaveBeenCalledTimes(2);
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });
});
