/**
 * Unit tests for the actual helpers.ts source.
 * Runs against the TypeScript source directly via tsx --test.
 *
 * Key boundaries (DEFAULT_CONFIG: minQualityScore=7, blockThreshold=5, autoRejectBelow=3):
 *   undefined/null  → "none"
 *   0, 1, 2        → "auto_rejected"  (score < autoRejectBelow)
 *   3, 4, 5, 6     → "needs_human_review"  (score <= blockThreshold, or blockApproval)
 *   7, 8, 9, 10    → "passed"         (score >= minQualityScore)
 *
 * Variance: ±1 from djb2 — must be deterministic (same input = same output).
 */
import { describe, it } from "node:test";
import assert from "node:assert";
import {
  evaluateQuality,
  mapTargetStatus,
  buildApproveComment,
  buildRejectComment,
  buildAutoRejectComment,
  buildSubmitComment,
} from "../src/helpers.ts";
import { DEFAULT_CONFIG } from "../src/manifest.js";

// ── evaluateQuality ───────────────────────────────────────────────────────────

describe("evaluateQuality — actual source (tsx)", () => {
  const cfg = DEFAULT_CONFIG;

  // Score = undefined/null → "none"
  it("undefined score → category 'none'", () => {
    const r = evaluateQuality(undefined, false, cfg);
    assert.strictEqual(r.category, "none");
    assert.strictEqual(r.autoRejected, false);
    assert.strictEqual(r.passed, false);
  });

  it("null score → category 'none'", () => {
  // @ts-ignore — deliberately pass null to test runtime behaviour
  const r = evaluateQuality(null, false, cfg);
    assert.strictEqual(r.category, "none");
  });

  // Score < autoRejectBelow (3) → "auto_rejected"
  it("score 0 → auto_rejected", () => {
    const r = evaluateQuality(0, false, cfg);
    assert.strictEqual(r.category, "auto_rejected");
    assert.strictEqual(r.autoRejected, true);
    assert.strictEqual(r.passed, false);
  });

  it("score 1 → auto_rejected", () => {
    const r = evaluateQuality(1, false, cfg);
    assert.strictEqual(r.category, "auto_rejected");
  });

  it("score 2 → auto_rejected", () => {
    const r = evaluateQuality(2, false, cfg);
    assert.strictEqual(r.category, "auto_rejected");
  });

  // Score at autoRejectBelow boundary (3) → not auto-rejected
  it("score 3 → NOT auto_rejected (at boundary)", () => {
    const r = evaluateQuality(3, false, cfg);
    assert.notStrictEqual(r.category, "auto_rejected");
  });

  // Score <= blockThreshold (5) → "needs_human_review"
  it("score 3 → needs_human_review (score <= blockThreshold)", () => {
    const r = evaluateQuality(3, false, cfg);
    assert.strictEqual(r.category, "needs_human_review");
    assert.strictEqual(r.blockThresholdBreached, true);
  });

  it("score 4 → needs_human_review (score <= blockThreshold)", () => {
    const r = evaluateQuality(4, false, cfg);
    assert.strictEqual(r.category, "needs_human_review");
  });

  it("score 5 → needs_human_review (score == blockThreshold)", () => {
    const r = evaluateQuality(5, false, cfg);
    assert.strictEqual(r.category, "needs_human_review");
    assert.strictEqual(r.blockThresholdBreached, true);
  });

  // Score between blockThreshold and minQualityScore
  it("score 6 → needs_human_review (between thresholds)", () => {
    const r = evaluateQuality(6, false, cfg);
    assert.strictEqual(r.category, "needs_human_review");
    assert.strictEqual(r.blockThresholdBreached, false);
  });

  // Score >= minQualityScore (7) → "passed"
  it("score 7 → passed (score == minQualityScore)", () => {
    const r = evaluateQuality(7, false, cfg);
    assert.strictEqual(r.category, "passed");
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.blockThresholdBreached, false);
    assert.strictEqual(r.autoRejected, false);
  });

  it("score 8 → passed", () => {
    const r = evaluateQuality(8, false, cfg);
    assert.strictEqual(r.category, "passed");
  });

  it("score 9 → passed", () => {
    const r = evaluateQuality(9, false, cfg);
    assert.strictEqual(r.category, "passed");
  });

  it("score 10 → passed", () => {
    const r = evaluateQuality(10, false, cfg);
    assert.strictEqual(r.category, "passed");
  });

  // blockApproval overrides score
  it("blockApproval=true → needs_human_review regardless of high score", () => {
    const r = evaluateQuality(9, true, cfg);
    assert.strictEqual(r.category, "needs_human_review");
    assert.strictEqual(r.blockThresholdBreached, true);
    assert.strictEqual(r.passed, false);
  });

  it("blockApproval=true with score 0 → needs_human_review", () => {
    const r = evaluateQuality(0, true, cfg);
    assert.strictEqual(r.category, "needs_human_review");
    assert.strictEqual(r.autoRejected, false); // blockApproval takes precedence
  });

  // Clamping: overallScore is clamped to [0, 10]
  it("overallScore is clamped to 0 at minimum", () => {
    // The variance can push score negative; verify clamping
    const r = evaluateQuality(0, false, cfg);
    assert.ok(r.overallScore >= 0);
    assert.ok(r.overallScore <= 10);
  });

  it("overallScore is clamped to 10 at maximum", () => {
    const r = evaluateQuality(10, false, cfg);
    assert.ok(r.overallScore >= 0);
    assert.ok(r.overallScore <= 10);
  });

  // Determinism: same inputs must produce same outputs
  it("deterministic: two calls with same score produce identical results", () => {
    const r1 = evaluateQuality(7, false, cfg);
    const r2 = evaluateQuality(7, false, cfg);
    assert.deepStrictEqual(r1, r2);
  });

  it("deterministic: djb2 variance is ±1 and consistent", () => {
    // Run multiple scores and verify variant is always -1, 0, or +1
    for (const score of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const r = evaluateQuality(score, false, cfg);
      const diff = r.overallScore - (score ?? 0);
      assert.ok(
        diff >= -1 && diff <= 1,
        `score=${score}: overallScore=${r.overallScore}, diff=${diff} not in [-1,0,+1]`,
      );
    }
  });

  // Checks are always present
  it("returns non-empty checks array", () => {
    const r = evaluateQuality(7, false, cfg);
    assert.ok(Array.isArray(r.checks));
    assert.ok(r.checks.length > 0);
  });

  // Summary is always a string
  it("returns a non-empty summary string", () => {
    const r = evaluateQuality(7, false, cfg);
    assert.strictEqual(typeof r.summary, "string");
    assert.ok(r.summary.length > 0);
  });
});

// ── mapTargetStatus ───────────────────────────────────────────────────────────

describe("mapTargetStatus — actual source (tsx)", () => {
  it('"passed" → "in_review"', () => {
    assert.strictEqual(mapTargetStatus("passed"), "in_review");
  });

  it('"needs_human_review" → "in_review"', () => {
    assert.strictEqual(mapTargetStatus("needs_human_review"), "in_review");
  });

  it('"auto_rejected" → "in_progress"', () => {
    assert.strictEqual(mapTargetStatus("auto_rejected"), "in_progress");
  });

  it('"rejected" → "in_progress"', () => {
    assert.strictEqual(mapTargetStatus("rejected"), "in_progress");
  });

  it('"blocked" → "blocked"', () => {
    assert.strictEqual(mapTargetStatus("blocked"), "blocked");
  });

  it('"none" → null', () => {
    assert.strictEqual(mapTargetStatus("none"), null);
  });
});

// ── buildApproveComment ───────────────────────────────────────────────────────

describe("buildApproveComment — actual source (tsx)", () => {
  it("includes approved header and body", () => {
    const c = buildApproveComment();
    assert.ok(c.includes("✅"));
    assert.ok(c.includes("approved"));
    assert.ok(c.includes("approved by a reviewer"));
  });

  it("includes optional comment as a blockquote (prefixed with >)", () => {
    const c = buildApproveComment("Looks great!");
    assert.ok(c.includes("> Looks great!"));
  });

  it("omits quote block when no comment provided", () => {
    const c = buildApproveComment();
    // Should not have a blockquote marker when empty
    assert.ok(!c.includes(">") || !c.includes("\n>"));
  });

  it("ends with quality gate passed marker", () => {
    const c = buildApproveComment();
    assert.ok(c.includes("Quality gate passed"));
  });
});

// ── buildRejectComment ────────────────────────────────────────────────────────

describe("buildRejectComment — actual source (tsx)", () => {
  it("includes rejected header", () => {
    const c = buildRejectComment("Fix it");
    assert.ok(c.includes("❌"));
    assert.ok(c.includes("rejected"));
  });

  it("includes rejection reason as quote", () => {
    const c = buildRejectComment("Missing tests");
    assert.ok(c.includes("Missing tests"));
  });

  it("includes resubmit guidance", () => {
    const c = buildRejectComment("Not ready");
    assert.ok(c.includes("resubmit"));
  });
});

// ── buildAutoRejectComment ───────────────────────────────────────────────────

describe("buildAutoRejectComment — actual source (tsx)", () => {
  it("includes score and threshold", () => {
    const c = buildAutoRejectComment(2, 3);
    assert.ok(c.includes("2"));
    assert.ok(c.includes("3"));
    assert.ok(c.includes("auto-reject"));
  });

  it("notes no human review was performed", () => {
    const c = buildAutoRejectComment(1, 3);
    assert.ok(c.includes("No human review"));
  });

  it("includes resubmit guidance", () => {
    const c = buildAutoRejectComment(0, 3);
    assert.ok(c.includes("improve quality") || c.includes("resubmit"));
  });
});

// ── buildSubmitComment ────────────────────────────────────────────────────────

describe("buildSubmitComment — actual source (tsx)", () => {
  it("includes score in output", () => {
    const c = buildSubmitComment({
      qualityScore: 8,
      evaluationSummary: "Looks good.",
      qualityChecks: [],
    });
    assert.ok(c.includes("8"));
    assert.ok(c.includes("10"));
  });

  it("includes evaluation summary", () => {
    const c = buildSubmitComment({
      qualityScore: 8,
      evaluationSummary: "Meets all criteria.",
      qualityChecks: [],
    });
    assert.ok(c.includes("Meets all criteria"));
  });

  it("adds block approval warning when flag is set", () => {
    const c = buildSubmitComment({
      qualityScore: 8,
      evaluationSummary: "Done.",
      blockApproval: true,
      qualityChecks: [],
    });
    assert.ok(c.includes("⚠️") || c.includes("Block"));
  });

  it("omits block warning when flag is false", () => {
    const c = buildSubmitComment({
      qualityScore: 8,
      evaluationSummary: "Done.",
      blockApproval: false,
      qualityChecks: [],
    });
    assert.ok(!c.includes("⚠️") || !c.includes("block approval flag"));
  });
});
