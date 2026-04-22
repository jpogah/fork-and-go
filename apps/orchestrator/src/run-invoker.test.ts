import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createRunInvoker } from "./run-invoker.ts";

function setup(): { root: string; logsDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), "orchestrator-invoker-"));
  const logsDir = path.join(root, "logs");
  mkdirSync(logsDir, { recursive: true });
  return { root, logsDir };
}

function writeScript(root: string, name: string, body: string): string {
  const file = path.join(root, name);
  writeFileSync(file, body, "utf8");
  chmodSync(file, 0o755);
  return file;
}

describe("run invoker", () => {
  it("captures stdout + exit code for a successful run", async () => {
    const { root, logsDir } = setup();
    const script = writeScript(
      root,
      "run_task.sh",
      "#!/usr/bin/env bash\necho 'Hello from run_task'\nexit 0\n",
    );
    const invoker = createRunInvoker();
    const result = await invoker.invoke({
      planId: "0001",
      repoRoot: root,
      logsDir,
      runTaskScript: script,
    });
    expect(result.exitCode).toBe(0);
    expect(result.rateLimited).toBe(false);
    expect(existsSync(result.logPath)).toBe(true);
  });

  it("flags rate-limit when the log contains the marker", async () => {
    const { root, logsDir } = setup();
    const script = writeScript(
      root,
      "run_task.sh",
      '#!/usr/bin/env bash\necho "You\'ve hit your limit · resets at 5 AM"\nexit 1\n',
    );
    const invoker = createRunInvoker();
    const result = await invoker.invoke({
      planId: "0002",
      repoRoot: root,
      logsDir,
      runTaskScript: script,
    });
    expect(result.exitCode).toBe(1);
    expect(result.rateLimited).toBe(true);
    expect(result.reason).toMatch(/usage limit/i);
  });

  it("captures a short blocked reason from the log tail", async () => {
    const { root, logsDir } = setup();
    const script = writeScript(
      root,
      "run_task.sh",
      "#!/usr/bin/env bash\necho 'noise'\necho 'Preflight failed on typecheck'\nexit 1\n",
    );
    const invoker = createRunInvoker();
    const result = await invoker.invoke({
      planId: "0003",
      repoRoot: root,
      logsDir,
      runTaskScript: script,
    });
    expect(result.exitCode).toBe(1);
    expect(result.rateLimited).toBe(false);
    expect(result.reason).toMatch(/Preflight failed/);
  });
});
