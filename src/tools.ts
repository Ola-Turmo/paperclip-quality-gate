/**
 * Tool registrations for uos-quality-gate.
 * Each function is registered in ctx.tools by setupTools().
 */
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Issue } from "@paperclipai/plugin-sdk";
import type { DeliverableReview, ReviewStatus } from "./types.js";
import {
  buildNewReview,
  buildSubmitComment,
  evaluateQuality,
  mapTargetStatus,
  updateReviewStatus,
} from "./helpers.js";
import { getConfig, getReview, putReview } from "./shared.js";

/**
 * quality_gate_review — agent tool: check review status for an issue.
 */
async function handleQualityGateReview(
  ctx: PluginContext,
  params: unknown,
): Promise<{ content: string }> {
  const p = params as { issue_id: string; include_checks?: boolean };
  const issueId = p.issue_id;
  if (!issueId) {
    return { content: "Error: issue_id is required." };
  }

  const review = await getReview(ctx, issueId);
  if (!review) {
    return { content: `No quality gate review found for issue ${issueId}.` };
  }

  const lines = [
    `## Quality Gate Review — ${issueId}`,
    "",
    `**Status:** ${review.status}`,
    `**Score:** ${review.qualityScore}/10`,
    `**Category:** ${review.category}`,
    `**Submitter:** ${review.submitterName}`,
    "",
    `> ${review.evaluationSummary}`,
    "",
    `Submitted: ${new Date(review.createdAt).toLocaleString()}`,
    `Updated: ${new Date(review.updatedAt).toLocaleString()}`,
  ];

  if (p.include_checks && review.checks.length > 0) {
    lines.push("", "### Quality Checks");
    for (const check of review.checks) {
      const icon = check.passed ? "✅" : "❌";
      lines.push(
        `${icon} **${check.name}** — ${check.details ?? ""} (score: ${check.score})`,
      );
    }
  }

  if (review.history.length > 0) {
    lines.push("", "### History");
    for (const entry of review.history.slice(-5)) {
      lines.push(
        `- ${entry.createdAt.slice(0, 10)} · **${entry.action}** · ${entry.reviewerName}` +
        (entry.comment ? ` — "${entry.comment.slice(0, 80)}"` : ""),
      );
    }
  }

  return { content: lines.join("\n") };
}

/**
 * submit_for_review — agent tool: submit completed work for quality review.
 */
async function handleSubmitForReview(
  ctx: PluginContext,
  params: unknown,
): Promise<{ content: string; error?: string }> {
  const p = params as {
    issue_id: string;
    summary?: string;
    quality_score?: number;
    block_approval?: boolean;
    comment?: string;
  };
  const issueId = p.issue_id;
  if (!issueId) {
    return { content: "Error: issue_id is required.", error: "missing_param" };
  }

  const cfg = await getConfig(ctx);
  let companyId = "";
  try {
    const issue = await ctx.issues.get(issueId, "");
    companyId = issue?.companyId ?? "";
  } catch {
    return { content: `Error: Issue ${issueId} not found.`, error: "not_found" };
  }

  const existingReview = await getReview(ctx, issueId);
  const evaluation = evaluateQuality(p.quality_score, p.block_approval ?? false, cfg);

  let reviewStatus: ReviewStatus = "pending_review";
  if (evaluation.autoRejected) {
    reviewStatus = "auto_rejected";
  } else if (evaluation.blockThresholdBreached) {
    reviewStatus = "needs_human_review";
  }

  let review: DeliverableReview;
  if (existingReview) {
    review = updateReviewStatus(existingReview, reviewStatus, {
      action: "resubmitted",
      reviewer: "user",
      reviewerName: "Agent",
      comment: p.comment,
      qualityScore: evaluation.overallScore,
      auto: false,
    });
  } else {
    review = buildNewReview({
      issueId,
      companyId,
      summary: p.summary,
      qualityScore: evaluation.overallScore,
      blockApproval: p.block_approval,
      reviewerName: "Agent",
      qualityChecks: evaluation.checks,
      evaluationSummary: evaluation.summary,
      category: evaluation.category,
    });
  }

  await putReview(ctx, review);

  const targetStatus = mapTargetStatus(evaluation.category);

  if (companyId && targetStatus) {
    try {
      await ctx.issues.update(
        issueId,
        { status: targetStatus as Issue["status"] },
        companyId,
      );
    } catch (err) {
      ctx.logger.warn("submit_for_review: failed to update issue status", { error: String(err) });
    }
    try {
      await ctx.issues.createComment(
        issueId,
        buildSubmitComment({
          qualityScore: evaluation.overallScore,
          evaluationSummary: evaluation.summary,
          blockApproval: p.block_approval,
          qualityChecks: evaluation.checks,
        }),
        companyId,
      );
    } catch (err) {
      ctx.logger.warn("submit_for_review: failed to post comment", { error: String(err) });
    }
  }

  if (!existingReview) {
    ctx.streams.emit("quality_gate.review_created", { review });
  }
  ctx.streams.emit("quality_gate.review_updated", { review });

  if (evaluation.autoRejected) {
    ctx.streams.emit("quality_gate.threshold_breached", {
      review,
      score: evaluation.overallScore,
      reason: "auto_rejected",
    });
  } else if (evaluation.blockThresholdBreached) {
    ctx.streams.emit("quality_gate.threshold_breached", {
      review,
      score: evaluation.overallScore,
      reason: "block_threshold",
    });
  }

  const emoji = review.status === "auto_rejected" ? "⚠️"
    : review.status === "needs_human_review" ? "🛡️"
    : "✅";

  return {
    content: [
      `${emoji} Quality gate review submitted for issue ${issueId}`,
      "",
      `Status: ${review.status}`,
      `Score: ${review.qualityScore}/10`,
      `Category: ${review.category}`,
      "",
      review.evaluationSummary,
    ].join("\n"),
  };
}

/**
 * Register all quality_gate tools on the plugin context.
 */
export function setupTools(ctx: PluginContext): void {
  ctx.tools.register(
    "quality_gate_review",
    {
      displayName: "Quality Gate — Check Review Status",
      description:
        "Check the quality gate review status for a Paperclip issue. " +
        "Returns the current review state, quality score, check breakdown, " +
        "and audit history. Does not modify any state.",
      parametersSchema: {
        type: "object",
        properties: {
          issue_id: {
            type: "string",
            description: "The Paperclip issue ID to check the review status for.",
          },
          include_checks: {
            type: "boolean",
            description: "If true, includes the full per-check quality breakdown. Default: false.",
            default: false,
          },
        },
        required: ["issue_id"],
      },
    },
    (params) => handleQualityGateReview(ctx, params),
  );

  ctx.tools.register(
    "submit_for_review",
    {
      displayName: "Quality Gate — Submit for Review",
      description:
        "Submit a completed deliverable for quality gate review. " +
        "Runs the quality evaluation, creates or updates the review record, " +
        "and posts a comment on the issue.",
      parametersSchema: {
        type: "object",
        properties: {
          issue_id: {
            type: "string",
            description: "The Paperclip issue ID to submit for review.",
          },
          summary: {
            type: "string",
            description: "Brief summary of what was delivered.",
          },
          quality_score: {
            type: "number",
            description: "Self-assessed quality score from 0–10.",
          },
          block_approval: {
            type: "boolean",
            description: "If true, forces human review regardless of quality score.",
            default: false,
          },
          comment: {
            type: "string",
            description: "Optional comment to attach to the review submission.",
          },
        },
        required: ["issue_id"],
      },
    },
    (params) => handleSubmitForReview(ctx, params),
  );
}
