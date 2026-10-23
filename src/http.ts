/** fetch JSON with a hard timeout; returns null on any failure (never throws). */
export async function getJson<T = any>(url: string, timeoutMs = 4000): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}
/** Parse a field that may be a JSON string or already an array. */
export function jsonArr(v: unknown): any[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch {}
  return [];
}
/** A real, buyable ask in cents (exclusive of 0 and 100), else null. */
export const realAsk = (cents: number | null): number | null =>
  cents !== null && Number.isFinite(cents) && cents > 0 && cents < 100 ? Math.round(cents * 100) / 100 : null;
