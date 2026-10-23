// Extra config for the recorder/replay/probe layer (kept out of src/config.ts). Reads process.env lazily so tests can override.
const num = (k: string, d: number) => {
  const raw = process.env[k];
  const v = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(v) ? v : d;
};
const str = (k: string, d: string) => process.env[k] || d;
const flag = (k: string, d = false) => {
  const v = process.env[k];
  return v === undefined || v === "" ? d : v === "1" || v.toLowerCase() === "true";
};

export const config2 = {
  /** Record raw WS messages (default off; set RECORD_MD=1 on the UK server). */
  get recordMd() { return flag("RECORD_MD", false); },
  get mdDir() { return str("MD_DIR", "data/md"); },
  get mdRetentionGB() { return num("MD_RETENTION_GB", 20); },
  get latencyJson() { return str("LATENCY_JSON", "data/latency.json"); },
  // Kalshi demo (probe only; mock funds)
  get kalshiDemoKeyId() { return process.env.KALSHI_DEMO_API_KEY_ID || undefined; },
  get kalshiDemoKeyPath() { return process.env.KALSHI_DEMO_PRIVATE_KEY_PATH || undefined; },
  get kalshiDemoBase() { return str("KALSHI_DEMO_BASE_URL", "https://external-api.demo.kalshi.co/trade-api/v2"); },
  get calibrateLive() { return flag("CALIBRATE_LIVE", false); },
};
