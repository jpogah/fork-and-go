export type LogLevel = "info" | "warn" | "error";

export interface LogEvent {
  level?: LogLevel;
  event: string;
  planId?: string;
  [key: string]: unknown;
}

export interface Logger {
  log: (event: LogEvent) => void;
}

export function createStdoutLogger(now: () => Date = () => new Date()): Logger {
  return {
    log(event) {
      const level: LogLevel = event.level ?? "info";
      const payload = {
        ts: now().toISOString(),
        level,
        ...event,
      };
      const line = JSON.stringify(payload);
      if (level === "error") {
        process.stderr.write(line + "\n");
      } else if (level === "warn") {
        process.stderr.write(line + "\n");
      } else {
        process.stdout.write(line + "\n");
      }
    },
  };
}

export function createSilentLogger(): Logger {
  return { log: () => {} };
}
