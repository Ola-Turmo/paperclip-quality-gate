import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  buildNextStepTemplate,
  buildSubmitComment,
  evaluateQuality,
} from "./helpers.js";
import {
  getConfig,
  getIssueSnapshot,
  getReview,
  persistReviewArtifacts,
  putReview,
} from "./shared.js";
import { applyEvaluationToReview, buildNewReview } from "./helpers.js";

async function handleQualityGateReview(
  ctx: PluginContext,
  params: unknown,
): Promise<{ content: string }> {
  const p = params as { issue_id: string; include_checks?: boolean };
  if (!p.issue_id) {
    return { content: "Error: issue_id is required." };
  }

  const review = await getReview(ctx, p.issue_id);
  if (!review) {
    return { content: `No quality gate review found for issue ${p.issue_id}.` };
  }

  const lines = [
    `## Quality Gate Review — ${review.issueId}`,
    "",
    `**Status:** ${review.status}`,
    `**Release state:** ${review.releaseDecision.approvalState}`,
    `**Display score:** ${review.qualityScore}/10`,
    `**Decision score:** ${review.decisionScore}/10`,
    `**Evidence hash:** ${review.evidenceBundle.hash}`,
    `**Assigned reviewer:** ${review.assignedTo ?? "Unassigned"}`,
    `**Summary:** ${review.reviewSummary.headline}`,
    "",
    review.evaluationSummary,
    "",
    "### Risks",
    ...(review.riskFlags.length > 0
      ? review.riskFlags.map(
          (flag) => `- [${flag.level}] ${flag.label}: ${flag.detail}`,
        )
      : ["- No active risks flagged."]),
  ];

  if (p.include_checks) {
    lines.push("", "### Checks");
    for (const check of review.checks) {
      lines.push(
        `- ${check.passed ? "✅" : "❌"} ${check.name} — ${check.details ?? ""} (score ${check.score})`,
      );
    }
    lines.push("", "### Trace");
    for (const step of review.evidenceBundle.trace) {
      lines.push(`- ${step.label}: ${step.value}`);
    }
    lines.push("", "### Next step");
    lines.push(review.nextStepTemplate);
  }

  return { content: lines.join("\n") };
}

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
  if (!p.issue_id) {
    return { content: "Error: issue_id is required.", error: "missing_param" };
  }

  try {
    const config = await getConfig(ctx);
    const { companyId, issueData } = await getIssueSnapshot(ctx, p.issue_id);
    const evaluation = evaluateQuality(
      p.quality_score,
      p.block_approval ?? false,
      config,
      issueData,
    );
    const existingReview = await getReview(ctx, p.issue_id);
    const review = existingReview
      ? applyEvaluationToReview(existingReview, {
          summary: p.summary,
          comment: p.comment,
          evaluation,
          reviewerName: "Agent",
          issueData,
          blockApproval: p.block_approval,
          trigger: {
            source: "tool_submit",
            actorLabel: "Agent Tool",
            summary: p.summary,
            createdAt: new Date().toISOString(),
          },
        })
      : buildNewReview({
          issueId: p.issue_id,
          companyId,
          summary: p.summary,
          comment: p.comment,
          qualityScore: p.quality_score,
          blockApproval: p.block_approval,
          reviewerName: "Agent",
          issueData,
          evaluation,
          trigger: {
            source: "tool_submit",
            actorLabel: "Agent Tool",
            summary: p.summary,
            createdAt: new Date().toISOString(),
          },
        });

    review.nextStepTemplate = buildNextStepTemplate(review);
    await putReview(ctx, review);
    await persistReviewArtifacts(ctx, review);

    if (review.companyId) {
      try {
        await ctx.issues.createComment(
          review.issueId,
          buildSubmitComment(review),
          review.companyId,
        );
      } catch {
        // non-fatal
      }
    }

    const emoji =
      review.status === "auto_rejected"
        ? "⚠️"
        : review.status === "needs_human_review"
          ? "🛡️"
          : "✅";

    return {
      content: [
        `${emoji} Quality gate review submitted for issue ${review.issueId}`,
        "",
        `Status: ${review.status}`,
        `Release state: ${review.releaseDecision.approvalState}`,
        `Display score: ${review.qualityScore}/10`,
        `Decision score: ${review.decisionScore}/10`,
        `Evidence hash: ${review.evidenceBundle.hash}`,
        "",
        review.evaluationSummary,
      ].join("\n"),
    };
  } catch (error) {
    return {
      content: `Error submitting ${p.issue_id} for review: ${error instanceof Error ? error.message : String(error)}`,
      error: "submit_failed",
    };
  }
}

export function setupTools(ctx: PluginContext): void {
  ctx.tools.register(
    "quality_gate_review",
    {
      displayName: "Quality Gate — Check Review Status",
      description:
        "Check the quality gate review package for a Paperclip issue. Returns status, scores, risks, and optional detailed evidence/check data.",
      parametersSchema: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "Paperclip issue ID." },
          include_checks: {
            type: "boolean",
            description: "Include full checks and trace output.",
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
        "Submit a completed deliverable for quality review and create/update the evidence package for the issue.",
      parametersSchema: {
        type: "object",
        properties: {
          issue_id: { type: "string", description: "Paperclip issue ID." },
          summary: {
            type: "string",
            description: "Brief summary of the deliverable.",
          },
          quality_score: {
            type: "number",
            description: "Self-assessed quality score from 0–10.",
          },
          block_approval: {
            type: "boolean",
            description: "Force a human review hold.",
            default: false,
          },
          comment: { type: "string", description: "Optional operator note." },
        },
        required: ["issue_id"],
      },
    },
    (params) => handleSubmitForReview(ctx, params),
  );
}
