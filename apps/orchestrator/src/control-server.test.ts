import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createControlServer,
  isLoopbackAddress,
  type ControlDaemon,
  type ControlServer,
} from "./control-server.ts";

interface FakeDaemon extends ControlDaemon {
  readonly calls: {
    pauses: number;
    resumes: number;
    stops: number;
    unblocks: string[];
    freezes: Array<string | undefined>;
    unfreezes: number;
  };
  state: Record<string, unknown>;
  stopResolver: (() => void) | null;
}

function makeDaemon(): FakeDaemon {
  const calls = {
    pauses: 0,
    resumes: 0,
    stops: 0,
    unblocks: [] as string[],
    freezes: [] as Array<string | undefined>,
    unfreezes: 0,
  };
  const daemon: FakeDaemon = {
    calls,
    state: { state: "paused", history: [] },
    stopResolver: null,
    getSnapshot() {
      return this.state;
    },
    pause() {
      calls.pauses += 1;
      this.state = { ...this.state, state: "paused" };
    },
    resume() {
      calls.resumes += 1;
      this.state = { ...this.state, state: "running" };
    },
    async stop() {
      calls.stops += 1;
      await new Promise<void>((resolve) => {
        this.stopResolver = resolve;
      });
    },
    unblock(planId) {
      calls.unblocks.push(planId);
      if (planId === "0042") return { ok: true };
      return { ok: false, reason: "not blocked" };
    },
    freeze(reason) {
      calls.freezes.push(reason);
      return { ok: true };
    },
    unfreeze() {
      calls.unfreezes += 1;
      return { ok: true };
    },
  };
  return daemon;
}

describe("control server", () => {
  let logsDir: string;
  let daemon: FakeDaemon;
  let server: ControlServer;
  let baseUrl: string;

  beforeEach(async () => {
    logsDir = mkdtempSync(path.join(tmpdir(), "orchestrator-logs-"));
    mkdirSync(logsDir, { recursive: true });
    daemon = makeDaemon();
    server = createControlServer({ daemon, port: 0, logsDir });
    const addr = await server.listen();
    baseUrl = `http://${addr.host === "::" ? "127.0.0.1" : addr.host}:${addr.port}`;
  });

  afterEach(async () => {
    await server.close();
  });

  it("GET /status returns the daemon snapshot", async () => {
    const res = await fetch(`${baseUrl}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe("paused");
  });

  it("POST /pause flips the state and bumps the counter", async () => {
    const res = await fetch(`${baseUrl}/pause`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(daemon.calls.pauses).toBe(1);
    expect(daemon.state.state).toBe("paused");
  });

  it("POST /resume calls daemon.resume", async () => {
    const res = await fetch(`${baseUrl}/resume`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(daemon.calls.resumes).toBe(1);
  });

  it("POST /stop returns 202 and schedules stop", async () => {
    const res = await fetch(`${baseUrl}/stop`, { method: "POST" });
    expect(res.status).toBe(202);
    // The fake stop hangs until resolved; give the microtask a chance to run.
    await new Promise((r) => setTimeout(r, 5));
    expect(daemon.calls.stops).toBe(1);
    daemon.stopResolver?.();
  });

  it("POST /freeze calls daemon.freeze and surfaces the reason from the query string", async () => {
    const res = await fetch(`${baseUrl}/freeze?reason=budget+exhausted`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; frozen: boolean };
    expect(body.ok).toBe(true);
    expect(body.frozen).toBe(true);
    expect(daemon.calls.freezes).toEqual(["budget exhausted"]);
  });

  it("POST /freeze without a reason still calls daemon.freeze", async () => {
    const res = await fetch(`${baseUrl}/freeze`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(daemon.calls.freezes).toEqual([undefined]);
  });

  it("POST /unfreeze calls daemon.unfreeze", async () => {
    const res = await fetch(`${baseUrl}/unfreeze`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; frozen: boolean };
    expect(body.ok).toBe(true);
    expect(body.frozen).toBe(false);
    expect(daemon.calls.unfreezes).toBe(1);
  });

  it("POST /unblock/:id returns 200 on success, 404 otherwise", async () => {
    const okRes = await fetch(`${baseUrl}/unblock/0042`, { method: "POST" });
    expect(okRes.status).toBe(200);
    const missRes = await fetch(`${baseUrl}/unblock/0099`, { method: "POST" });
    expect(missRes.status).toBe(404);
  });

  it("GET /logs/:id streams the most recent matching log", async () => {
    writeFileSync(path.join(logsDir, "0050-old.log"), "older\n");
    // Make sure the second file's mtime is distinctly newer.
    await new Promise((r) => setTimeout(r, 10));
    writeFileSync(path.join(logsDir, "0050-new.log"), "newest log line\n");
    const res = await fetch(`${baseUrl}/logs/0050`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("newest log line");
  });

  it("GET /logs/:id returns 404 when no logs match", async () => {
    const res = await fetch(`${baseUrl}/logs/9999`);
    expect(res.status).toBe(404);
  });

  it("unknown path returns 404", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("rejects requests whose remote address is not loopback with 403", async () => {
    // Patch each incoming socket so the server observes a non-loopback
    // remote address. Our listener runs after the http server's built-in
    // connection handler, but before any request handler reads
    // socket.remoteAddress, so isLoopback() sees the override.
    server.server.on("connection", (sock) => {
      Object.defineProperty(sock, "remoteAddress", {
        value: "203.0.113.1",
        configurable: true,
      });
    });
    const res = await fetch(`${baseUrl}/status`);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("loopback-only");
    // The daemon must not have seen the request.
    expect(daemon.calls.pauses).toBe(0);
    expect(daemon.calls.resumes).toBe(0);
  });
});

describe("isLoopbackAddress", () => {
  it("accepts the canonical loopback addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("rejects public and private non-loopback addresses", () => {
    expect(isLoopbackAddress("203.0.113.1")).toBe(false);
    expect(isLoopbackAddress("10.0.0.1")).toBe(false);
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
  });

  it("rejects missing remote addresses", () => {
    expect(isLoopbackAddress(undefined)).toBe(false);
    expect(isLoopbackAddress(null)).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });
});
