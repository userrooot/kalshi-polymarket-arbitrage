const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return process.env[k] !== undefined && process.env[k] !== "" && Number.isFinite(v) ? v : d;
};
const str = (k: string, d: string) => process.env[k] || d;

export const config = {
  maxTotalCost: num("MAX_TOTAL_COST", 90),
  contractsPerTrade: num("CONTRACTS_PER_TRADE", 10),
  maxTradesPerEvent: num("MAX_TRADES_PER_EVENT", 20),
  tradeCooldownMs: num("TRADE_COOLDOWN_MS", 5000),
  noTradeLastSec: num("NO_TRADE_LAST_SEC", 20),
  pollMs: num("POLL_MS", 1000),
  kalshiBookPollMs: num("KALSHI_BOOK_POLL_MS", 350),
  maxQuoteAgeMs: num("MAX_QUOTE_AGE_MS", 3000),
  tickDebounceMs: num("TICK_DEBOUNCE_MS", 150),
  tickHeartbeatMs: num("TICK_HEARTBEAT_MS", 1000),
  broadcastMinMs: num("BROADCAST_MIN_MS", 250),
  port: num("PORT", 3000),
  host: str("HOST", "127.0.0.1"), // dashboard has no auth: loopback by default
  dbPath: str("DB_PATH", "data/sim.sqlite"),
  kalshiBase: str("KALSHI_BASE_URL", "https://api.elections.kalshi.com/trade-api/v2"),
  gammaUrl: str("POLY_GAMMA_URL", "https://gamma-api.polymarket.com"),
  clobUrl: str("POLY_CLOB_URL", "https://clob.polymarket.com"),
  settlePollMs: 10_000,
  settleGiveUpMs: 30 * 60_000,
  // Optional authenticated websockets (read-only data; no orders are ever sent). Never logged.
  kalshiApiKeyId: process.env.KALSHI_API_KEY_ID || undefined,
  kalshiPrivateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH || undefined,
  kalshiPrivateKey: process.env.KALSHI_PRIVATE_KEY || undefined, // inline PEM; literal \n accepted
  kalshiWsUrl: str("KALSHI_WS_URL", "wss://external-api-ws.kalshi.com/trade-api/ws/v2"),
  polyApiKey: process.env.POLY_API_KEY || undefined,
  polyApiSecret: process.env.POLY_API_SECRET || undefined,
  polyApiPassphrase: process.env.POLY_API_PASSPHRASE || undefined,
  polyLiveWsUrl: str("POLY_LIVE_WS_URL", "wss://ws-live-v2.polymarket.com/ws"),
  // --- realistic execution simulation (src/exec/*) ---
  execSim: num("EXEC_SIM", 1) !== 0,
  slippageTicks: num("SLIPPAGE_TICKS", 1),          // limit price = seen ask + N ticks
  raceWindowMs: num("RACE_WINDOW_MS", 2),           // levels that change within this window after arrival count as taken
  pLoseRace: num("P_LOSE_RACE", 0.3),               // extra chance to lose the best level when the opportunity died <=20ms after arrival (a guess)
  unwindMode: (str("UNWIND_MODE", "bid") === "hold" ? "hold" : "bid") as "bid" | "hold",
  unwindAfterMs: num("UNWIND_AFTER_MS", 500),
  feesOn: num("FEES_ON", 0) !== 0,                  // taker fees (formulas UNVERIFIED)
  bookHistoryMin: num("BOOK_HISTORY_MIN", 20),
  latProfile: str("LAT_PROFILE", "data/latency.json"),
  latKalshiMs: process.env.LAT_KALSHI_MS ? num("LAT_KALSHI_MS", NaN) : undefined, // what-if Kalshi round trip
  latPolyMs: process.env.LAT_POLY_MS ? num("LAT_POLY_MS", NaN) : undefined,       // what-if Polymarket round trip
  execPrimary: (["NAIVE", "PAR", "K_THEN_P", "P_THEN_K"].includes(str("EXEC_PRIMARY", "NAIVE")) ? str("EXEC_PRIMARY", "NAIVE") : "NAIVE") as "NAIVE" | "PAR" | "K_THEN_P" | "P_THEN_K",
  execSeed: process.env.EXEC_SEED ? num("EXEC_SEED", NaN) : undefined,
  episodeStaleMs: num("EPISODE_STALE_MS", 3000),
};
