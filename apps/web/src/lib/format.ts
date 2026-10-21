const inr = (dp: number) =>
  new Intl.NumberFormat("en-IN", { minimumFractionDigits: dp, maximumFractionDigits: dp });

const cache = new Map<number, Intl.NumberFormat>();
function nf(dp: number) {
  let f = cache.get(dp);
  if (!f) cache.set(dp, (f = inr(dp)));
  return f;
}

export function num(v: number | null | undefined, dp = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "—" : nf(dp).format(v);
}

export function rupees(v: number | null | undefined, dp = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v < 0 ? "−" : ""}₹${nf(dp).format(Math.abs(v))}`;
}

export function pct(v: number | null | undefined, dp = 2, signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const s = nf(dp).format(Math.abs(v));
  return `${v < 0 ? "−" : signed && v > 0 ? "+" : ""}${s}%`;
}

/** Compact Indian units: ₹12.3 cr, ₹45.6 L. */
export function compactRupees(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v >= 1e7) return `₹${nf(1).format(v / 1e7)} cr`;
  if (v >= 1e5) return `₹${nf(1).format(v / 1e5)} L`;
  return `₹${nf(0).format(v)}`;
}

export function ago(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function istTime(ms: number | null | undefined, withSeconds = true): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    second: withSeconds ? "2-digit" : undefined,
    hour12: false,
  });
}

export function expiryLabel(expiry: string): string {
  const d = new Date(`${expiry}T00:00:00Z`);
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
}
