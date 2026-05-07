import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupEvents } from "../src/events.ts";

function makeMockCtx() {
  const logs: Array<{
    level: string;
    message: string;
    payload: Record<string, unknown>;
  }> = [];
  const comments: Array<{ issueId: string; body: string; companyId: string }> =
    [];
  const stateStore = new Map<string, unknown>();
  const emits: Array<{ event: string; payload: unknown }> = [];

  const ctx = {
    logger: {
      info(message: string, payload: Record<string, unknown>) {
        logs.push({ level: "info", message, payload });
      },
      warn(message: string, payload: Record<string, unknown>) {
        logs.push({ level: "warn", message, payload });
      },
    },
    config: {
      async get() {
        return {};
      },
    },
    state: {
      async get(key: {
        scopeKind: string;
        scopeId?: string;
        stateKey: string;
      }) {
        return (
          stateStore.get(
            `${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`,
          ) ?? null
        );
      },
      async set(
        key: { scopeKind: string; scopeId?: string; stateKey: string },
        value: unknown,
      ) {
        stateStore.set(
          `${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`,
          value,
        );
      },
      async delete(key: {
        scopeKind: string;
        scopeId?: string;
        stateKey: string;
      }) {
        stateStore.delete(
          `${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`,
        );
      },
    },
    issues: {
      async get(issueId: string, _companyId?: string) {
        return {
          id: issueId,
          companyId: "COMPANY-1",
          title: "Test issue",
          description: "Test description",
          status: "done",
          labels: [],
        } as unknown as {
          id: string;
          companyId: string;
          title: string;
          description?: string;
          status?: string;
        };
      },
      async list(_query?: unknown) {
        return [] as unknown[];
      },
      async createComment(issueId: string, body: string, companyId: string) {
        comments.push({ issueId, body, companyId });
      },
      documents: {
        async upsert(_doc: unknown) {
          // no-op
        },
      },
    },
    streams: {
      emit(event: string, payload: unknown) {
        emits.push({ event, payload });
      },
    },
    metrics: {
      async write() {
        // no-op
      },
    },
    telemetry: {
      async track() {
        // no-op
      },
    },
    events: {
      on(
        _eventType: string,
        _handler: (event: unknown) => Promise<void> | void,
      ) {
        // no-op
      },
    },
  };

  return { ctx, logs, comments, stateStore, emits };
}

describe("quality gate events", () => {
  it("does not throw when issue.updated payload omits the issue object", async () => {
    const { ctx, logs } = makeMockCtx();
    const handlers = new Map<
      string,
      (event: unknown) => Promise<void> | void
    >();

    const ctxWithEvents = {
      ...ctx,
      events: {
        on(
          eventType: string,
          handler: (event: unknown) => Promise<void> | void,
        ) {
          handlers.set(eventType, handler);
        },
      },
    };

    setupEvents(ctxWithEvents as never);

    const handler = handlers.get("issue.updated");
    assert.ok(handler, "issue.updated handler should be registered");

    await assert.doesNotReject(async () => {
      await handler?.({
        type: "issue.updated",
        entityId: "ISSUE-1",
        companyId: "COMPANY-1",
        payload: {
          previousStatus: "backlog",
        },
      });
    });

    assert.equal(logs.length, 1);
    assert.equal(logs[0]?.message, "issue.updated observed");
    assert.equal(logs[0]?.payload.issueId, "ISSUE-1");
    assert.equal(logs[0]?.payload.status, null);
    assert.equal(logs[0]?.payload.previousStatus, "backlog");
  });

  it("auto-creates a review when an issue transitions from in_progress to done", async () => {
    const { ctx, comments, stateStore, emits } = makeMockCtx();
    const handlers = new Map<
      string,
      (event: unknown) => Promise<void> | void
    >();

    const ctxWithEvents = {
      ...ctx,
      events: {
        on(
          eventType: string,
          handler: (event: unknown) => Promise<void> | void,
        ) {
          handlers.set(eventType, handler);
        },
      },
    };

    setupEvents(ctxWithEvents as never);
    const handler = handlers.get("issue.updated");
    assert.ok(handler);

    await handler?.({
      type: "issue.updated",
      entityId: "ISSUE-1",
      companyId: "COMPANY-1",
      payload: {
        issue: { id: "ISSUE-1", status: "done" },
        previousStatus: "in_progress",
      },
    });

    assert.equal(comments.length, 1);
    assert.equal(comments[0]?.issueId, "ISSUE-1");
    assert.match(comments[0]?.body as string, /Quality Gate/);

    const review = stateStore.get("issue:ISSUE-1:reviews");
    assert.ok(review, "review should be stored in state");
    assert.equal(
      (review as { trigger: { source: string } }).trigger.source,
      "issue_status_change",
    );

    assert.ok(emits.some((e) => e.event === "quality_gate.review_created"));
  });

  it("skips auto-creation when previous status was already done", async () => {
    const { ctx, comments, emits } = makeMockCtx();
    const handlers = new Map<
      string,
      (event: unknown) => Promise<void> | void
    >();

    const ctxWithEvents = {
      ...ctx,
      events: {
        on(
          eventType: string,
          handler: (event: unknown) => Promise<void> | void,
        ) {
          handlers.set(eventType, handler);
        },
      },
    };

    setupEvents(ctxWithEvents as never);
    const handler = handlers.get("issue.updated");
    assert.ok(handler);

    await handler?.({
      type: "issue.updated",
      entityId: "ISSUE-1",
      companyId: "COMPANY-1",
      payload: {
        issue: { id: "ISSUE-1", status: "done" },
        previousStatus: "done",
      },
    });

    assert.equal(comments.length, 0);
    assert.equal(emits.length, 0);
  });

  it("skips auto-creation when a review already exists", async () => {
    const { ctx, comments, stateStore, emits } = makeMockCtx();
    const handlers = new Map<
      string,
      (event: unknown) => Promise<void> | void
    >();

    // Pre-seed an existing review
    stateStore.set("issue:ISSUE-1:reviews", {
      id: "review_ISSUE-1_existing",
      issueId: "ISSUE-1",
    });

    const ctxWithEvents = {
      ...ctx,
      events: {
        on(
          eventType: string,
          handler: (event: unknown) => Promise<void> | void,
        ) {
          handlers.set(eventType, handler);
        },
      },
    };

    setupEvents(ctxWithEvents as never);
    const handler = handlers.get("issue.updated");
    assert.ok(handler);

    await handler?.({
      type: "issue.updated",
      entityId: "ISSUE-1",
      companyId: "COMPANY-1",
      payload: {
        issue: { id: "ISSUE-1", status: "done" },
        previousStatus: "in_progress",
      },
    });

    assert.equal(comments.length, 0);
    assert.equal(emits.length, 0);
  });

  it("skips auto-creation when new status is not a done state", async () => {
    const { ctx, comments, emits } = makeMockCtx();
    const handlers = new Map<
      string,
      (event: unknown) => Promise<void> | void
    >();

    const ctxWithEvents = {
      ...ctx,
      events: {
        on(
          eventType: string,
          handler: (event: unknown) => Promise<void> | void,
        ) {
          handlers.set(eventType, handler);
        },
      },
    };

    setupEvents(ctxWithEvents as never);
    const handler = handlers.get("issue.updated");
    assert.ok(handler);

    await handler?.({
      type: "issue.updated",
      entityId: "ISSUE-1",
      companyId: "COMPANY-1",
      payload: {
        issue: { id: "ISSUE-1", status: "in_progress" },
        previousStatus: "todo",
      },
    });

    assert.equal(comments.length, 0);
    assert.equal(emits.length, 0);
  });

  it("indexes run on agent.run.started and resolves it on agent.run.finished", async () => {
    const { ctx, stateStore, comments, emits } = makeMockCtx();
    const handlers = new Map<
      string,
      (event: unknown) => Promise<void> | void
    >();

    const ctxWithEvents = {
      ...ctx,
      issues: {
        ...ctx.issues,
        async list(_query?: unknown) {
          return [
            {
              id: "ISSUE-RUN-1",
              companyId: "COMPANY-1",
              title: "Run issue",
              executionRunId: "RUN-1",
            },
          ] as unknown[];
        },
      },
      events: {
        on(
          eventType: string,
          handler: (event: unknown) => Promise<void> | void,
        ) {
          handlers.set(eventType, handler);
        },
      },
    };

    setupEvents(ctxWithEvents as never);
    const startedHandler = handlers.get("agent.run.started");
    const finishedHandler = handlers.get("agent.run.finished");
    assert.ok(startedHandler, "agent.run.started handler should be registered");
    assert.ok(
      finishedHandler,
      "agent.run.finished handler should be registered",
    );

    await startedHandler?.({
      type: "agent.run.started",
      entityId: "RUN-1",
      companyId: "COMPANY-1",
      payload: {},
    });

    const indexed = stateStore.get("run:RUN-1:quality_gate_run_index");
    assert.equal(indexed, "ISSUE-RUN-1", "run should be indexed to issue");

    await finishedHandler?.({
      type: "agent.run.finished",
      entityId: "RUN-1",
      companyId: "COMPANY-1",
      actorId: "AGENT-1",
      payload: {},
    });

    // Index should be cleaned up
    assert.equal(
      stateStore.has("run:RUN-1:quality_gate_run_index"),
      false,
      "run index should be cleaned up",
    );

    // Review should be created
    const review = stateStore.get("issue:ISSUE-RUN-1:reviews");
    assert.ok(review, "review should be created from indexed run");
    assert.equal(
      (review as { trigger: { source: string } }).trigger.source,
      "agent_run_finished",
    );
    assert.equal((review as { agentId?: string }).agentId, "AGENT-1");

    assert.ok(emits.some((e) => e.event === "quality_gate.review_created"));
    assert.equal(comments.length, 1);
  });

  it("falls back to issue scan when run index is missing on agent.run.finished", async () => {
    const { ctx, stateStore, comments, emits } = makeMockCtx();
    const handlers = new Map<
      string,
      (event: unknown) => Promise<void> | void
    >();

    const ctxWithEvents = {
      ...ctx,
      issues: {
        ...ctx.issues,
        async list(_query?: unknown) {
          return [
            {
              id: "ISSUE-RUN-2",
              companyId: "COMPANY-1",
              title: "Run issue fallback",
              originRunId: "RUN-2",
            },
          ] as unknown[];
        },
      },
      events: {
        on(
          eventType: string,
          handler: (event: unknown) => Promise<void> | void,
        ) {
          handlers.set(eventType, handler);
        },
      },
    };

    setupEvents(ctxWithEvents as never);
    const finishedHandler = handlers.get("agent.run.finished");
    assert.ok(finishedHandler);

    await finishedHandler?.({
      type: "agent.run.finished",
      entityId: "RUN-2",
      companyId: "COMPANY-1",
      payload: {
        qualityScore: 8,
        summary: "Great work",
      },
    });

    const review = stateStore.get("issue:ISSUE-RUN-2:reviews");
    assert.ok(review, "review should be created via fallback scan");
    assert.equal((review as { qualityScore: number }).qualityScore, 8);
    assert.equal(
      (review as { trigger: { source: string } }).trigger.source,
      "agent_run_finished",
    );
    assert.ok(emits.some((e) => e.event === "quality_gate.review_created"));
    assert.equal(comments.length, 1);
  });

  it("creates a review even when agent.run.finished payload is minimal", async () => {
    const { ctx, stateStore, comments, emits } = makeMockCtx();
    const handlers = new Map<
      string,
      (event: unknown) => Promise<void> | void
    >();

    const ctxWithEvents = {
      ...ctx,
      issues: {
        ...ctx.issues,
        async list(_query?: unknown) {
          return [
            {
              id: "ISSUE-RUN-3",
              companyId: "COMPANY-1",
              title: "Minimal payload issue",
              executionRunId: "RUN-3",
            },
          ] as unknown[];
        },
      },
      events: {
        on(
          eventType: string,
          handler: (event: unknown) => Promise<void> | void,
        ) {
          handlers.set(eventType, handler);
        },
      },
    };

    setupEvents(ctxWithEvents as never);
    const finishedHandler = handlers.get("agent.run.finished");
    assert.ok(finishedHandler);

    await finishedHandler?.({
      type: "agent.run.finished",
      entityId: "RUN-3",
      companyId: "COMPANY-1",
      payload: {},
    });

    const review = stateStore.get("issue:ISSUE-RUN-3:reviews");
    assert.ok(review, "review should be created even with empty payload");
    assert.equal(
      (review as { trigger: { source: string } }).trigger.source,
      "agent_run_finished",
    );
    assert.ok(emits.some((e) => e.event === "quality_gate.review_created"));
    assert.equal(comments.length, 1);
  });

  it("cleans up run index on agent.run.failed", async () => {
    const { ctx, stateStore } = makeMockCtx();
    const handlers = new Map<
      string,
      (event: unknown) => Promise<void> | void
    >();

    // Pre-seed a run index
    stateStore.set("run:RUN-FAIL:quality_gate_run_index", "ISSUE-FAIL");

    const ctxWithEvents = {
      ...ctx,
      events: {
        on(
          eventType: string,
          handler: (event: unknown) => Promise<void> | void,
        ) {
          handlers.set(eventType, handler);
        },
      },
    };

    setupEvents(ctxWithEvents as never);
    const failedHandler = handlers.get("agent.run.failed");
    assert.ok(failedHandler);

    await failedHandler?.({
      type: "agent.run.failed",
      entityId: "RUN-FAIL",
      companyId: "COMPANY-1",
      payload: {},
    });

    assert.equal(
      stateStore.has("run:RUN-FAIL:quality_gate_run_index"),
      false,
      "run index should be cleaned up on failure",
    );
  });
});
