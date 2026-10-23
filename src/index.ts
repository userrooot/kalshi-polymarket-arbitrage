import { config } from "./config.ts";
import { btcPrice, pollBtc } from "./btc.ts";
import { startBrti } from "./feeds/brti.ts";
import { startChainlink, chainlinkSpot } from "./feeds/chainlink.ts";
import { startKalshiBook } from "./feeds/kalshiBook.ts";
import { feedStats, rate } from "./feeds/meter.ts";
import { onChange } from "./feeds/notify.ts";
import { startPolyBook } from "./feeds/polyBook.ts";
import { fetchKalshi } from "./kalshi.ts";
import { fetchPolymarket } from "./polymarket.ts";
import { broadcast, server } from "./server.ts";
import { buildState, onTick, settleDue } from "./simulator.ts";

console.log(`[sim] PAPER TRADING ONLY. http://localhost:${server.port}  maxCost<${config.maxTotalCost}¢ x${config.contractsPerTrade} contracts, <=${config.maxTradesPerEvent} trades/event`);

const fmt = (n: number | null) => (n === null ? "--" : String(Math.round(n * 10) / 10));
const tickRate = rate(), bcastRate = rate();
let lastBroadcast = 0, bcastTimer: ReturnType<typeof setTimeout> | null = null, lastLog = 0;
let latest: ReturnType<typeof buildState> | null = null;

function flush() {
  if (bcastTimer) { clearTimeout(bcastTimer); bcastTimer = null; }
  if (!latest) return;
  lastBroadcast = Date.now(); bcastRate.hit();
  // feeds/tickRate are refreshed at send time
  broadcast({ ...latest, now: Date.now(), feeds: feedStats(), tickRate: { ticksPerSec: tickRate.perSec(), broadcastsPerSec: bcastRate.perSec() } });
}
function scheduleBroadcast() {
  const wait = config.broadcastMinMs - (Date.now() - lastBroadcast);
  if (wait <= 0) flush();
  else if (!bcastTimer) bcastTimer = setTimeout(flush, wait);
}

let running = false, dirty = false;
async function tick() {
  if (running) { dirty = true; return; }
  running = true;
  try {
    do {
      dirty = false;
      const now = Date.now();
      const [k, p] = await Promise.all([fetchKalshi(now).catch(() => null), fetchPolymarket(now).catch(() => null)]);
      tickRate.hit();
      const btc = chainlinkSpot()?.price ?? btcPrice();
      const { combos, taken } = onTick(k, p, btc, now);
      latest = buildState(now, btc, k, p, combos, { feeds: [], tickRate: { ticksPerSec: 0, broadcastsPerSec: 0 } });
      scheduleBroadcast();
      if (taken.length || now - lastLog >= 1000) {
        lastLog = now;
        console.log(
          `[tick] ${k?.closeTime.slice(11, 19) ?? "no-event"} BTC ${fmt(btc)} (K ${fmt(k?.spot ?? null)} ${k?.spotSource ?? "-"}) | K up/down ${fmt(k?.upAsk ?? null)}/${fmt(k?.downAsk ?? null)} (${k?.quoteSource}/${k?.quoteAgeMs}ms) P up/down ${fmt(p?.upAsk ?? null)}/${fmt(p?.downAsk ?? null)} (${p?.quoteSource}/${p?.quoteAgeMs}ms) | ` +
            `K_UP+P_DOWN ${fmt(combos[0]!.totalCost)} K_DOWN+P_UP ${fmt(combos[1]!.totalCost)}` +
            taken.map((t) => ` | TRADE #${t.id} ${t.combo} @${t.totalCost}¢ (event trade ${t.seq})`).join(""),
        );
      }
    } while (dirty);
  } catch (e) { console.error("[tick] error", e); }
  finally { running = false; }
}

// Event-driven ticks: any book/spot change schedules a tick, debounced (leading edge, then at most one per debounce window).
let lastTickAt = 0, tickTimer: ReturnType<typeof setTimeout> | null = null;
function requestTick() {
  if (tickTimer) return;
  const wait = Math.max(0, config.tickDebounceMs - (Date.now() - lastTickAt));
  tickTimer = setTimeout(() => { tickTimer = null; lastTickAt = Date.now(); void tick(); }, wait);
}
onChange(requestTick);

startChainlink(); startBrti(); startPolyBook(); startKalshiBook();
setInterval(() => { lastTickAt = Date.now(); void tick(); }, config.tickHeartbeatMs); // 1s floor heartbeat
setInterval(() => { pollBtc().catch(() => {}); }, 5000); // REST spot is only a fallback now
pollBtc().catch(() => {});
(async () => { for (;;) { try { await settleDue(Date.now()); } catch (e) { console.error("[settle loop]", e); } await Bun.sleep(1000); } })();
