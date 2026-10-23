import { chainlinkAt } from "./feeds/chainlink.ts";

// No spot price lives here any more (no exchange/REST prices). Only the Polymarket strike helper remains.
const windowStart = new Map<number, number>(); // window start (unix s) -> price near start (not populated: no REST source)

/** Strike fallback: Chainlink history at the window start. */
export const btcAtWindowStart = (startSec: number) => chainlinkAt(startSec) ?? windowStart.get(startSec) ?? null;
