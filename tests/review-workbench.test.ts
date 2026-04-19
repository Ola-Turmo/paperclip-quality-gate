import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildApproveComment,
  buildApproveHoldComment,
  buildRejectComment,
  buildReturnToAgentComment,
  buildTelemetryEnvelope,
  buildNewReview,
  evaluateQuality,
} from "../src/helpers.ts";
import { DEFAULT_CONFIG } from "../src/manifest.js";

describe("comment builders", () => {
  it("creates reviewer-facing approval and release comments", () => {
    assert.match(buildApproveHoldComment("Looks good, hold for final send."), /Approved \(Held\)/);
    assert.match(buildApproveComment("Ship it."), /Approved & Released/);
    assert.match(buildRejectComment("Missing evidence for compliance."), /Revision Requested/);
    assert.match(buildReturnToAgentComment("Please address the compliance gaps.", "agent-123"), /@agent-123/);
  });
});

describe("telemetry envelope", () => {
  it("captures the core decision fields used for observability", () => {
    const evaluation = evaluateQuality(7, false, DEFAULT_CONFIG);
    const review = buildNewReview({
      issueId: "ISSUE-100",
      companyId: "COMPANY-2",
      reviewerName: "Operator",
      summary: "Ready for release",
      evaluation,
      trigger: {
        source: "manual_submit",
        actorLabel: "Operator",
        createdAt: "2026-04-19T07:00:00.000Z",
      },
    });

    const envelope = buildTelemetryEnvelope(review, "submit");
    assert.equal(envelope.company_id, "COMPANY-2");
    assert.equal(envelope.issue_id, "ISSUE-100");
    assert.equal(envelope.decision_type, "submit");
    assert.equal(typeof envelope.display_score, "number");
  });
});


describe("comment sanitization", () => {
  it("redacts obvious secrets in reviewer-facing comments", () => {
    const comment = buildApproveComment("Ship with sk-123456789012345678901234 hidden.");
    assert.match(comment, /\[REDACTED API KEY\]/);
  });
});
