import { config } from "./config.ts";
import type { Combo, VenueSnapshot } from "./types.ts";

const mk = (id: Combo["id"], kalshiSide: Combo["kalshiSide"], polySide: Combo["polySide"], k: number | null, p: number | null, fresh = true): Combo => {
  const totalCost = k !== null && p !== null ? Math.round((k + p) * 100) / 100 : null;
  return {
    id, kalshiSide, polySide, kalshiAsk: k, polyAsk: p, totalCost,
    profitIfOneWins: totalCost === null ? null : Math.round((100 - totalCost) * 100) / 100,
    tradable: fresh && totalCost !== null && totalCost < config.maxTotalCost,
  };
};

export function computeCombos(k: VenueSnapshot | null, p: VenueSnapshot | null): Combo[] {
  // never trade on a quote older than MAX_QUOTE_AGE_MS (unknown age = not fresh)
  const ok = (v: VenueSnapshot | null) => v?.quoteAgeMs != null && v.quoteAgeMs <= config.maxQuoteAgeMs;
  const fresh = ok(k) && ok(p);
  return [
    mk("K_UP+P_DOWN", "UP", "DOWN", k?.upAsk ?? null, p?.downAsk ?? null, fresh),
    mk("K_DOWN+P_UP", "DOWN", "UP", k?.downAsk ?? null, p?.upAsk ?? null, fresh),
  ];
}
