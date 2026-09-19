/**
 * zalo-ops-transient-net.test.ts
 * isTransientNetworkError: sink log chung của exec() phải coi ECONNRESET/fetch failed là
 * lỗi mạng chập chờn → logger.debug (không vào *-error.log), không phải logger.error.
 * Cover getFriendOnlines / getAllFriends / mọi lệnh Zalo đi qua exec().
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/modules/zalo/zalo-pool.js', () => ({ zaloPool: {} }));
vi.mock('../src/modules/zalo/zalo-rate-limiter.js', () => ({ zaloRateLimiter: {} }));
vi.mock('../src/shared/database/prisma-client.js', () => ({ prisma: {} }));
vi.mock('../src/shared/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { isTransientNetworkError } = await import('../src/shared/zalo-operations.js');

describe('isTransientNetworkError', () => {
  it('ECONNRESET qua cause.code (TypeError fetch failed)', () => {
    const cause: any = new Error('read ECONNRESET'); cause.code = 'ECONNRESET';
    const err: any = new TypeError('fetch failed'); err.cause = cause;
    expect(isTransientNetworkError(err)).toBe(true);
  });
  it('ETIMEDOUT / ENOTFOUND / socket hang up', () => {
    const a: any = new Error('x'); a.code = 'ETIMEDOUT';
    expect(isTransientNetworkError(a)).toBe(true);
    const b: any = new Error('getaddrinfo ENOTFOUND'); b.code = 'ENOTFOUND';
    expect(isTransientNetworkError(b)).toBe(true);
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
  });
  it('undici UND_ERR_*', () => {
    const e: any = new Error('body timeout'); e.code = 'UND_ERR_BODY_TIMEOUT';
    expect(isTransientNetworkError(e)).toBe(true);
  });
  it('lỗi nghiệp vụ Zalo (404, [zalo:112]) KHÔNG phải mạng', () => {
    const e: any = new Error('Request failed with status code 404'); e.code = null;
    expect(isTransientNetworkError(e)).toBe(false);
    expect(isTransientNetworkError(new Error('[zalo:112] permission'))).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });
});
