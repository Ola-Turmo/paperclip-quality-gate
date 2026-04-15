import { describe, it } from "node:test";
import assert from "node:assert";

// ── Helpers (pure — reimplement to test the logic, not the TS types) ──────────

const MAX_HISTORY_ENTRIES = 50;

function buildNewReview(fields) {
  const now = new Date().toISOString();
  return {
    id: `review_${fields.issueId}_${fields._idSuffix ?? "test-id"}`,
    issueId: fields.issueId,
    companyId: fields.companyId,
    status: fields.status ?? "pending_review",
    qualityScore: fields.qualityScore ?? 0,
    blockApproval: fields.blockApproval ?? false,
    category: fields.category ?? "none",
    checks: fields.qualityChecks ?? [],
    evaluationSummary: fields.evaluationSummary ?? "",
    submitterName: fields.reviewerName,
    history: [
      {
        action: "submitted",
        reviewer: "user",
        reviewerName: fields.reviewerName,
        comment: fields.summary,
        qualityScore: fields.qualityScore,
        createdAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
}

function updateReviewStatus(review, status, action) {
  const now = new Date().toISOString();
  const nextHistory = [...review.history, { ...action, createdAt: now }].slice(
    -MAX_HISTORY_ENTRIES,
  );
  return {
    ...review,
    status,
    updatedAt: now,
    history: nextHistory,
  };
}

function buildSubmitComment(p) {
  const lines = [
    "## Quality Gate — Deliverable Submitted",
    "",
    `**Score:** ${p.qualityScore}/10`,
    `**Status:** Awaiting review`,
    "",
    p.evaluationSummary,
    "",
  ];
  if (p.blockApproval) {
    lines.push("⚠️ Block approval flag was set — manual review required.");
  }
  return lines.join("\n");
}

function buildApproveComment(comment) {
  const lines = [
    "## ✅ Quality Gate — Approved",
    "",
    "This deliverable has been approved by a reviewer.",
  ];
  if (comment) {
    lines.push("", `> ${comment}`);
  }
  lines.push("", "_Quality gate passed._");
  return lines.join("\n");
}

function buildRejectComment(comment) {
  const lines = [
    "## ❌ Quality Gate — Rejected",
    "",
    "This deliverable has been rejected and returned to the agent.",
    "",
    `> ${comment}`,
    "",
    "_Please address the feedback and resubmit for review._",
  ];
  return lines.join("\n");
}

function buildAutoRejectComment(score, autoRejectBelow) {
  return [
    "## ⚠️ Quality Gate — Auto-Rejected",
    "",
    `Score ${score} is below the auto-reject threshold of ${autoRejectBelow}.`,
    "",
    "This deliverable has been automatically rejected. Please improve quality and resubmit.",
    "",
    "_No human review was performed._",
  ].join("\n");
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildNewReview", () => {
  it("creates review with correct issueId and companyId", () => {
    const r = buildNewReview({
      issueId: "ISSUE-1",
      companyId: "ACME",
      reviewerName: "Alice",
      _idSuffix: "static-test-id",
    });
    assert.strictEqual(r.issueId, "ISSUE-1");
    assert.strictEqual(r.companyId, "ACME");
  });

  it("default status is pending_review", () => {
    const r = buildNewReview({
      issueId: "ISSUE-1",
      companyId: "ACME",
      reviewerName: "Alice",
      _idSuffix: "static-test-id",
    });
    assert.strictEqual(r.status, "pending_review");
  });

  it("uses provided status when given", () => {
    const r = buildNewReview({
      issueId: "ISSUE-1",
      companyId: "ACME",
      reviewerName: "Alice",
      status: "approved",
      _idSuffix: "static-test-id",
    });
    assert.strictEqual(r.status, "approved");
  });

  it("id format is review_<issueId>_<suffix>", () => {
    const r = buildNewReview({
      issueId: "ISSUE-42",
      companyId: "ACME",
      reviewerName: "Alice",
      _idSuffix: "abc123",
    });
    assert.strictEqual(r.id, "review_ISSUE-42_abc123");
  });

  it("history has one submitted entry", () => {
    const r = buildNewReview({
      issueId: "ISSUE-1",
      companyId: "ACME",
      reviewerName: "Alice",
      summary: "Fixed the bug",
      qualityScore: 8,
      _idSuffix: "static-test-id",
    });
    assert.strictEqual(r.history.length, 1);
    assert.strictEqual(r.history[0].action, "submitted");
    assert.strictEqual(r.history[0].reviewerName, "Alice");
    assert.strictEqual(r.history[0].comment, "Fixed the bug");
    assert.strictEqual(r.history[0].qualityScore, 8);
  });

  it("qualityScore defaults to 0", () => {
    const r = buildNewReview({
      issueId: "ISSUE-1",
      companyId: "ACME",
      reviewerName: "Alice",
      _idSuffix: "static-test-id",
    });
    assert.strictEqual(r.qualityScore, 0);
  });

  it("category defaults to none", () => {
    const r = buildNewReview({
      issueId: "ISSUE-1",
      companyId: "ACME",
      reviewerName: "Alice",
      _idSuffix: "static-test-id",
    });
    assert.strictEqual(r.category, "none");
  });

  it("createdAt and updatedAt are ISO strings", () => {
    const r = buildNewReview({
      issueId: "ISSUE-1",
      companyId: "ACME",
      reviewerName: "Alice",
      _idSuffix: "static-test-id",
    });
    assert.ok(r.createdAt.includes("T"));
    assert.ok(r.updatedAt.includes("T"));
    assert.strictEqual(r.createdAt, r.updatedAt);
  });
});

describe("updateReviewStatus", () => {
  const baseReview = buildNewReview({
    issueId: "ISSUE-1",
    companyId: "ACME",
    reviewerName: "Alice",
    _idSuffix: "base",
  });

  it("updates status field", () => {
    const r = updateReviewStatus(baseReview, "approved", {
      action: "approved",
      reviewer: "user",
      reviewerName: "Bob",
    });
    assert.strictEqual(r.status, "approved");
  });

  it("appends to history", () => {
    const r = updateReviewStatus(baseReview, "approved", {
      action: "approved",
      reviewer: "user",
      reviewerName: "Bob",
      comment: "LGTM",
    });
    assert.strictEqual(r.history.length, 2);
    assert.strictEqual(r.history[1].action, "approved");
    assert.strictEqual(r.history[1].reviewerName, "Bob");
    assert.strictEqual(r.history[1].comment, "LGTM");
  });

  it("updates updatedAt timestamp", () => {
    const r = updateReviewStatus(baseReview, "approved", {
      action: "approved",
      reviewer: "user",
      reviewerName: "Bob",
    });
    assert.notStrictEqual(r.updatedAt, baseReview.createdAt);
  });

  it("caps history at MAX_HISTORY_ENTRIES (50)", () => {
    // Build a review with MAX_HISTORY_ENTRIES entries
    let r = baseReview;
    for (let i = 0; i < 55; i++) {
      r = updateReviewStatus(r, "needs_human_review", {
        action: `update-${i}`,
        reviewer: "user",
        reviewerName: `Reviewer${i}`,
      });
    }
    // Should be capped at 50 (most recent entries)
    assert.strictEqual(r.history.length, 50);
    // First entry (submitted) may have been dropped
    assert.ok(r.history.length <= 50);
  });

  it("newest history entries are at the end", () => {
    let r = baseReview;
    r = updateReviewStatus(r, "needs_human_review", {
      action: "first-update",
      reviewer: "user",
      reviewerName: "Alice",
    });
    r = updateReviewStatus(r, "approved", {
      action: "second-update",
      reviewer: "user",
      reviewerName: "Bob",
    });
    assert.strictEqual(r.history[r.history.length - 1].action, "second-update");
  });
});

describe("buildSubmitComment", () => {
  it("includes score in output", () => {
    const comment = buildSubmitComment({
      qualityScore: 8,
      evaluationSummary: "Looks good.",
      qualityChecks: [],
    });
    assert.ok(comment.includes("**Score:** 8/10"));
    assert.ok(comment.includes("## Quality Gate — Deliverable Submitted"));
  });

  it("includes evaluation summary", () => {
    const comment = buildSubmitComment({
      qualityScore: 8,
      evaluationSummary: "Meets all criteria.",
      qualityChecks: [],
    });
    assert.ok(comment.includes("Meets all criteria."));
  });

  it("adds block approval warning when flag is set", () => {
    const comment = buildSubmitComment({
      qualityScore: 8,
      evaluationSummary: "Done.",
      blockApproval: true,
      qualityChecks: [],
    });
    assert.ok(comment.includes("⚠️ Block approval flag was set"));
  });

  it("does not add block warning when flag is false", () => {
    const comment = buildSubmitComment({
      qualityScore: 8,
      evaluationSummary: "Done.",
      blockApproval: false,
      qualityChecks: [],
    });
    assert.ok(!comment.includes("⚠️"));
  });
});

describe("buildApproveComment", () => {
  it("includes approved header", () => {
    const comment = buildApproveComment();
    assert.ok(comment.includes("## ✅ Quality Gate — Approved"));
    assert.ok(comment.includes("This deliverable has been approved by a reviewer."));
  });

  it("includes optional comment as quote", () => {
    const comment = buildApproveComment("LGTM!");
    assert.ok(comment.includes("> LGTM!"));
  });

  it("does not add quote section when no comment", () => {
    const comment = buildApproveComment();
    assert.ok(!comment.includes(">"));
  });

  it("ends with quality gate passed marker", () => {
    const comment = buildApproveComment();
    assert.ok(comment.includes("_Quality gate passed._"));
  });
});

describe("buildRejectComment", () => {
  it("includes rejected header", () => {
    const comment = buildRejectComment("Not ready.");
    assert.ok(comment.includes("## ❌ Quality Gate — Rejected"));
    assert.ok(comment.includes("This deliverable has been rejected and returned to the agent."));
  });

  it("includes the rejection reason as a quote", () => {
    const comment = buildRejectComment("Missing tests.");
    assert.ok(comment.includes("> Missing tests."));
  });

  it("includes resubmit guidance", () => {
    const comment = buildRejectComment("Fix the bug.");
    assert.ok(comment.includes("_Please address the feedback and resubmit for review._"));
  });
});

describe("buildAutoRejectComment", () => {
  it("includes score and threshold", () => {
    const comment = buildAutoRejectComment(2, 3);
    assert.ok(comment.includes("Score 2 is below the auto-reject threshold of 3."));
  });

  it("includes auto-reject header", () => {
    const comment = buildAutoRejectComment(1, 3);
    assert.ok(comment.includes("## ⚠️ Quality Gate — Auto-Rejected"));
  });

  it("notes no human review was performed", () => {
    const comment = buildAutoRejectComment(0, 3);
    assert.ok(comment.includes("_No human review was performed._"));
  });

  it("includes resubmit guidance", () => {
    const comment = buildAutoRejectComment(2, 3);
    assert.ok(comment.includes("Please improve quality and resubmit."));
  });
});
