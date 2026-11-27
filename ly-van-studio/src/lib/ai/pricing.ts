import { getSetting } from './settings';

/** USD / 1 triệu token. Giá mặc định chỉ là ƯỚC TÍNH ban đầu — người dùng phải cập nhật theo bảng giá nhà cung cấp. */
export type PriceRow = { provider: string; model: string; input_per_m: number; output_per_m: number };
export type PricingTable = { updated_at: string; verified: boolean; usd_to_vnd: number; rows: PriceRow[] };

export const DEFAULT_PRICING: PricingTable = {
  updated_at: '2026-11-27',
  verified: false,
  usd_to_vnd: 25500,
  rows: [
    { provider: 'anthropic', model: 'claude-sonnet-5-5', input_per_m: 3, output_per_m: 15 },
    { provider: 'anthropic', model: 'claude-haiku-5-5', input_per_m: 1, output_per_m: 5 },
    { provider: 'anthropic', model: 'claude-opus-5-5', input_per_m: 5, output_per_m: 25 },
    { provider: 'openai', model: 'gpt-4.1', input_per_m: 2, output_per_m: 8 },
    { provider: 'gemini', model: 'gemini-2.5-flash', input_per_m: 0.3, output_per_m: 2.5 },
  ],
};

export async function getPricing(workspaceId: string): Promise<PricingTable> {
  return (await getSetting<PricingTable>(workspaceId, 'ai_pricing')) ?? DEFAULT_PRICING;
}

export function estimateCost(t: PricingTable, provider: string, model: string, inTok: number, outTok: number): number {
  if (provider === 'demo') return 0;
  const row = t.rows.find((r) => r.provider === provider && r.model === model) ?? t.rows.find((r) => r.provider === provider);
  if (!row) return 0;
  return (inTok * row.input_per_m + outTok * row.output_per_m) / 1_000_000;
}
