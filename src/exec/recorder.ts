// Raw market-data recorder: NDJSON lines {v:1,src,recv,recvMono,venueTs?,raw} -> <dir>/YYYYMMDD-HH.ndjson (UTC hours).
// Closed files are gzipped (streaming, async), total size is capped by deleting the oldest files. Writes are buffered and
// flushed on a timer through a serialized async chain, so the event loop is never blocked by disk I/O.
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export interface RecordLine { v: 1; src: string; recv: number; recvMono: number; venueTs?: number; raw: string }
export interface RecorderOpts {
  dir: string;
  retentionGB?: number;      // default 20
  flushMs?: number;          // default 250
  now?: () => Date;          // wall clock (tests); also used for hour rotation
  gzip?: boolean;            // default true
  retentionEveryMs?: number; // default 60s
}
export interface RecorderStats { msgs: number; bytes: number; file: string | null }

/** High-resolution epoch ms (float). */
export const hrNow = () => performance.timeOrigin + performance.now();

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const hourName = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}`;
const FILE_RE = /^\d{8}-\d{2}(\.\d+)?\.ndjson(\.gz)?$/;

/** Best-effort venue timestamp (ms) from a raw JSON message, without a full parse. */
export function sniffVenueTs(raw: string): number | undefined {
  let m = /"(?:sending_)?ts_ms"\s*:\s*(\d{12,16})/.exec(raw);
  if (m) return Number(m[1]);
  m = /"timestamp"\s*:\s*"?(\d{12,16})/.exec(raw);
  if (m) return Number(m[1]);
  m = /"ts"\s*:\s*(\d{9,10})\b/.exec(raw); // Kalshi seconds
  if (m) return Number(m[1]) * 1000;
  return undefined;
}

export class Recorder {
  private o: Required<Omit<RecorderOpts, "now">> & { now: () => Date };
  private buf: string[] = [];
  private curHour = "";
  private curFile: string | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRetention = 0;
  private closed = false;
  msgs = 0; bytes = 0;

  constructor(opts: RecorderOpts) {
    this.o = {
      retentionGB: 20, flushMs: 250, gzip: true, retentionEveryMs: 60_000, now: () => new Date(), ...opts,
    } as any;
    mkdirSync(this.o.dir, { recursive: true });
    // Compress leftovers of a previous run (uncompressed files from earlier hours; the current hour is re-opened for append).
    const cur = hourName(this.o.now());
    for (const f of readdirSync(this.o.dir)) if (/^\d{8}-\d{2}\.ndjson$/.test(f) && !f.startsWith(cur)) this.chain = this.chain.then(() => this.compress(join(this.o.dir, f)));
    this.timer = setInterval(() => { void this.flush(); }, this.o.flushMs);
    this.timer.unref?.();
  }

  stats(): RecorderStats { return { msgs: this.msgs, bytes: this.bytes, file: this.curFile }; }

  record(src: string, raw: string, venueTs?: number | null): void {
    if (this.closed) return;
    const mono = performance.now();
    const line: RecordLine = { v: 1, src, recv: performance.timeOrigin + mono, recvMono: mono, raw };
    const vt = venueTs ?? sniffVenueTs(raw);
    if (vt !== undefined && vt !== null) line.venueTs = vt;
    const s = JSON.stringify(line) + "\n";
    this.buf.push(s);
    this.msgs++; this.bytes += s.length;
    // Hour boundary: rotate on the next flush; don't wait 250ms if the buffer would mix hours.
    if (hourName(this.o.now()) !== this.curHour && this.curHour) void this.flush();
  }

  /** Write the buffer to the current hour's file (serialized). Resolves when this and all earlier writes are on disk. */
  flush(): Promise<void> {
    const data = this.buf.length ? this.buf.join("") : "";
    this.buf = [];
    const nowD = this.o.now();
    const hour = hourName(nowD);
    this.chain = this.chain.then(async () => {
      try {
        if (hour !== this.curHour) {
          const old = this.curFile;
          this.curHour = hour;
          this.curFile = join(this.o.dir, `${hour}.ndjson`);
          if (old) await this.compress(old);
        }
        if (data) await appendFile(this.curFile!, data);
        if (Date.now() - this.lastRetention >= this.o.retentionEveryMs) { this.lastRetention = Date.now(); this.enforceRetention(); }
      } catch (e) { console.error("[recorder] write failed", e); }
    });
    return this.chain as Promise<void>;
  }

  /** Wait for all pending writes and compressions. */
  async idle(): Promise<void> { await this.flush(); await this.chain; }

  /** Flush, close and gzip the current file. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.chain;
    if (this.curFile) { const f = this.curFile; this.curFile = null; await this.compress(f); }
  }

  private async compress(file: string): Promise<void> {
    if (!this.o.gzip || !existsSync(file)) return;
    let target = `${file}.gz`;
    for (let i = 1; existsSync(target); i++) target = file.replace(/\.ndjson$/, `.${i}.ndjson`) + ".gz";
    try {
      await pipeline(createReadStream(file), createGzip({ level: 6 }), createWriteStream(target));
      unlinkSync(file);
    } catch (e) { console.error("[recorder] gzip failed", e); try { unlinkSync(target); } catch {} }
  }

  /** Delete oldest files until total size <= retentionGB (never the file being written). */
  enforceRetention(): string[] {
    const cap = this.o.retentionGB * 1e9;
    const files = readdirSync(this.o.dir).filter((f) => FILE_RE.test(f)).sort().map((f) => {
      const p = join(this.o.dir, f);
      return { p, size: statSync(p).size };
    });
    let total = files.reduce((a, f) => a + f.size, 0);
    const deleted: string[] = [];
    for (const f of files) {
      if (total <= cap) break;
      if (f.p === this.curFile) continue;
      try { unlinkSync(f.p); total -= f.size; deleted.push(f.p); } catch {}
    }
    return deleted;
  }
}

/** Read a recorded file (.ndjson or .ndjson.gz) as parsed lines. Malformed lines are skipped. */
export async function readRecording(path: string): Promise<RecordLine[]> {
  let buf: Uint8Array<ArrayBuffer> = new Uint8Array(await Bun.file(path).arrayBuffer());
  if (path.endsWith(".gz")) buf = Bun.gunzipSync(buf);
  const out: RecordLine[] = [];
  for (const l of new TextDecoder().decode(buf).split("\n")) {
    if (!l) continue;
    try { const j = JSON.parse(l); if (j && j.v === 1 && typeof j.raw === "string") out.push(j); } catch {}
  }
  return out;
}

/** Recording files in a dir (or a single file), chronologically sorted. */
export function listRecordings(pathOrDir: string): string[] {
  const st = statSync(pathOrDir);
  if (st.isFile()) return [pathOrDir];
  return readdirSync(pathOrDir).filter((f) => FILE_RE.test(f)).sort().map((f) => join(pathOrDir, f));
}
