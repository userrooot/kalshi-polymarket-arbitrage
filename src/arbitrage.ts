import { config } from "./config.ts";
import type { Combo, VenueSnapshot } from "./types.ts";

const mk = (id: Combo["id"], kalshiSide: Combo["kalshiSide"], polySide: Combo["polySide"], k: number | null, p: number | null): Combo => {
  const totalCost = k !== null && p !== null ? Math.round((k + p) * 100) / 100 : null;
  return {
    id, kalshiSide, polySide, kalshiAsk: k, polyAsk: p, totalCost,
    profitIfOneWins: totalCost === null ? null : Math.round((100 - totalCost) * 100) / 100,
    tradable: totalCost !== null && totalCost < config.maxTotalCost,
  };
};

export function computeCombos(k: VenueSnapshot | null, p: VenueSnapshot | null): Combo[] {
  return [
    mk("K_UP+P_DOWN", "UP", "DOWN", k?.upAsk ?? null, p?.downAsk ?? null),
    mk("K_DOWN+P_UP", "DOWN", "UP", k?.downAsk ?? null, p?.upAsk ?? null),
  ];
}
