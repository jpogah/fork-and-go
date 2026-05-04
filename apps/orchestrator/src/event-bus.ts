// Event bus for the orchestrator. The runner and daemon emit lifecycle
// events; consumers (the cloud API, an audit-log sink, a Slack notifier)
// subscribe and translate the events into their own surface.
//
// Default sink is no-op so OSS users see no behavior change. The cloud
// runner replaces it with a webhook poster that pushes events to the
// API's `/internal/events` endpoint.
//
// Design notes:
// - Events are *fire-and-forget* with respect to the runner. A slow or
//   failing sink must not stall the agent. Sinks that need to durably
//   persist should buffer + retry on their own side.
// - Payloads are structurally typed by `kind`. Adding a new kind means
//   extending the discriminated union below.
// - This is intentionally not an EventEmitter — we want typed payloads
//   per kind, and we don't need wildcard listeners.

import type { TokenUsage } from "@harness/agent-runner";

export type RunStartedEvent = {
  kind: "run_started";
  at: string; // ISO timestamp
  planId: string;
  branch: string;
  runId: string;
  runDir: string;
  // Optional project identifier the cloud sets so multi-tenant sinks
  // know which tenant the event belongs to.
  projectId?: string;
};

export type PhaseCompletedEvent = {
  kind: "phase_completed";
  at: string;
  planId: string;
  runId: string;
  phase: string;
  ok: boolean;
  rateLimited?: boolean;
  projectId?: string;
};

export type TokensRecordedEvent = {
  kind: "tokens_recorded";
  at: string;
  planId: string;
  runId: string;
  phase: string;
  tokens: TokenUsage;
  // Provider-reported model name, when available. The runner stamps
  // "agent" today; cloud-side sinks may overwrite when they have richer
  // info from the SDK event stream.
  model?: string;
  projectId?: string;
};

export type RunFinishedEvent = {
  kind: "run_finished";
  at: string;
  planId: string;
  runId: string;
  branch: string;
  ok: boolean;
  rateLimited?: boolean;
  reason?: string;
  logPath: string;
  projectId?: string;
};

export type PlanCompletedEvent = {
  kind: "plan_completed";
  at: string;
  planId: string;
  // Where the plan migrated to. Populated by the daemon's success
  // handler, not by `runTask` (which doesn't migrate).
  fromPath: string;
  toPath: string;
  projectId?: string;
};

export type PlanBlockedEvent = {
  kind: "plan_blocked";
  at: string;
  planId: string;
  reason: string;
  projectId?: string;
};

export type HarnessEvent =
  | RunStartedEvent
  | PhaseCompletedEvent
  | TokensRecordedEvent
  | RunFinishedEvent
  | PlanCompletedEvent
  | PlanBlockedEvent;

export interface EventSink {
  emit(event: HarnessEvent): Promise<void> | void;
}

export const noopEventSink: EventSink = {
  emit() {
    // Intentionally empty. OSS default.
  },
};

export function createMultiSink(...sinks: EventSink[]): EventSink {
  return {
    async emit(event) {
      // Fire each sink independently. A failing sink must not block the
      // others. The async wrapper turns a synchronous throw into a
      // rejected promise so allSettled can isolate it.
      await Promise.allSettled(
        sinks.map(async (s) => {
          await s.emit(event);
        }),
      );
    },
  };
}

// In-memory sink — useful for tests and for a tiny "what did the daemon
// just do?" UI. Bounded by `limit` to avoid unbounded growth in
// long-running processes.
export function createMemoryEventSink(
  limit = 1000,
): EventSink & { events: HarnessEvent[] } {
  const events: HarnessEvent[] = [];
  return {
    events,
    emit(event) {
      events.push(event);
      while (events.length > limit) events.shift();
    },
  };
}
