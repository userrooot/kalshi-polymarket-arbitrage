// Process-wide recorder tap. src/feeds/ws.ts calls tapRaw() for every inbound WS text frame; it's a no-op unless RECORD_MD=1.
import { config2 } from "./config2.ts";
import { Recorder, type RecorderStats } from "./recorder.ts";

let rec: Recorder | null = null;
let initTried = false;

function get(): Recorder | null {
  if (rec || initTried) return rec;
  initTried = true;
  if (!config2.recordMd) return null;
  rec = new Recorder({ dir: config2.mdDir, retentionGB: config2.mdRetentionGB });
  console.log(`[recorder] recording raw WS messages to ${config2.mdDir} (retention ${config2.mdRetentionGB} GB)`);
  const stop = () => { void rec?.close(); };
  process.once("SIGINT", () => { stop(); setTimeout(() => process.exit(0), 300); });
  process.once("SIGTERM", () => { stop(); setTimeout(() => process.exit(0), 300); });
  return rec;
}

/** Record one raw message from `source` (feed name). Safe to call unconditionally. */
export function recordRaw(source: string, msg: string, venueTs?: number | null): void {
  try {
    // Outbound frames (source ends with ">") are recorded for subscription mapping only: never anything credential-like, no pings.
    if (source.endsWith(">") && (/secret|passphrase|apikey|"auth"|signature/i.test(msg) || /"op"\s*:\s*"ping"/.test(msg))) return;
    get()?.record(source, msg, venueTs);
  } catch { /* never affect the feed */ }
}
/** Alias used by ws.ts. */
export const tapRaw = recordRaw;

export function recorderStats(): { enabled: boolean } & RecorderStats {
  const r = get();
  return r ? { enabled: true, ...r.stats() } : { enabled: false, msgs: 0, bytes: 0, file: null };
}
export async function recorderClose(): Promise<void> { await rec?.close(); }
/** Tests only. */
export function _resetRecorderHook() { rec = null; initTried = false; }
