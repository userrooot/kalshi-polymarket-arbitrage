import { join, normalize } from "node:path";
import { config } from "./config.ts";
import { recentTrades } from "./simulator.ts";
import type { DashboardState } from "./types.ts";

let latest: DashboardState | null = null;
const PUBLIC = join(process.cwd(), "public");

let server: ReturnType<typeof startServer> | null = null;

/** Create a dashboard server. Pure: does not touch the module-level instance (used by tests). */
export function startServer(port: number, hostname: string) {
  return Bun.serve({
  port,
  hostname,
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
}

/** Start the app's dashboard on config.port / config.host (127.0.0.1 by default). Called by index.ts. */
export function startDashboard() {
  server = startServer(config.port, config.host);
  console.log(`[server] dashboard listening on ${server.hostname}:${server.port} (HOST=${config.host}; no auth, use an SSH tunnel for remote access)`);
  return server;
}

export function broadcast(s: DashboardState) {
  latest = s;
  server?.publish("state", JSON.stringify({ type: "state", ...s }));
}
