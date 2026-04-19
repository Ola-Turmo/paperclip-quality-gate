import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEvidenceMarkdown,
  buildNewReview,
  buildNextStepTemplate,
  buildReviewQueueData,
  evaluateQuality,
  redactSensitiveText,
  updateReviewStatus,
} from "../src/helpers.ts";
import { DEFAULT_CONFIG } from "../src/manifest.js";

describe("evaluateQuality", () => {
  it("uses passed custom checks to increase the decision score", () => {
    const result = evaluateQuality(6, false, {
      ...DEFAULT_CONFIG,
      customChecks: [
        { id: "has-assignee", name: "Has assignee", type: "has_assignee", scoreBonus: 2 },
      ],
    }, {
      title: "Ship outreach review cockpit",
      assignee: "agent-reviewer",
    });

    assert.equal(result.decisionScore, 8);
    assert.equal(result.category, "passed");
    assert.equal(result.checks.some((check) => check.id === "custom_has-assignee" && check.passed), true);
  });

  it("keeps missing scores in the manual review lane", () => {
    const result = evaluateQuality(undefined, false, DEFAULT_CONFIG);
    assert.equal(result.category, "none");
    assert.equal(result.blockThresholdBreached, true);
    assert.equal(result.riskFlags.some((flag) => flag.id === "missing-score"), true);
  });

  it("lets block approval override auto rejection", () => {
    const result = evaluateQuality(1, true, DEFAULT_CONFIG);
    assert.equal(result.category, "needs_human_review");
    assert.equal(result.autoRejected, false);
  });
});

describe("review package builders", () => {
  it("creates a review with evidence, draft, and next-step guidance", () => {
    const evaluation = evaluateQuality(8, false, DEFAULT_CONFIG, {
      title: "Cold outreach draft",
      description: "Prepare a reviewer-ready outbound message.",
      labels: ["outreach", "needs-review"],
      assignee: "sales-ops",
    });

    const review = buildNewReview({
      issueId: "ISSUE-42",
      companyId: "COMPANY-1",
      summary: "Drafted the outreach sequence and evidence notes.",
      reviewerName: "Operator",
      issueData: {
        title: "Cold outreach draft",
        description: "Prepare a reviewer-ready outbound message.",
        labels: ["outreach", "needs-review"],
        assignee: "sales-ops",
      },
      evaluation,
      trigger: {
        source: "manual_submit",
        actorLabel: "Operator",
        createdAt: "2026-04-19T07:00:00.000Z",
      },
    });

    assert.equal(review.status, "pending_review");
    assert.ok(review.evidenceBundle.hash.startsWith("qh_"));
    assert.equal(review.draftArtifact.revision, 1);
    assert.match(review.nextStepTemplate, /Revision brief|Release checklist|Follow-up instruction/);
    assert.match(buildEvidenceMarkdown(review), /Quality gate evidence package/);
  });

  it("recomputes summary and next-step guidance on status updates", () => {
    const evaluation = evaluateQuality(8, false, DEFAULT_CONFIG);
    const review = buildNewReview({
      issueId: "ISSUE-99",
      companyId: "COMPANY-1",
      summary: "Initial summary",
      reviewerName: "Operator",
      evaluation,
      trigger: {
        source: "manual_submit",
        actorLabel: "Operator",
        createdAt: "2026-04-19T07:00:00.000Z",
      },
    });

    const updated = updateReviewStatus(review, "approved", {
      action: "approved_hold",
      reviewer: "user",
      reviewerName: "Reviewer",
    }, {
      releaseDecision: {
        approvalState: "approved_hold",
        approvedBy: "Reviewer",
      },
      nextStepTemplate: buildNextStepTemplate(review, "release"),
    });

    assert.equal(updated.reviewSummary.disposition, "Approved and held");
    assert.match(updated.nextStepTemplate, /Release checklist/);
  });
});


describe("security redaction", () => {
  it("redacts common secret patterns before storing evidence text", () => {
    const redacted = redactSensitiveText("Use sk-123456789012345678901234 and Bearer abcdefghijklmnopqrstuvwxyz123456");
    assert.match(redacted, /\[REDACTED API KEY\]/);
    assert.match(redacted, /Bearer \[REDACTED\]/);
  });
});

describe("review queue snapshot", () => {
  it("summarizes queue counts and preserves recent ordering", () => {
    const approved = buildNewReview({
      issueId: "ISSUE-1",
      companyId: "COMPANY-1",
      summary: "Approved draft",
      reviewerName: "Operator",
      evaluation: evaluateQuality(8, false, DEFAULT_CONFIG),
      trigger: {
        source: "manual_submit",
        actorLabel: "Operator",
        createdAt: "2026-04-19T07:00:00.000Z",
      },
    });
    approved.releaseDecision = { approvalState: "released", releasedBy: "Reviewer", releasedAt: "2026-04-19T07:10:00.000Z" };
    approved.updatedAt = "2026-04-19T07:05:00.000Z";
    approved.status = "approved";

    const pending = buildNewReview({
      issueId: "ISSUE-2",
      companyId: "COMPANY-1",
      summary: "Needs human review",
      reviewerName: "Operator",
      evaluation: evaluateQuality(undefined, false, DEFAULT_CONFIG),
      trigger: {
        source: "manual_submit",
        actorLabel: "Operator",
        createdAt: "2026-04-19T07:20:00.000Z",
      },
    });
    pending.updatedAt = "2026-04-19T07:30:00.000Z";

    const queue = buildReviewQueueData([
      { review: approved, issue: { id: approved.issueId, title: "Approved draft", status: "done" } },
      { review: pending, issue: { id: pending.issueId, title: "Needs review", status: "in_review" } },
    ]);

    assert.equal(queue.summary.totalReviews, 2);
    assert.equal(queue.summary.pendingReviews, 1);
    assert.equal(queue.summary.releasedReviews, 1);
    assert.equal(queue.items[0]?.issueId, "ISSUE-2");
  });
});
