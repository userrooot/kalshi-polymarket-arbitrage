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
  port: num("PORT", 3000),
  dbPath: str("DB_PATH", "data/sim.sqlite"),
  kalshiBase: str("KALSHI_BASE_URL", "https://api.elections.kalshi.com/trade-api/v2"),
  gammaUrl: str("POLY_GAMMA_URL", "https://gamma-api.polymarket.com"),
  clobUrl: str("POLY_CLOB_URL", "https://clob.polymarket.com"),
  settlePollMs: 10_000,
  settleGiveUpMs: 30 * 60_000,
  // Unused for now (simulation only, public endpoints):
  kalshiApiKeyId: process.env.KALSHI_API_KEY_ID,
  kalshiPrivateKey: process.env.KALSHI_PRIVATE_KEY,
};
