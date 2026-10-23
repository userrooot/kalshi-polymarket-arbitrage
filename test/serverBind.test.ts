import { afterAll, describe, expect, test } from "bun:test";
import { startServer } from "../src/server.ts";

// Importing server.ts must not start a server (it used to bind config.port, i.e. 3000, at import time,
// which collided with a running bot). Every server here uses port 0 (ephemeral) and is stopped.
const opened: Array<{ stop(force?: boolean): unknown }> = [];
afterAll(() => { for (const s of opened) s.stop(true); });

describe("dashboard bind address", () => {
  test("HOST defaults to 127.0.0.1", async () => {
    const saved = process.env.HOST;
    delete process.env.HOST; // bun test loads .env; make the default observable
    try {
      // query string => fresh module instance, independent of config already cached by other test files
      const { config } = await import(`../src/config.ts?serverBind=${Date.now()}`);
      expect(config.host).toBe("127.0.0.1");
    } finally {
      if (saved !== undefined) process.env.HOST = saved;
    }
  });
  test("serves on loopback with a random port", async () => {
    const s = startServer(0, "127.0.0.1"); opened.push(s);
    expect(s.hostname).toBe("127.0.0.1");
    expect(s.port).toBeGreaterThan(0);
    const r = await fetch(`http://127.0.0.1:${s.port}/api/state`);
    expect([200, 503]).toContain(r.status);
  });
  test("explicit hostname override is honoured", () => {
    const s = startServer(0, "0.0.0.0"); opened.push(s);
    expect(s.hostname).toBe("0.0.0.0");
  });
});
