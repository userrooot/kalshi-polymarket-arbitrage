import { getAlerts } from "./alerts.ts";
import { config } from "./config.ts";
import { computeCombos } from "./arbitrage.ts";
import { allTrades, insertTrade, loadEvents, saveEvent, updateTrade } from "./db.ts";
import { execOnSettle, execOnTrade, execState } from "./exec/index.ts";
import { fetchKalshiResult } from "./kalshi.ts";
import { fetchPolyResult } from "./polymarket.ts";
import type { Combo, CostPoint, DashboardState, PnlPoint, Side, Stats, Trade, VenueSnapshot } from "./types.ts";

const trades: Trade[] = allTrades(); // restored from SQLite (OPEN trades keep settling after restart)
const tickers: Record<string, string> = loadEvents(); // eventKey -> Kalshi ticker
const lastTradeAt = new Map<string, number>();
// keep the per-event cooldown across restarts (otherwise a restart can trade again immediately)
for (const t of trades) if (t.openedAt > (lastTradeAt.get(t.eventKey) ?? 0)) lastTradeAt.set(t.eventKey, t.openedAt);
const lastSettlePoll = new Map<string, number>();
const gaveUp = new Set<string>();
let costHistory: CostPoint[] = [];
let costEvent: string | null = null;

const c = (n: number) => `${Math.round(n * 100) / 100}¢`;
const usd = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
const usdSigned = (n: number) => (n >= 0 ? "+" : "") + usd(n);
const cap = (s: Side) => (s === "UP" ? "UP" : "DOWN");
const px = (n: number | null) => (n === null ? "n/a" : "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 }));

export const eventTrades = (key: string) => trades.filter((t) => t.eventKey === key);

/** Take any tradable combos (cheapest first). Returns trades created. */
export function onTick(k: VenueSnapshot | null, p: VenueSnapshot | null, btc: number | null, now: number): { combos: Combo[]; taken: Trade[] } {
  const combos = computeCombos(k, p);
  const taken: Trade[] = [];
  const eventKey = k?.closeTime ?? null;

  if (eventKey && eventKey !== costEvent) { costEvent = eventKey; costHistory = []; }
  if (eventKey && (!costHistory.length || now - costHistory.at(-1)!.ts >= 1000))
    costHistory.push({ ts: now, costKUpPDown: combos[0]!.totalCost, costKDownPUp: combos[1]!.totalCost });
  if (costHistory.length > 1000) costHistory.shift();

  if (!k || !p || !eventKey) return { combos, taken };
  const closeMs = Date.parse(eventKey);
  if (Math.abs(Date.parse(p.closeTime) - closeMs) > 1000) return { combos, taken }; // venues disagree on the window
  if (closeMs - now < config.noTradeLastSec * 1000) return { combos, taken };
  saveEvent(eventKey, k.marketId); tickers[eventKey] = k.marketId;

  for (const combo of combos.filter((x) => x.tradable).sort((a, b) => a.totalCost! - b.totalCost!)) {
    const n = eventTrades(eventKey).length;
    if (n >= config.maxTradesPerEvent) break;
    if (now - (lastTradeAt.get(eventKey) ?? 0) < config.tradeCooldownMs) break;
    const kp = combo.kalshiAsk!, pp = combo.polyAsk!, cost = combo.totalCost!, N = config.contractsPerTrade;
    const t = insertTrade({
      eventKey, seq: n + 1, openedAt: now, combo: combo.id,
      kalshiSide: combo.kalshiSide, polySide: combo.polySide,
      kalshiPrice: kp, polyPrice: pp, totalCost: cost, contracts: N,
      stakeUsd: Math.round(cost * N) / 100,
      kalshiStrike: k.strike, polyStrike: p.strike, btcAtEntry: btc,
      entryReason:
        `Kalshi ${cap(combo.kalshiSide)} @${c(kp)} + Polymarket ${cap(combo.polySide)} @${c(pp)} = ${c(cost)} < ${c(config.maxTotalCost)}; ` +
        `guaranteed payout of at least $1.00 per pair if exactly one leg wins => +${c(100 - cost)}/contract (+${(((100 - cost) / cost) * 100).toFixed(0)}%). ` +
        `Strikes: Kalshi ${px(k.strike)}, Polymarket ${px(p.strike)}; BTC ${px(btc)}.`,
      status: "OPEN",
    });
    trades.push(t); taken.push(t);
    execOnTrade(t, combo, k, p, now); // realistic-execution sim (async; may later adjust this trade per EXEC_PRIMARY)
    lastTradeAt.set(eventKey, now);
  }
  return { combos, taken };
}

function explain(t: Trade, kr: Side, pr: Side, kWon: boolean, pWon: boolean, payout: number, pnl: number, extra: string): string {
  const N = t.contracts, edge = 100 - t.totalCost;
  const head = `Kalshi resolved ${kr} (our leg: ${t.kalshiSide} -> ${kWon ? "WON" : "LOST"}), Polymarket resolved ${pr} (our leg: ${t.polySide} -> ${pWon ? "WON" : "LOST"}). `;
  const money = `Payout ${usd(payout)} vs stake ${usd(t.stakeUsd)} => P&L ${usdSigned(pnl)}. `;
  if (kWon && pWon)
    return head + money + `BOTH legs won: the two venues' strikes differ (Kalshi ${px(t.kalshiStrike)}, Polymarket ${px(t.polyStrike)}) and the final BTC price landed between them, so each leg paid $1 x ${N} = $${N}, $${2 * N} in total: profit of ${c(200 - t.totalCost)}/contract instead of the normal ${c(edge)} edge. ` + extra;
  if (!kWon && !pWon)
    return head + money + `BOTH legs lost: total loss of the stake. This happens when the venues settle on opposite sides of our hedge because their strikes and resolution sources differ (Kalshi uses CF Benchmarks BRTI, Polymarket uses Chainlink; strikes Kalshi ${px(t.kalshiStrike)} vs Polymarket ${px(t.polyStrike)}), so the final price fell in the gap and neither of our legs paid. ` + extra;
  return head + money + `Exactly one leg won, so the hedge paid $1 x ${N} = $${N} against a cost of ${c(t.totalCost)}/contract: locked profit of ${c(edge)}/contract (${usd((edge * N) / 100)}). ` + extra;
}

async function settleEvent(eventKey: string, open: Trade[], now: number) {
  const ticker = tickers[eventKey];
  if (!ticker) return;
  const [k, p] = await Promise.all([fetchKalshiResult(ticker).catch(() => null), fetchPolyResult(eventKey).catch(() => null)]);
  if (!k?.result || !p?.result) {
    if (now - Date.parse(eventKey) > config.settleGiveUpMs) {
      gaveUp.add(eventKey);
      for (const t of open) { t.outcomeReason = `UNRESOLVED: gave up after 30 min (Kalshi result: ${k?.result ?? "pending"}, Polymarket result: ${p?.result ?? "pending"}). Needs manual review.`; updateTrade(t); }
      console.log(`[settle] ${eventKey} GAVE UP (kalshi=${k?.result ?? "?"} poly=${p?.result ?? "?"})`);
    }
    return;
  }
  const extra = `Kalshi expiration value: ${px(k.expirationValue)}${p.finalPrice ? `; Polymarket final price: ${px(p.finalPrice)}` : ""}.`;
  for (const t of open) {
    const kWon = t.kalshiSide === k.result, pWon = t.polySide === p.result;
    // EXEC_PRIMARY != NAIVE: only the legs that the execution sim filled (and kept) settle; unwound legs already booked their PnL
    const hasLegs = t.kalshiQty !== undefined && t.polyQty !== undefined;
    const payout = hasLegs ? (kWon ? t.kalshiQty! : 0) + (pWon ? t.polyQty! : 0) : ((kWon ? 1 : 0) + (pWon ? 1 : 0)) * t.contracts;
    Object.assign(t, {
      status: "SETTLED", settledAt: now, kalshiResult: k.result, polyResult: p.result,
      kalshiLegWon: kWon, polyLegWon: pWon, payoutUsd: payout,
      pnlUsd: Math.round((payout - t.stakeUsd + (t.realizedUsd ?? 0)) * 100) / 100,
      btcAtSettle: k.expirationValue ?? p.finalPrice,
      kalshiStrike: t.kalshiStrike ?? k.strike, polyStrike: t.polyStrike ?? p.strike,
    } satisfies Partial<Trade>);
    t.outcomeReason = hasLegs
      ? `Execution sim (${t.execStrategy}): held Kalshi ${t.kalshiQty} + Polymarket ${t.polyQty}. Kalshi resolved ${k.result} (${kWon ? "WON" : "LOST"}), Polymarket resolved ${p.result} (${pWon ? "WON" : "LOST"}). Payout ${usd(payout)} vs stake ${usd(t.stakeUsd)}${t.realizedUsd ? ` + realised unwind ${usdSigned(t.realizedUsd)}` : ""} => P&L ${usdSigned(t.pnlUsd!)}. ` + extra
      : explain(t, k.result, p.result, kWon, pWon, payout, t.pnlUsd!, extra);
    execOnSettle(t, kWon, pWon);
    updateTrade(t);
    console.log(`[settle] #${t.id} ${t.combo} K=${k.result} P=${p.result} pnl ${usdSigned(t.pnlUsd!)}`);
  }
}

/** Poll real results (~10s) for ended events that still have OPEN trades. Never throws. */
export async function settleDue(now = Date.now()) {
  const byEvent = new Map<string, Trade[]>();
  for (const t of trades) if (t.status === "OPEN" && Date.parse(t.eventKey) <= now && !gaveUp.has(t.eventKey)) (byEvent.get(t.eventKey) ?? byEvent.set(t.eventKey, []).get(t.eventKey)!).push(t);
  await Promise.all([...byEvent].map(async ([key, open]) => {
    if (now - (lastSettlePoll.get(key) ?? 0) < config.settlePollMs) return;
    lastSettlePoll.set(key, now);
    try { await settleEvent(key, open, now); } catch (e) { console.error("[settle] error", e); }
  }));
}

export function stats(): Stats {
  const s = trades.filter((t) => t.status === "SETTLED");
  const wins = s.filter((t) => t.pnlUsd! > 0).length;
  return {
    totalTrades: trades.length, openTrades: trades.length - s.length, settledTrades: s.length,
    wins, losses: s.filter((t) => t.pnlUsd! < 0).length,
    winRate: s.length ? (wins / s.length) * 100 : 0,
    totalPnlUsd: Math.round(s.reduce((a, t) => a + t.pnlUsd!, 0) * 100) / 100,
    totalStakeUsd: Math.round(trades.reduce((a, t) => a + t.stakeUsd, 0) * 100) / 100,
  };
}

export const recentTrades = (limit = 100) => trades.slice(-limit).reverse();

export function pnlHistory(): PnlPoint[] {
  let cum = 0;
  return trades.filter((t) => t.status === "SETTLED").sort((a, b) => a.settledAt! - b.settledAt!)
    .map((t) => ({ ts: t.settledAt!, cumPnlUsd: Math.round((cum += t.pnlUsd!) * 100) / 100, tradeId: t.id }));
}

export function buildState(now: number, btc: number | null, k: VenueSnapshot | null, p: VenueSnapshot | null, combos: Combo[], extra: Pick<DashboardState, "feeds" | "tickRate">): DashboardState {
  const eventKey = k?.closeTime ?? null;
  return {
    now, maxTotalCost: config.maxTotalCost, maxTradesPerEvent: config.maxTradesPerEvent, contractsPerTrade: config.contractsPerTrade,
    btcPrice: btc, alerts: getAlerts(), ...extra, kalshi: k, polymarket: p, combos, eventKey,
    tradesThisEvent: eventKey ? eventTrades(eventKey).length : 0,
    exec: execState(), stats: stats(), costHistory, pnlHistory: pnlHistory(), recentTrades: recentTrades(100),
  };
}
