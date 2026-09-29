/**
 * media-prune.test.ts — luật dọn bản nóng trên đĩa.
 *
 * Đây là chỗ nguy hiểm nhất của kho media: sai một chiều thì MẤT ẢNH chưa sao
 * lưu, sai chiều kia thì ĐẦY ĐĨA Mac mini (~19 GiB/ngày, đo 22/09/2026).
 * Ba luật phải giữ:
 *   1. còn hạn        → không đụng vào
 *   2. quá hạn + Drive ĐÃ có → xoá
 *   3. quá hạn + Drive CHƯA có → giữ lại, TRỪ KHI đĩa tụt dưới MEDIA_MIN_FREE_GB
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MEDIA_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'zalocrm-prune-'));
process.env.MEDIA_DIR = MEDIA_DIR;
process.env.MEDIA_LOCAL_RETENTION_DAYS = '3';
process.env.MEDIA_MIN_FREE_GB = '20';

/** Trạng thái Drive giả, chỉnh được từng test. */
const fake = {
  available: true,
  /** ngày → tên file Drive đang có. Thiếu ngày = Drive chưa có thư mục đó. */
  byDay: new Map<string, Set<string>>(),
  listThrows: false,
};

vi.mock('../src/shared/storage/drive-media.js', () => ({
  isAvailable: () => fake.available,
  whyUnavailable: () => (fake.available ? null : 'test: Drive tắt'),
  listNamesForDay: async (day: string) => {
    if (!fake.available) return null;
    if (fake.listThrows) throw new Error('Drive 500');
    return fake.byDay.get(day) ?? null;
  },
  uploadKey: async () => 'fake-id',
  findFileId: async () => null,
  downloadKey: async () => false,
  listKeysSince: async () => [],
  trashDayFoldersBefore: async () => 0,
  accountEmail: async () => null,
  storageQuota: async () => null,
}));

const store = await import('../src/shared/storage/media-store.js');

function dayOffset(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const HOM_NAY = dayOffset(0);
const HOM_QUA = dayOffset(1);
const QUA_HAN = dayOffset(5);
const QUA_HAN_HON = dayOffset(9);

async function seed(day: string, names: string[]) {
  await fsp.mkdir(path.join(MEDIA_DIR, day), { recursive: true });
  for (const n of names) await fsp.writeFile(path.join(MEDIA_DIR, day, n), 'x');
}

async function onDisk(day: string): Promise<string[]> {
  try {
    return (await fsp.readdir(path.join(MEDIA_DIR, day))).sort();
  } catch {
    return [];
  }
}

beforeEach(async () => {
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true });
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  fake.available = true;
  fake.listThrows = false;
  fake.byDay = new Map();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await fsp.rm(MEDIA_DIR, { recursive: true, force: true });
});

/**
 * Giả lập đĩa còn rộng / sắp đầy, không phụ thuộc ổ thật của máy chạy test.
 *
 * Phải chặn ở tầng `fsp.statfs` chứ KHÔNG spy được `store.freeDiskBytes`:
 * ESM dùng live binding, pruneLocalCache gọi thẳng hàm cục bộ trong module chứ
 * không đi qua object namespace, nên spy lên namespace không chen vào được.
 */
function gia_lap_dia_trong(gb: number) {
  const bsize = 4096;
  vi.spyOn(fsp, 'statfs').mockResolvedValue({
    bsize,
    bavail: Math.floor((gb * 1024 ** 3) / bsize),
  } as any);
}

describe('pruneLocalCache', () => {
  it('còn hạn thì không đụng vào, dù Drive chưa có bản sao', async () => {
    gia_lap_dia_trong(100);
    await seed(HOM_NAY, ['a.jpg']);
    await seed(HOM_QUA, ['b.jpg']);

    expect(await store.pruneLocalCache()).toBe(0);
    expect(await onDisk(HOM_NAY)).toEqual(['a.jpg']);
    expect(await onDisk(HOM_QUA)).toEqual(['b.jpg']);
  });

  it('quá hạn + Drive đã có → xoá file và gỡ luôn thư mục ngày', async () => {
    gia_lap_dia_trong(100);
    await seed(QUA_HAN, ['a.jpg', 'b.jpg']);
    fake.byDay.set(QUA_HAN, new Set(['a.jpg', 'b.jpg']));

    expect(await store.pruneLocalCache()).toBe(2);
    expect(await onDisk(QUA_HAN)).toEqual([]);
    await expect(fsp.access(path.join(MEDIA_DIR, QUA_HAN))).rejects.toThrow();
  });

  it('quá hạn nhưng Drive thiếu 1 file → giữ đúng file đó lại', async () => {
    gia_lap_dia_trong(100);
    await seed(QUA_HAN, ['co.jpg', 'chua-len.jpg']);
    fake.byDay.set(QUA_HAN, new Set(['co.jpg']));

    expect(await store.pruneLocalCache()).toBe(1);
    expect(await onDisk(QUA_HAN)).toEqual(['chua-len.jpg']);
  });

  it('Drive chưa có thư mục ngày đó → không xoá gì cả', async () => {
    gia_lap_dia_trong(100);
    await seed(QUA_HAN, ['a.jpg']);
    // fake.byDay không có QUA_HAN

    expect(await store.pruneLocalCache()).toBe(0);
    expect(await onDisk(QUA_HAN)).toEqual(['a.jpg']);
  });

  it('Drive lỗi khi liệt kê → thà giữ còn hơn xoá nhầm', async () => {
    gia_lap_dia_trong(100);
    await seed(QUA_HAN, ['a.jpg']);
    fake.listThrows = true;

    expect(await store.pruneLocalCache()).toBe(0);
    expect(await onDisk(QUA_HAN)).toEqual(['a.jpg']);
  });

  it('Drive tắt hẳn + đĩa còn rộng → không dọn', async () => {
    gia_lap_dia_trong(100);
    fake.available = false;
    await seed(QUA_HAN, ['a.jpg']);

    expect(await store.pruneLocalCache()).toBe(0);
    expect(await onDisk(QUA_HAN)).toEqual(['a.jpg']);
  });

  it('ĐĨA SẮP ĐẦY → xoá theo tuổi bất kể Drive, cứu máy trước', async () => {
    gia_lap_dia_trong(5);            // dưới ngưỡng 20GB
    fake.available = false;          // Drive hỏng hẳn
    await seed(QUA_HAN, ['a.jpg', 'b.jpg']);
    await seed(HOM_NAY, ['giu-lai.jpg']);

    expect(await store.pruneLocalCache()).toBe(2);
    expect(await onDisk(QUA_HAN)).toEqual([]);
    // Vẫn tôn trọng hạn giữ — ngày còn hạn không bị đụng.
    expect(await onDisk(HOM_NAY)).toEqual(['giu-lai.jpg']);
  });

  it('cứu đĩa thì xoá cả ngày CÒN TRONG HẠN — ngày cao điểm không có gì quá hạn để xoá', async () => {
    gia_lap_dia_trong(5);
    await seed(HOM_QUA, ['a.jpg', 'b.jpg']);   // còn hạn (giữ 3 ngày)
    await seed(HOM_NAY, ['dang-xem.jpg']);

    expect(await store.pruneLocalCache()).toBe(2);
    expect(await onDisk(HOM_QUA)).toEqual([]);
    // Hôm nay là bất khả xâm phạm — nhân viên đang mở xem.
    expect(await onDisk(HOM_NAY)).toEqual(['dang-xem.jpg']);
  });

  it('cứu đĩa xong là dừng, không xoá sạch kho', async () => {
    const bsize = 4096;
    let goi = 0;
    // Lượt đầu 5GB (dưới ngưỡng) → dọn; các lượt sau 50GB (đã đủ) → dừng.
    vi.spyOn(fsp, 'statfs').mockImplementation(async () => {
      const gb = goi++ === 0 ? 5 : 50;
      return { bsize, bavail: Math.floor((gb * 1024 ** 3) / bsize) } as any;
    });
    await seed(QUA_HAN_HON, ['cu.jpg']);
    await seed(QUA_HAN, ['moi-hon.jpg']);

    await store.pruneLocalCache();
    // Ngày cũ nhất đã dọn, ngày sau được tha vì chỗ trống đã hồi phục.
    expect(await onDisk(QUA_HAN_HON)).toEqual([]);
    expect(await onDisk(QUA_HAN)).toEqual(['moi-hon.jpg']);
  });

  it('cứu đĩa thì dọn ngày CŨ NHẤT trước', async () => {
    gia_lap_dia_trong(5);
    fake.available = false;
    await seed(QUA_HAN_HON, ['cu.jpg']);
    await seed(QUA_HAN, ['moi-hon.jpg']);

    const order: string[] = [];
    const rm = fsp.rm.bind(fsp);
    vi.spyOn(fsp, 'rm').mockImplementation(async (p: any, o: any) => {
      order.push(path.basename(path.dirname(String(p))));
      return rm(p, o);
    });

    await store.pruneLocalCache();
    expect(order[0]).toBe(QUA_HAN_HON);
  });

  it('hạn = 0 thì không bao giờ dọn', async () => {
    const goc = process.env.MEDIA_LOCAL_RETENTION_DAYS;
    try {
      vi.resetModules();
      process.env.MEDIA_LOCAL_RETENTION_DAYS = '0';
      const lai = await import('../src/shared/storage/media-store.js?no-prune');
      await seed(QUA_HAN, ['a.jpg']);
      expect(await lai.pruneLocalCache()).toBe(0);
      expect(await onDisk(QUA_HAN)).toEqual(['a.jpg']);
    } finally {
      process.env.MEDIA_LOCAL_RETENTION_DAYS = goc;
      vi.resetModules();
    }
  });
});
