import { config } from "./config.ts";
import { btcPrice, pollBtc } from "./btc.ts";
import { fetchKalshi } from "./kalshi.ts";
import { fetchPolymarket } from "./polymarket.ts";
import { broadcast, server } from "./server.ts";
import { buildState, onTick, settleDue } from "./simulator.ts";

console.log(`[sim] PAPER TRADING ONLY. http://localhost:${server.port}  maxCost<${config.maxTotalCost}¢ x${config.contractsPerTrade} contracts, <=${config.maxTradesPerEvent} trades/event`);

const fmt = (n: number | null) => (n === null ? "--" : String(Math.round(n * 10) / 10));

async function tick() {
  const now = Date.now();
  const [k, p] = await Promise.all([fetchKalshi(now).catch(() => null), fetchPolymarket(now).catch(() => null), pollBtc(now).catch(() => {})]).then((r) => [r[0], r[1]] as const);
  const { combos, taken } = onTick(k, p, btcPrice(), now);
  broadcast(buildState(now, btcPrice(), k, p, combos));
  console.log(
    `[tick] ${k?.closeTime.slice(11, 19) ?? "no-event"} BTC ${fmt(btcPrice())} | K up/down ${fmt(k?.upAsk ?? null)}/${fmt(k?.downAsk ?? null)} P up/down ${fmt(p?.upAsk ?? null)}/${fmt(p?.downAsk ?? null)} | ` +
      `K_UP+P_DOWN ${fmt(combos[0]!.totalCost)} K_DOWN+P_UP ${fmt(combos[1]!.totalCost)}` +
      taken.map((t) => ` | TRADE #${t.id} ${t.combo} @${t.totalCost}¢ (event trade ${t.seq})`).join(""),
  );
}

async function loop() {
  for (;;) {
    const t0 = Date.now();
    try { await Promise.all([tick(), settleDue(t0)]); } catch (e) { console.error("[loop] error", e); }
    await Bun.sleep(Math.max(50, config.pollMs - (Date.now() - t0)));
  }
}
loop();
