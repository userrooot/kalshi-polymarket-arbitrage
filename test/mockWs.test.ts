// Integration: mock Kalshi + mock Polymarket live-data websockets on localhost (no real keys/servers involved).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { constants, generateKeyPairSync, verify } from "node:crypto";
import { kalshiTop, kalshiWatch, startKalshiBook } from "../src/feeds/kalshiBook.ts";
import { cfAvg60, cfSpot } from "../src/feeds/kalshiIndex.ts";
import { feedStats } from "../src/feeds/meter.ts";
import { polyLiveStart, twapAvg60, twapSpot } from "../src/feeds/polyLive.ts";

const TK = "KXBTC15M-TEST";
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const until = async (f: () => boolean, ms = 4000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("timeout"); await Bun.sleep(10); } };

interface KConn { headers: Record<string, string>; sigOk: boolean; cmds: any[]; ws: any }
const kconns: KConn[] = [];
const pmsgs: any[] = [];
let pws: any = null, polyAuthOk = false;
let server: ReturnType<typeof Bun.serve>;
let dropSeq = false;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      const headers = Object.fromEntries([...req.headers].map(([k, v]) => [k.toUpperCase(), v]));
      return srv.upgrade(req, { data: { path: url.pathname, headers } }) ? undefined : new Response("no", { status: 400 });
    },
    websocket: {
      open(ws: any) {
        if (ws.data.path === "/trade-api/ws/v2") {
          const h = ws.data.headers;
          const ok = verify("sha256", Buffer.from(h["KALSHI-ACCESS-TIMESTAMP"] + "GET" + "/trade-api/ws/v2"),
            { key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
            Buffer.from(h["KALSHI-ACCESS-SIGNATURE"] ?? "", "base64"));
          ws.data.conn = { headers: h, sigOk: ok, cmds: [], ws } as KConn;
          kconns.push(ws.data.conn);
        } else pws = ws;
      },
      message(ws: any, raw: any) {
        const j = JSON.parse(String(raw));
        if (ws.data.path === "/trade-api/ws/v2") {
          const c: KConn = ws.data.conn; c.cmds.push(j);
          const s = (o: object) => ws.send(JSON.stringify(o));
          if (j.cmd === "subscribe" && j.params.channels[0] === "orderbook_delta") {
            s({ type: "subscribed", id: j.id, msg: { channel: "orderbook_delta", sid: 7 } });
            s({ type: "orderbook_snapshot", sid: 7, seq: 1, sending_ts_ms: Date.now() - 20,
              msg: { market_ticker: j.params.market_tickers[0], clock: 1, yes_dollars_fp: [["0.4000", "100.00"]], no_dollars_fp: [["0.5500", "50.00"]] } });
          } else if (j.cmd === "subscribe") {
            s({ type: "subscribed", id: j.id, msg: { channel: "cfbenchmarks_value_5hz", sid: 8 } });
            s({ type: "cfbenchmarks_value_5hz", sid: 8, seq: 1, msg: { index_id: "BRTI", value_usd: "68000.50", source_ts_ms: Date.now(), received_at: Date.now() } });
          } else if (j.cmd === "update_subscription" && j.params.action === "get_snapshot") {
            s({ type: "orderbook_snapshot", sid: 7, seq: 50, sending_ts_ms: Date.now(),
              msg: { market_ticker: j.params.market_tickers[0], clock: 2, yes_dollars_fp: [["0.3000", "10.00"]], no_dollars_fp: [["0.6000", "10.00"]] } });
          }
        } else {
          pmsgs.push(j);
          if (j.op === "auth") {
            polyAuthOk = j.auth?.apiKey === "pk" && j.auth?.secret === "ps" && j.auth?.passphrase === "pp";
            ws.send(JSON.stringify(polyAuthOk ? { op: "authed", rid: j.rid } : { op: "error", code: "auth_invalid" }));
          } else if (j.op === "subscribe") {
            const now = Date.now();
            ws.send(JSON.stringify({ snapshot: true, channel: "price.crypto.twap", payload: { data: [{ timestamp: now - 2000, value: 67990 }, { timestamp: now - 1000, value: 68000 }] } }));
            ws.send(JSON.stringify({ v: 1, channel: "price.crypto.twap", seq: 1, ts: now, payload: { symbol: "btcusd", value: 68010.25, timestamp: now, source: "chainlink", window_seconds: 60 } }));
          } else if (j.op === "ping") ws.send(JSON.stringify({ op: "pong" }));
        }
      },
    },
  });
});
afterAll(() => { server.stop(true); });

describe("mock Kalshi", () => {
  test("signed handshake, subscribe, snapshot -> kalshiTop (ws), cfbenchmarks -> spot", async () => {
    kalshiWatch(TK);
    startKalshiBook({ url: `ws://127.0.0.1:${server.port}/trade-api/ws/v2`, keyId: "key-123", privateKey: rsa.privateKey });
    await until(() => kalshiTop(TK)?.src === "ws");
    const c = kconns[0]!;
    expect(c.headers["KALSHI-ACCESS-KEY"]).toBe("key-123");
    expect(c.sigOk).toBe(true);
    expect(Math.abs(Date.now() - Number(c.headers["KALSHI-ACCESS-TIMESTAMP"]))).toBeLessThan(5000);
    const sub = c.cmds.find((x) => x.params?.channels?.[0] === "orderbook_delta");
    expect(sub).toMatchObject({ cmd: "subscribe", params: { channels: ["orderbook_delta"], market_tickers: [TK], use_yes_price: true } });
    expect(sub.id).toBeGreaterThanOrEqual(1);
    const t = kalshiTop(TK)!;
    expect(t.yesBid).toBe(40); expect(t.noBid).toBe(45); expect(t.src).toBe("ws");
    await until(() => cfSpot() !== null);
    expect(cfSpot()).toMatchObject({ price: 68000.5, source: "cfbenchmarks" });
    expect(cfAvg60()).toBeCloseTo(68000.5);
    const st = feedStats().find((f) => f.name === "kalshiBook(ws)")!;
    expect(st.connected).toBe(true); expect(st.updatesPerSec).toBeGreaterThan(0); expect(st.latencyMs).not.toBeNull();
  });

  test("deltas flow into the top", async () => {
    const c = kconns[0]!;
    c.ws.send(JSON.stringify({ type: "orderbook_delta", sid: 7, seq: 2, sending_ts_ms: Date.now(), msg: { market_ticker: TK, clock: 2, price_dollars: "0.4200", delta_fp: "5.00", side: "yes" } }));
    await until(() => kalshiTop(TK)?.yesBid === 42);
  });

  test("seq gap -> book dropped, get_snapshot requested, fresh snapshot applied", async () => {
    const c = kconns[0]!;
    c.ws.send(JSON.stringify({ type: "orderbook_delta", sid: 7, seq: 9, sending_ts_ms: Date.now(), msg: { market_ticker: TK, clock: 3, price_dollars: "0.9000", delta_fp: "5.00", side: "yes" } }));
    await until(() => c.cmds.some((x) => x.params?.action === "get_snapshot"));
    await until(() => kalshiTop(TK)?.yesBid === 30);
    expect(kalshiTop(TK)!.noBid).toBe(40);
  });

  test("rollover: add_markets for the new ticker, delete_markets for the old", async () => {
    const c = kconns[0]!;
    kalshiWatch("KXBTC15M-NEXT");
    await until(() => c.cmds.some((x) => x.params?.action === "add_markets"));
    const add = c.cmds.find((x) => x.params?.action === "add_markets");
    expect(add).toMatchObject({ cmd: "update_subscription", params: { sid: 7, market_tickers: ["KXBTC15M-NEXT"] } });
    await until(() => c.cmds.some((x) => x.params?.action === "delete_markets"));
    kalshiWatch(TK); // back for the reconnect test
  });

  test("forced close -> reconnect with FRESH signed headers and re-subscribe", async () => {
    const before = kconns.length, ts0 = kconns[0]!.headers["KALSHI-ACCESS-TIMESTAMP"];
    kconns[0]!.ws.close();
    await until(() => kconns.length > before, 6000);
    const c = kconns.at(-1)!;
    expect(c.sigOk).toBe(true);
    expect(c.headers["KALSHI-ACCESS-TIMESTAMP"]).not.toBe(ts0);
    await until(() => c.cmds.some((x) => x.params?.channels?.[0] === "orderbook_delta"));
    await until(() => kalshiTop(TK)?.yesBid === 40 && kalshiTop(TK)?.src === "ws");
  });
});

describe("mock Polymarket live-data v2", () => {
  test("auth -> authed -> subscribe -> snapshot + twap flow into spot", async () => {
    polyLiveStart({ url: `ws://127.0.0.1:${server.port}/ws`, apiKey: "pk", secret: "ps", passphrase: "pp" });
    await until(() => twapSpot() !== null);
    expect(polyAuthOk).toBe(true);
    expect(pmsgs[0]).toEqual({ op: "auth", rid: "a1", auth: { apiKey: "pk", secret: "ps", passphrase: "pp" } });
    const sub = pmsgs.find((m) => m.op === "subscribe");
    expect(sub.subscriptions).toEqual([
      { channel: "price.crypto.twap", filter: { symbol: "btcusd", window_seconds: 60 } },
      { channel: "price.crypto", filter: { symbol: "btcusd" } },
    ]);
    expect(twapSpot()).toMatchObject({ price: 68010.25, source: "chainlink-twap" });
    expect(twapAvg60()).toBe(68010.25);
    expect(feedStats().find((f) => f.name === "polyLive")!.latencyMs).not.toBeNull();
  });
});
