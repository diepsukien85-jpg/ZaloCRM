export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'error', public details?: unknown) { super(message); }
}
export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, 'bad_request', d);
export const unauthorized = (m = 'Chưa đăng nhập') => new HttpError(401, m, 'unauthorized');
export const forbidden = (m = 'Bạn không có quyền thực hiện thao tác này') => new HttpError(403, m, 'forbidden');
export const notFound = (m = 'Không tìm thấy dữ liệu') => new HttpError(404, m, 'not_found');
export const conflict = (m: string) => new HttpError(409, m, 'conflict');
export const tooMany = (m = 'Quá nhiều yêu cầu, thử lại sau ít phút') => new HttpError(429, m, 'rate_limited');
export const paymentRequired = (m: string) => new HttpError(402, m, 'budget_exceeded');
