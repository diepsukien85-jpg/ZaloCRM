import { describe, it, expect } from 'vitest';
import { cac, cpl, engagementRate, leadConversionRate, marketingRoi, roas, salesConversionRate, summarize, profitAfterMarketing } from '@/lib/metrics';

describe('công thức analytics', () => {
  it('engagement rate = tổng tương tác / mẫu số × 100', () => {
    const t = { likes: 80, comments: 10, shares: 5, saves: 5, views: 1000, reach: 500 };
    expect(engagementRate(t, 'views')).toBeCloseTo(10);
    expect(engagementRate(t, 'reach')).toBeCloseTo(20);
  });
  it('mẫu số bằng 0 trả null (không Infinity/NaN/0)', () => {
    expect(engagementRate({ likes: 5, comments: 0, shares: 0, saves: 0, views: 0, reach: 0 })).toBeNull();
    expect(leadConversionRate(3, 0)).toBeNull();
    expect(salesConversionRate(2, 0)).toBeNull();
    expect(cpl(1000, 0)).toBeNull();
    expect(cac(1000, 0)).toBeNull();
    expect(roas(1000, 0)).toBeNull();
    expect(marketingRoi(1000, 0)).toBeNull();
  });
  it('CPL, CAC, ROAS, ROI', () => {
    expect(cpl(1_000_000, 20)).toBe(50_000);
    expect(cac(2_000_000, 4)).toBe(500_000);
    expect(roas(30_000_000, 10_000_000)).toBe(3);
    // ROI dùng LỢI NHUẬN GỘP, không dùng doanh thu
    expect(marketingRoi(15_000_000, 10_000_000)).toBeCloseTo(50);
    expect(marketingRoi(5_000_000, 10_000_000)).toBeCloseTo(-50);
  });
  it('không nhầm doanh thu với lợi nhuận', () => {
    const s = summarize({ views: 1000, reach: 800, likes: 0, comments: 0, shares: 0, saves: 0, leads: 10, orders: 2, revenue: 100_000_000, gross_profit: 20_000_000, ad_spend: 10_000_000, ai_cost: 0 });
    expect(s.marketing_roi).toBeCloseTo(100); // (20-10)/10, không phải (100-10)/10
    expect(s.roas).toBe(10);
    expect(s.profit_after_marketing).toBe(10_000_000);
    expect(profitAfterMarketing(20_000_000, 10_000_000)).toBe(10_000_000);
  });
  it('chi phí marketing gồm cả chi phí AI', () => {
    const s = summarize({ views: 0, reach: 0, likes: 0, comments: 0, shares: 0, saves: 0, leads: 5, orders: 0, revenue: 0, gross_profit: 0, ad_spend: 900, ai_cost: 100 });
    expect(s.marketing_cost).toBe(1000);
    expect(s.cpl).toBe(200);
  });
});
