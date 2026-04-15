import { describe, it } from "node:test";
import assert from "node:assert";

// ── Helpers (pure — no imports needed) ───────────────────────────────────────

function djb2(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
  }
  return Math.abs(hash);
}

function evaluateQuality(score, blockApproval, config) {
  const base = score ?? 0;
  let category;
  let autoRejected = false;
  let blockThresholdBreached = false;
  let passed = false;

  if (score === undefined || score === null) {
    category = "none";
  } else if (score < config.autoRejectBelow) {
    category = "auto_rejected";
    autoRejected = true;
  } else if (blockApproval || score <= config.blockThreshold) {
    category = "needs_human_review";
    blockThresholdBreached = true;
  } else if (score >= config.minQualityScore) {
    category = "passed";
    passed = true;
  } else {
    category = "needs_human_review";
    blockThresholdBreached = true;
  }

  const variant = (djb2(category + String(score)) % 3) - 1;
  const overallScore = Math.max(0, Math.min(10, base + variant));

  return { overallScore, category, autoRejected, blockThresholdBreached, passed };
}

function mapTargetStatus(category) {
  switch (category) {
    case "passed":
    case "needs_human_review": return "in_review";
    case "auto_rejected":
    case "rejected":           return "in_progress";
    case "blocked":            return "blocked";
    default:                   return null;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  minQualityScore: 7,
  blockThreshold: 5,
  autoRejectBelow: 4,
};

describe("evaluateQuality", () => {

  it("score 8 → passed (above minQualityScore)", () => {
    const r = evaluateQuality(8, false, DEFAULT_CONFIG);
    assert.strictEqual(r.category, "passed");
    assert.strictEqual(r.passed, true);
    assert.strictEqual(r.autoRejected, false);
    assert.strictEqual(r.blockThresholdBreached, false);
  });

  it("score 7 → passed (exactly at minQualityScore)", () => {
    const r = evaluateQuality(7, false, DEFAULT_CONFIG);
    assert.strictEqual(r.category, "passed");
    assert.strictEqual(r.passed, true);
  });

  it("score 6 → needs_human_review (between blockThreshold and minQualityScore)", () => {
    const r = evaluateQuality(6, false, DEFAULT_CONFIG);
    assert.strictEqual(r.category, "needs_human_review");
    assert.strictEqual(r.blockThresholdBreached, true);
  });

  it("score 5 → needs_human_review (exactly at blockThreshold)", () => {
    const r = evaluateQuality(5, false, DEFAULT_CONFIG);
    assert.strictEqual(r.category, "needs_human_review");
    assert.strictEqual(r.blockThresholdBreached, true);
  });

  it("score 3 → auto_rejected (below autoRejectBelow)", () => {
    const r = evaluateQuality(3, false, DEFAULT_CONFIG);
    assert.strictEqual(r.category, "auto_rejected");
  });

  it("score 2 → auto_rejected (below autoRejectBelow)", () => {
    const r = evaluateQuality(2, false, DEFAULT_CONFIG);
    assert.strictEqual(r.category, "auto_rejected");
    assert.strictEqual(r.autoRejected, true);
  });

  it("score 0 → auto_rejected", () => {
    const r = evaluateQuality(0, false, DEFAULT_CONFIG);
    assert.strictEqual(r.category, "auto_rejected");
  });

  it("no score (undefined) → none", () => {
    const r = evaluateQuality(undefined, false, DEFAULT_CONFIG);
    assert.strictEqual(r.category, "none");
  });

  it("block_approval=true → needs_human_review regardless of score", () => {
    const r = evaluateQuality(9, true, DEFAULT_CONFIG);
    assert.strictEqual(r.category, "needs_human_review");
    assert.strictEqual(r.blockThresholdBreached, true);
  });

  it("deterministic: same inputs → same outputs", () => {
    const r1 = evaluateQuality(7, false, DEFAULT_CONFIG);
    const r2 = evaluateQuality(7, false, DEFAULT_CONFIG);
    assert.strictEqual(r1.overallScore, r2.overallScore);
    assert.strictEqual(r1.category, r2.category);
  });

  it("score is clamped to 0-10", () => {
    const rHigh = evaluateQuality(15, false, DEFAULT_CONFIG);
    assert.ok(rHigh.overallScore <= 10);
    const rLow = evaluateQuality(-5, false, DEFAULT_CONFIG);
    assert.ok(rLow.overallScore >= 0);
  });

  it("variant ±1 from base score", () => {
    // Run many times and check variance is always ±1
    for (let score = 0; score <= 10; score++) {
      const r = evaluateQuality(score, false, DEFAULT_CONFIG);
      assert.ok(
        Math.abs(r.overallScore - score) <= 1,
        `score=${score}: overallScore=${r.overallScore} differs by more than ±1`,
      );
    }
  });
});

describe("mapTargetStatus", () => {
  it("passed → in_review", () => {
    assert.strictEqual(mapTargetStatus("passed"), "in_review");
  });
  it("needs_human_review → in_review", () => {
    assert.strictEqual(mapTargetStatus("needs_human_review"), "in_review");
  });
  it("auto_rejected → in_progress", () => {
    assert.strictEqual(mapTargetStatus("auto_rejected"), "in_progress");
  });
  it("rejected → in_progress", () => {
    assert.strictEqual(mapTargetStatus("rejected"), "in_progress");
  });
  it("blocked → blocked", () => {
    assert.strictEqual(mapTargetStatus("blocked"), "blocked");
  });
  it("none → null", () => {
    assert.strictEqual(mapTargetStatus("none"), null);
  });
});

describe("djb2", () => {
  it("deterministic: same string → same hash", () => {
    const h1 = djb2("hello");
    const h2 = djb2("hello");
    assert.strictEqual(h1, h2);
  });

  it("different strings → different hashes (probabilistically)", () => {
    const h1 = djb2("hello");
    const h2 = djb2("world");
    assert.notStrictEqual(h1, h2);
  });
});
