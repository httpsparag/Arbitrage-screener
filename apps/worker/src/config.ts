// Reads and validates worker configuration from environment variables.
// Secret values are never printed; use `mask` for anything shown on screen.

export interface AngelConfig {
  apiKey: string;
  clientCode: string;
  pin: string;
  totpSecret: string;
  publicIp: string | null;
}

export class ConfigError extends Error {}

export function loadAngelConfig(env: NodeJS.ProcessEnv = process.env): AngelConfig {
  const required = ['ANGEL_API_KEY', 'ANGEL_CLIENT_CODE', 'ANGEL_PIN', 'ANGEL_TOTP_SECRET'] as const;
  const missing = required.filter((k) => !env[k]?.trim());
  if (missing.length) {
    throw new ConfigError(
      `Missing ${missing.join(', ')}. Copy apps/worker/.env.example to apps/worker/.env and fill it in.`,
    );
  }
  return {
    apiKey: env.ANGEL_API_KEY!.trim(),
    clientCode: env.ANGEL_CLIENT_CODE!.trim().toUpperCase(),
    pin: env.ANGEL_PIN!.trim(),
    totpSecret: env.ANGEL_TOTP_SECRET!.replace(/\s+/g, '').toUpperCase(),
    publicIp: env.ANGEL_PUBLIC_IP?.trim() || null,
  };
}

/** Shows only the first and last two characters, e.g. "A1****56". */
export function mask(value: string): string {
  if (value.length <= 4) return '****';
  return `${value.slice(0, 2)}${'*'.repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
}
