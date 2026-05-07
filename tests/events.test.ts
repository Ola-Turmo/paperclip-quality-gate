import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupEvents } from "../src/events.ts";

function makeMockCtx() {
  const logs: Array<{ level: string; message: string; payload: Record<string, unknown> }> = [];
  const comments: Array<{ issueId: string; body: string; companyId: string }> = [];
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
      async get(key: { scopeKind: string; scopeId: string; stateKey: string }) {
        return stateStore.get(`${key.scopeKind}:${key.scopeId}:${key.stateKey}`) ?? null;
      },
      async set(key: { scopeKind: string; scopeId: string; stateKey: string }, value: unknown) {
        stateStore.set(`${key.scopeKind}:${key.scopeId}:${key.stateKey}`, value);
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
        } as unknown as { id: string; companyId: string; title: string; description?: string; status?: string };
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
    const handlers = new Map<string, (event: unknown) => Promise<void> | void>();

    const ctxWithEvents = {
      ...ctx,
      events: {
        on(eventType: string, handler: (event: unknown) => Promise<void> | void) {
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
    const handlers = new Map<string, (event: unknown) => Promise<void> | void>();

    const ctxWithEvents = {
      ...ctx,
      events: {
        on(eventType: string, handler: (event: unknown) => Promise<void> | void) {
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
    assert.equal((review as { trigger: { source: string } }).trigger.source, "issue_status_change");

    assert.ok(emits.some((e) => e.event === "quality_gate.review_created"));
  });

  it("skips auto-creation when previous status was already done", async () => {
    const { ctx, comments, emits } = makeMockCtx();
    const handlers = new Map<string, (event: unknown) => Promise<void> | void>();

    const ctxWithEvents = {
      ...ctx,
      events: {
        on(eventType: string, handler: (event: unknown) => Promise<void> | void) {
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
    const handlers = new Map<string, (event: unknown) => Promise<void> | void>();

    // Pre-seed an existing review
    stateStore.set("issue:ISSUE-1:reviews", {
      id: "review_ISSUE-1_existing",
      issueId: "ISSUE-1",
    });

    const ctxWithEvents = {
      ...ctx,
      events: {
        on(eventType: string, handler: (event: unknown) => Promise<void> | void) {
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
    const handlers = new Map<string, (event: unknown) => Promise<void> | void>();

    const ctxWithEvents = {
      ...ctx,
      events: {
        on(eventType: string, handler: (event: unknown) => Promise<void> | void) {
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
});
