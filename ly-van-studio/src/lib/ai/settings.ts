import { one, q } from '../db';
import { decrypt, encrypt } from '../crypto';

export type ProviderId = 'anthropic' | 'openai' | 'gemini';
export const PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini'];
export const ENV_KEYS: Record<ProviderId, string> = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' };

/** Model mặc định: chỉnh được trong Cài đặt. Không phải cam kết model còn tồn tại — hãy kiểm tra tài liệu nhà cung cấp. */
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-4.1',
  gemini: 'gemini-3.5-flash',
};

export type AiSettings = {
  primary: ProviderId;
  fallback: ProviderId[];
  providers: Record<ProviderId, { enabled: boolean; model: string; encrypted_key?: string | null }>;
  task_models: Record<string, { provider: ProviderId; model: string }>;
  cache_ttl_hours: number;
  timeout_ms: number;
};

export function defaultAiSettings(): AiSettings {
  return {
    primary: 'anthropic',
    fallback: ['openai', 'gemini'],
    providers: {
      anthropic: { enabled: true, model: DEFAULT_MODELS.anthropic },
      openai: { enabled: true, model: DEFAULT_MODELS.openai },
      gemini: { enabled: true, model: DEFAULT_MODELS.gemini },
    },
    task_models: {},
    cache_ttl_hours: 24,
    timeout_ms: 60000,
  };
}

export async function getSetting<T>(workspaceId: string, key: string): Promise<T | null> {
  const r = await one<{ value: T }>('SELECT value FROM app_settings WHERE workspace_id=$1 AND key=$2', [workspaceId, key]);
  return r?.value ?? null;
}
export async function setSetting(workspaceId: string, key: string, value: unknown) {
  await q(`INSERT INTO app_settings(workspace_id, key, value) VALUES ($1,$2,$3)
           ON CONFLICT (workspace_id, key) DO UPDATE SET value = EXCLUDED.value`, [workspaceId, key, JSON.stringify(value)]);
}

export async function getAiSettings(workspaceId: string): Promise<AiSettings> {
  const saved = await getSetting<Partial<AiSettings>>(workspaceId, 'ai_providers');
  const d = defaultAiSettings();
  if (!saved) return d;
  return {
    ...d, ...saved,
    providers: {
      anthropic: { ...d.providers.anthropic, ...saved.providers?.anthropic },
      openai: { ...d.providers.openai, ...saved.providers?.openai },
      gemini: { ...d.providers.gemini, ...saved.providers?.gemini },
    },
  };
}

/** Khoá: ưu tiên khoá lưu mã hoá trong Cài đặt, sau đó biến môi trường. Không bao giờ trả khoá ra frontend. */
export function resolveKey(s: AiSettings, p: ProviderId): string | null {
  const enc = s.providers[p].encrypted_key;
  if (enc) { try { return decrypt(enc); } catch { return null; } }
  return process.env[ENV_KEYS[p]] || null;
}
export function encryptKey(k: string) { return encrypt(k); }

/** Dạng an toàn để gửi cho UI. */
export function publicAiSettings(s: AiSettings) {
  return {
    primary: s.primary, fallback: s.fallback, task_models: s.task_models, cache_ttl_hours: s.cache_ttl_hours, timeout_ms: s.timeout_ms,
    providers: Object.fromEntries(PROVIDERS.map((p) => [p, {
      enabled: s.providers[p].enabled, model: s.providers[p].model,
      key_source: s.providers[p].encrypted_key ? 'workspace' : process.env[ENV_KEYS[p]] ? 'env' : 'none',
    }])),
  };
}
