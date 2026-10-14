import { afterEach, describe, expect, it } from "vitest";
import { newSessionId } from "shared";
import { WS_CLOSE_TRY_LATER } from "../src/hub";
import { FakeBrowser, sleep, startServer } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
afterEach(async () => srv?.app.close());

const closed = async (b: FakeBrowser) => {
  for (let i = 0; i < 50 && b.closeCode === undefined; i++) await sleep(10);
  return b.closeCode;
};

describe("connection limits", () => {
  it("caps connections per client IP (Cloudflare header)", async () => {
    srv = await startServer({ limits: { maxConnectionsPerIp: 2 } });
    const ip = { "cf-connecting-ip": "203.0.113.7" };
    const a = new FakeBrowser(`${srv.ws}/ws/${newSessionId()}`, ip);
    const b = new FakeBrowser(`${srv.ws}/ws/${newSessionId()}`, ip);
    await a.open(null);
    await b.open(null);
    const c = new FakeBrowser(`${srv.ws}/ws/${newSessionId()}`, ip);
    expect(await closed(c)).toBe(WS_CLOSE_TRY_LATER);
    // Another IP is unaffected
    const d = new FakeBrowser(`${srv.ws}/ws/${newSessionId()}`, { "cf-connecting-ip": "203.0.113.8" });
    await d.open(null);
    // Closing one frees a slot
    a.close();
    await sleep(50);
    const e = new FakeBrowser(`${srv.ws}/ws/${newSessionId()}`, ip);
    await e.open(null);
    for (const x of [b, d, e]) x.close();
  });

  it("replacing a tab for the same workspace does not count twice", async () => {
    srv = await startServer({ limits: { maxConnectionsPerIp: 1 } });
    const id = newSessionId();
    const a = new FakeBrowser(`${srv.ws}/ws/${id}`);
    await a.open(null);
    const b = new FakeBrowser(`${srv.ws}/ws/${id}`);
    await b.open(null);
    await a.waitFor("superseded");
    b.close();
  });

  it("caps total connections", async () => {
    srv = await startServer({ limits: { maxConnections: 1 } });
    const a = new FakeBrowser(`${srv.ws}/ws/${newSessionId()}`, { "cf-connecting-ip": "1.1.1.1" });
    await a.open(null);
    const b = new FakeBrowser(`${srv.ws}/ws/${newSessionId()}`, { "cf-connecting-ip": "2.2.2.2" });
    expect(await closed(b)).toBe(WS_CLOSE_TRY_LATER);
    a.close();
  });
});

describe("rate limits", () => {
  it("limits MCP requests per client IP", async () => {
    srv = await startServer({ limits: { mcpPerMinute: 3 } });
    const post = (ip: string) =>
      fetch(`${srv.base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": ip },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }).then((r) => r.status);
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push(await post("198.51.100.1"));
    // Unauthenticated requests count too
    expect(codes).toEqual([401, 401, 401, 429]);
    expect(await post("198.51.100.2")).toBe(401);
  });

  it("limits socket opens per client IP", async () => {
    srv = await startServer({ limits: { wsPerMinute: 2 } });
    const ip = { "cf-connecting-ip": "198.51.100.9" };
    const a = new FakeBrowser(`${srv.ws}/ws/${newSessionId()}`, ip);
    const b = new FakeBrowser(`${srv.ws}/ws/${newSessionId()}`, ip);
    await a.open(null);
    await b.open(null);
    const c = new FakeBrowser(`${srv.ws}/ws/${newSessionId()}`, ip);
    await expect(c.opened).rejects.toThrow(/429/);
    a.close();
    b.close();
  });
});
