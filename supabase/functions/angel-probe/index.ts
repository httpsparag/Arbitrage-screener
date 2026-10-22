// Feasibility probe: can a Supabase Edge Function (cloud IP, not the registered home IP)
// log in to Angel One SmartAPI, fetch quotes and query margins?
// Invoke with header `x-probe-key: <PROBE_KEY secret>`. Returns no credentials.

const ROOT = "https://apiconnect.angelone.in";

const env = (k: string) => (Deno.env.get(k) ?? "").trim();

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

async function totp(secret: string, nowMs = Date.now()): Promise<string> {
  const counter = Math.floor(nowMs / 1000 / 30);
  const msg = new Uint8Array(8);
  new DataView(msg.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey("raw", base32Decode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const h = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = h[h.length - 1] & 0x0f;
  const code = (new DataView(h.buffer).getUint32(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, "0");
}

async function call(route: string, body: unknown, ip: string, jwt?: string) {
  const res = await fetch(ROOT + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-UserType": "USER",
      "X-SourceID": "WEB",
      "X-ClientLocalIP": "127.0.0.1",
      "X-ClientPublicIP": ip,
      "X-MACAddress": "00:00:00:00:00:00",
      "X-PrivateKey": env("ANGEL_API_KEY"),
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { http: res.status, json: JSON.parse(text) };
  } catch {
    return { http: res.status, json: { status: false, message: text.slice(0, 200) } };
  }
}

Deno.serve(async (req) => {
  if (!env("PROBE_KEY") || req.headers.get("x-probe-key") !== env("PROBE_KEY")) {
    return new Response("forbidden", { status: 403 });
  }
  const report: Record<string, unknown> = {};
  const egressIp = await fetch("https://api.ipify.org").then((r) => r.text()).catch(() => "unknown");
  report.egressIp = egressIp;

  const login = await call(
    "/rest/auth/angelbroking/user/v1/loginByPassword",
    { clientcode: env("ANGEL_CLIENT_CODE").toUpperCase(), password: env("ANGEL_PIN"), totp: await totp(env("ANGEL_TOTP_SECRET")) },
    egressIp,
  );
  const jwt = login.json?.data?.jwtToken as string | undefined;
  report.login = jwt ? "ok" : { http: login.http, message: login.json?.message, errorcode: login.json?.errorcode };
  if (!jwt) return Response.json(report);

  const quote = await call(
    "/rest/secure/angelbroking/market/v1/quote",
    { mode: "FULL", exchangeTokens: { NSE: ["2885"] } },
    egressIp,
    jwt,
  );
  const q = quote.json?.data?.fetched?.[0];
  report.quote = q
    ? { symbol: q.tradingSymbol, ltp: q.ltp, bid: q.depth?.buy?.[0]?.price, ask: q.depth?.sell?.[0]?.price, feedTime: q.exchFeedTime }
    : { http: quote.http, message: quote.json?.message, errorcode: quote.json?.errorcode };

  const margin = await call(
    "/rest/secure/angelbroking/margin/v1/batch",
    { positions: [{ exchange: "NSE", qty: 1, price: 0, productType: "DELIVERY", token: "2885", tradeType: "BUY", orderType: "MARKET" }] },
    egressIp,
    jwt,
  );
  report.margin = margin.json?.status ? { totalMarginRequired: margin.json?.data?.totalMarginRequired } : { http: margin.http, message: margin.json?.message };

  await call("/rest/secure/angelbroking/user/v1/logout", { clientcode: env("ANGEL_CLIENT_CODE").toUpperCase() }, egressIp, jwt);
  return Response.json(report);
});
