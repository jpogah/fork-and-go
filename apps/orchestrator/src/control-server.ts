// Local HTTP control endpoint for the orchestrator. Listens on 127.0.0.1
// only (loopback-only; the plan explicitly defers auth + remote control).
// Exposes the operator routes the plans lock: GET /status, POST /pause,
// POST /resume, POST /stop, POST /unblock/:planId, GET /logs/:planId, and
// (plan 0052) POST /freeze, POST /unfreeze.

import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";

export interface ControlDaemon {
  getSnapshot(): unknown;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
  unblock(planId: string): { ok: boolean; reason?: string };
  freeze(reason?: string): { ok: boolean };
  unfreeze(): { ok: boolean };
}

export interface ControlServerOptions {
  daemon: ControlDaemon;
  host?: string;
  port: number;
  logsDir: string;
}

export interface ControlServer {
  listen(): Promise<{ host: string; port: number }>;
  close(): Promise<void>;
  address(): { host: string; port: number } | null;
  // Exposed so tests can attach a `connection` listener and fake
  // `socket.remoteAddress` to exercise the non-loopback rejection branch.
  server: Server;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(remote: string | null | undefined): boolean {
  if (!remote) return false;
  return LOOPBACK_HOSTS.has(remote);
}

export function createControlServer(opts: ControlServerOptions): ControlServer {
  const host = opts.host ?? "127.0.0.1";
  const server: Server = createServer((req, res) => {
    void handleRequest(req, res, opts).catch((err) => {
      sendJson(res, 500, {
        error: "internal",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  return {
    async listen() {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = (): void => {
          server.removeListener("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(opts.port, host);
      });
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("control server failed to bind to an address");
      }
      return { host: addr.address, port: addr.port };
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    address() {
      const addr = server.address();
      if (addr === null || typeof addr === "string") return null;
      return { host: addr.address, port: addr.port };
    },
    server,
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ControlServerOptions,
): Promise<void> {
  if (!isLoopback(req)) {
    sendJson(res, 403, { error: "loopback-only" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/status") {
    sendJson(res, 200, opts.daemon.getSnapshot());
    return;
  }
  if (method === "POST" && url.pathname === "/pause") {
    opts.daemon.pause();
    sendJson(res, 200, { ok: true, state: "paused" });
    return;
  }
  if (method === "POST" && url.pathname === "/resume") {
    opts.daemon.resume();
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method === "POST" && url.pathname === "/stop") {
    sendJson(res, 202, { ok: true, state: "stopping" });
    // Fire-and-forget: let the HTTP response flush before the daemon's
    // stop resolves. The daemon completes the current plan before exiting.
    queueMicrotask(() => {
      void opts.daemon.stop();
    });
    return;
  }
  if (method === "POST" && url.pathname.startsWith("/unblock/")) {
    const planId = decodeURIComponent(url.pathname.slice("/unblock/".length));
    const result = opts.daemon.unblock(planId);
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }
  if (method === "POST" && url.pathname === "/freeze") {
    const reason = url.searchParams.get("reason") ?? undefined;
    const result = opts.daemon.freeze(reason);
    sendJson(res, 200, { ...result, frozen: true });
    return;
  }
  if (method === "POST" && url.pathname === "/unfreeze") {
    const result = opts.daemon.unfreeze();
    sendJson(res, 200, { ...result, frozen: false });
    return;
  }
  if (method === "GET" && url.pathname.startsWith("/logs/")) {
    const planId = decodeURIComponent(url.pathname.slice("/logs/".length));
    await serveLog(res, opts.logsDir, planId);
    return;
  }

  sendJson(res, 404, { error: "not-found", path: url.pathname });
}

function isLoopback(req: IncomingMessage): boolean {
  return isLoopbackAddress(req.socket.remoteAddress);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", Buffer.byteLength(payload).toString());
  res.end(payload);
}

async function serveLog(
  res: ServerResponse,
  logsDir: string,
  planId: string,
): Promise<void> {
  const file = pickLatestLog(logsDir, planId);
  if (!file) {
    sendJson(res, 404, { error: "no-log", planId });
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(res);
  });
}

function pickLatestLog(logsDir: string, planId: string): string | null {
  if (!existsSync(logsDir)) return null;
  const entries = readdirSync(logsDir, { withFileTypes: true });
  const matches = entries
    .filter((e) => e.isFile() && e.name.startsWith(`${planId}-`))
    .map((e) => {
      const full = path.join(logsDir, e.name);
      return { full, mtime: statSync(full).mtimeMs };
    });
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0]!.full;
}
