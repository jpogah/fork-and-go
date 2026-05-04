import { describe, expect, it } from "vitest";

import {
  createMemoryEventSink,
  createMultiSink,
  noopEventSink,
  type EventSink,
  type HarnessEvent,
} from "./event-bus.ts";

describe("event-bus", () => {
  it("noopEventSink swallows events without throwing", () => {
    expect(() =>
      noopEventSink.emit({
        kind: "run_started",
        at: "2026-01-01T00:00:00Z",
        planId: "0001",
        branch: "task/0001",
        runId: "r1",
        runDir: "/tmp/r1",
      }),
    ).not.toThrow();
  });

  it("memory sink stores events up to limit", () => {
    const sink = createMemoryEventSink(2);
    sink.emit({ kind: "run_started", at: "t1", planId: "p", branch: "b", runId: "r1", runDir: "/" });
    sink.emit({ kind: "run_started", at: "t2", planId: "p", branch: "b", runId: "r2", runDir: "/" });
    sink.emit({ kind: "run_started", at: "t3", planId: "p", branch: "b", runId: "r3", runDir: "/" });
    expect(sink.events).toHaveLength(2);
    expect(sink.events.map((e) => e.kind === "run_started" && e.runId)).toEqual([
      "r2",
      "r3",
    ]);
  });

  it("multi-sink emits to all branches even when one throws", async () => {
    const a = createMemoryEventSink();
    const failing: EventSink = {
      emit() {
        throw new Error("boom");
      },
    };
    const b = createMemoryEventSink();
    const sink = createMultiSink(a, failing, b);
    await sink.emit({
      kind: "run_started",
      at: "t",
      planId: "p",
      branch: "b",
      runId: "r",
      runDir: "/",
    });
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
  });

  it("typed events: phase_completed carries rateLimited", () => {
    const sink = createMemoryEventSink();
    const event: HarnessEvent = {
      kind: "phase_completed",
      at: "t",
      planId: "p",
      runId: "r",
      phase: "implement",
      ok: false,
      rateLimited: true,
    };
    sink.emit(event);
    expect(sink.events[0]).toEqual(event);
  });
});
