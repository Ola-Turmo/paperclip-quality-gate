import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupEvents } from "../src/events.ts";

describe("quality gate events", () => {
  it("does not throw when issue.updated payload omits the issue object", async () => {
    const handlers = new Map<string, (event: unknown) => Promise<void> | void>();
    const logs: Array<{ message: string; payload: Record<string, unknown> }> = [];

    const ctx = {
      logger: {
        info(message: string, payload: Record<string, unknown>) {
          logs.push({ message, payload });
        },
      },
      events: {
        on(eventType: string, handler: (event: unknown) => Promise<void> | void) {
          handlers.set(eventType, handler);
        },
      },
    } as const;

    setupEvents(ctx as never);

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
});
