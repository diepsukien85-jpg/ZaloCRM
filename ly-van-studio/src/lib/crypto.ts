import crypto from 'node:crypto';
import { appSecret } from './env';

function key(): Buffer {
  return crypto.createHash('sha256').update('lv-enc:' + appSecret()).digest();
}
/** AES-256-GCM. Định dạng: v1.<iv>.<tag>.<ciphertext> (base64url) */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}
export function decrypt(token: string): string {
  const [v, iv, tag, data] = token.split('.');
  if (v !== 'v1') throw new Error('Định dạng mã hoá không hợp lệ');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}
export function maskSecret(s: string): string {
  return s.length <= 8 ? '••••' : s.slice(0, 4) + '••••' + s.slice(-4);
}
export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}
