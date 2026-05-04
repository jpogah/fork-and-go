// Dev-server lifecycle for the review-ui phase. The command and URL are
// read from HarnessConfig.devServer; we no longer assume `npm run dev` on
// port 3000.

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";

import type { HarnessConfig } from "@harness/config";

export interface DevServerHandle {
  child: ChildProcess;
  stop(): Promise<void>;
}

export async function startDevServer(opts: {
  config: HarnessConfig;
  cwd: string;
  logDir: string;
  log: (line: string) => void;
}): Promise<DevServerHandle> {
  const dev = opts.config.devServer;
  if (!dev) {
    throw new Error(
      "review-ui phase requires harness.config.devServer.command and url; neither is set.",
    );
  }
  const url = new URL(dev.url);
  const port = url.port || "3000";
  if (await isPortInUse(Number(port))) {
    throw new Error(
      `port ${port} is already in use. Free it or change devServer.url.`,
    );
  }

  mkdirSync(opts.logDir, { recursive: true });
  const logPath = path.join(opts.logDir, "dev-server.log");
  const logStream = createWriteStream(logPath, { flags: "a" });

  opts.log(`starting dev server: ${dev.command}`);
  // Use a shell so command strings like "npm run dev" or "pnpm start" work.
  const child = spawn(dev.command, [], {
    cwd: opts.cwd,
    env: { ...process.env, PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  child.stdout?.pipe(logStream);
  child.stderr?.pipe(logStream);

  const timeoutSec = dev.readyTimeoutSec ?? 60;
  const ready = await waitForUrl(dev.url, timeoutSec, child, logPath);
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error(
      `dev server did not respond at ${dev.url} within ${timeoutSec}s; see ${logPath}`,
    );
  }
  opts.log(`dev server ready at ${dev.url}`);

  return {
    child,
    async stop() {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
            resolve();
          }, 5_000);
          timer.unref();
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    },
  };
}

async function isPortInUse(port: number): Promise<boolean> {
  // Best-effort check via a TCP connect attempt.
  const net = await import("node:net");
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

async function waitForUrl(
  url: string,
  timeoutSec: number,
  child: ChildProcess,
  logPath: string,
): Promise<boolean> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `dev server exited before becoming ready (code ${child.exitCode}); see ${logPath}`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok || response.status < 500) return true;
    } catch {
      // not yet ready
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
