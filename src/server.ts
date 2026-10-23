import { join, normalize } from "node:path";
import { config } from "./config.ts";
import { recentTrades } from "./simulator.ts";
import type { DashboardState } from "./types.ts";

let latest: DashboardState | null = null;
const PUBLIC = join(process.cwd(), "public");

export const server = Bun.serve({
  port: config.port,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    if (url.pathname === "/api/state") return Response.json(latest ?? { error: "warming up" }, { status: latest ? 200 : 503 });
    if (url.pathname === "/api/trades") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 200, 1), 5000);
      return Response.json(recentTrades(limit));
    }
    const rel = normalize(url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname));
    if (rel.includes("..")) return new Response("forbidden", { status: 403 });
    const f = Bun.file(join(PUBLIC, rel));
    return (await f.exists()) ? new Response(f) : new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) { ws.subscribe("state"); if (latest) ws.send(JSON.stringify({ type: "state", ...latest })); },
    message() {},
  },
});

export function broadcast(s: DashboardState) {
  latest = s;
  server.publish("state", JSON.stringify({ type: "state", ...s }));
}
