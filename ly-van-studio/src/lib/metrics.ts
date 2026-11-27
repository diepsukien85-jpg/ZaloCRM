/** Công thức analytics theo đặc tả. Mẫu số bằng 0 → trả null (hiển thị "—"), không trả 0 hay Infinity. */
const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);

export type Totals = {
  views: number; reach: number; likes: number; comments: number; shares: number; saves: number;
  leads: number; orders: number; revenue: number; gross_profit: number; ad_spend: number; ai_cost: number;
  qualified_leads?: number; new_customers?: number; attributed_revenue?: number; attributed_gross_profit?: number;
};

export type EngagementBase = 'views' | 'reach';

export function engagementRate(t: Pick<Totals, 'likes' | 'comments' | 'shares' | 'saves' | 'views' | 'reach'>, base: EngagementBase = 'views') {
  const r = div(t.likes + t.comments + t.shares + t.saves, t[base]);
  return r == null ? null : r * 100;
}
export function leadConversionRate(leads: number, visitsOrViews: number) { const r = div(leads, visitsOrViews); return r == null ? null : r * 100; }
export function salesConversionRate(orders: number, qualifiedLeads: number) { const r = div(orders, qualifiedLeads); return r == null ? null : r * 100; }
export const cpl = (marketingCost: number, leads: number) => div(marketingCost, leads);
export const cac = (acquisitionCost: number, newCustomers: number) => div(acquisitionCost, newCustomers);
export const roas = (adAttributedRevenue: number, adSpend: number) => div(adAttributedRevenue, adSpend);
export const costPerOrder = (cost: number, orders: number) => div(cost, orders);
/** ROI = (Lợi nhuận gộp quy thuộc − Chi phí MKT) / Chi phí MKT × 100. Doanh thu ≠ lợi nhuận. */
export function marketingRoi(attributedGrossProfit: number, marketingCost: number) {
  const r = div(attributedGrossProfit - marketingCost, marketingCost);
  return r == null ? null : r * 100;
}
export const profitAfterMarketing = (grossProfit: number, marketingCost: number) => grossProfit - marketingCost;

export function summarize(t: Totals, base: EngagementBase = 'views') {
  const marketingCost = t.ad_spend + t.ai_cost;
  return {
    engagement_rate: engagementRate(t, base),
    lead_conversion_rate: leadConversionRate(t.leads, t.views),
    sales_conversion_rate: salesConversionRate(t.orders, t.qualified_leads ?? t.leads),
    cpl: cpl(marketingCost, t.leads),
    cost_per_order: costPerOrder(marketingCost, t.orders),
    cac: cac(marketingCost, t.new_customers ?? t.orders),
    roas: roas(t.attributed_revenue ?? t.revenue, t.ad_spend),
    marketing_roi: marketingRoi(t.attributed_gross_profit ?? t.gross_profit, marketingCost),
    profit_after_marketing: profitAfterMarketing(t.gross_profit, marketingCost),
    marketing_cost: marketingCost,
    engagement_base: base,
  };
}
