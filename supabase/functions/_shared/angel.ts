// Angel One SmartAPI client for Deno (Edge Functions). Mirrors apps/worker's Node client.

const ROOT = "https://apiconnect.angelone.in";
const env = (k: string) => (Deno.env.get(k) ?? "").trim();

export class AngelError extends Error {
  constructor(message: string, readonly code: string | null, readonly http: number) {
    super(message);
  }
  /** Session expired or invalid; a fresh login should fix it. */
  get isAuth(): boolean {
    return this.http === 401 || this.http === 403 || /AG8001|AG8002|AG8003|token/i.test(`${this.code} ${this.message}`);
  }
}

function base32Decode(input: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error("TOTP secret is not valid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function totp(secret: string, nowMs = Date.now()): Promise<string> {
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(Math.floor(nowMs / 30_000)));
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = h[h.length - 1] & 0x0f;
  return ((new DataView(h.buffer).getUint32(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

let publicIp: string | null = null;
async function egressIp(): Promise<string> {
  if (publicIp) return publicIp;
  publicIp = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(4000) })
    .then((r) => r.text())
    .catch(() => "127.0.0.1");
  return publicIp;
}

async function post<T>(route: string, body: unknown, jwt?: string): Promise<T> {
  const res = await fetch(ROOT + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": await egressIp(),
      "X-MACAddress": "00:00:00:00:00:00",
      "X-PrivateKey": env("ANGEL_API_KEY"),
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json: { status?: boolean; message?: string; errorcode?: string; data?: T };
  try {
    json = JSON.parse(text);
  } catch {
    throw new AngelError(`Non-JSON response: ${text.slice(0, 160)}`, null, res.status);
  }
  if (!res.ok || !json.status) throw new AngelError(json.message || `HTTP ${res.status}`, json.errorcode ?? null, res.status);
  return json.data as T;
}

export interface AngelSession {
  jwt: string;
  feedToken: string;
}

export async function login(): Promise<AngelSession> {
  const data = await post<{ jwtToken: string; feedToken: string }>("/rest/auth/angelbroking/user/v1/loginByPassword", {
    clientcode: env("ANGEL_CLIENT_CODE").toUpperCase(),
    password: env("ANGEL_PIN"),
    totp: await totp(env("ANGEL_TOTP_SECRET")),
  });
  if (!data?.jwtToken) throw new AngelError("Login returned no session token", null, 200);
  return { jwt: data.jwtToken, feedToken: data.feedToken };
}

export interface FullQuote {
  exchange: string;
  tradingSymbol: string;
  symbolToken: string;
  ltp: number;
  avgPrice?: number;
  tradeVolume?: number;
  opnInterest?: number;
  exchFeedTime?: string;
  depth?: { buy?: { price: number; quantity: number; orders: number }[]; sell?: { price: number; quantity: number; orders: number }[] };
}

/** FULL quotes for any number of tokens, 50 per request, gently spaced. */
export async function quotes(jwt: string, tokens: { NSE: string[]; NFO: string[] }, spacingMs = 250): Promise<FullQuote[]> {
  const all = [...tokens.NSE.map((t) => ["NSE", t] as const), ...tokens.NFO.map((t) => ["NFO", t] as const)];
  const out: FullQuote[] = [];
  for (let i = 0; i < all.length; i += 50) {
    const batch: Record<string, string[]> = {};
    for (const [ex, t] of all.slice(i, i + 50)) (batch[ex] ??= []).push(t);
    const data = await post<{ fetched?: FullQuote[] }>("/rest/secure/angelbroking/market/v1/quote", { mode: "FULL", exchangeTokens: batch }, jwt);
    out.push(...(data?.fetched ?? []));
    if (i + 50 < all.length) await new Promise((r) => setTimeout(r, spacingMs));
  }
  return out;
}

/** 1-lot short-futures margin in rupees. */
export async function futuresMargin(jwt: string, token: string, qty: number): Promise<number> {
  const data = await post<{ totalMarginRequired: number }>(
    "/rest/secure/angelbroking/margin/v1/batch",
    { positions: [{ exchange: "NFO", qty, price: 0, productType: "CARRYFORWARD", token, tradeType: "SELL", orderType: "MARKET" }] },
    jwt,
  );
  return Number(data?.totalMarginRequired);
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };

/** "21-Oct-2026 13:47:51" (IST) → epoch ms. */
export function parseFeedTime(raw?: string): number | null {
  const m = raw && /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()];
  if (month === undefined) return null;
  return Date.UTC(+m[3], month, +m[1], +m[4], +m[5], +m[6]) - 330 * 60_000;
}
