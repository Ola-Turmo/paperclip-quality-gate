import React, { useEffect, useMemo, useState } from "react";
import { usePluginAction, usePluginData, type PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import type { DeliverableReview } from "../types.js";

interface ReviewStatusData {
  review: DeliverableReview;
  issue?: { id: string; title?: string; status?: string };
}

interface ConfigData {
  minQualityScore: number;
  blockThreshold: number;
  autoRejectBelow: number;
}

function panelStyle(): React.CSSProperties {
  return {
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: 14,
    padding: 16,
    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.25)",
  };
}

function buttonStyle(color: string, disabled?: boolean): React.CSSProperties {
  return {
    padding: "10px 14px",
    borderRadius: 10,
    border: "none",
    background: disabled ? "#334155" : color,
    color: "white",
    fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function textInputStyle(): React.CSSProperties {
  return {
    width: "100%",
    borderRadius: 10,
    border: "1px solid #334155",
    background: "#0f172a",
    color: "#e2e8f0",
    padding: "10px 12px",
    fontSize: 13,
    boxSizing: "border-box",
  };
}

function statusTone(status: DeliverableReview["status"]): { bg: string; fg: string; label: string } {
  switch (status) {
    case "approved":
      return { bg: "rgba(34,197,94,0.15)", fg: "#4ade80", label: "Approved" };
    case "auto_rejected":
      return { bg: "rgba(239,68,68,0.15)", fg: "#f87171", label: "Auto-rejected" };
    case "rejected":
      return { bg: "rgba(248,113,113,0.15)", fg: "#fca5a5", label: "Revision requested" };
    case "escalated":
      return { bg: "rgba(251,191,36,0.15)", fg: "#fbbf24", label: "Escalated" };
    case "needs_human_review":
      return { bg: "rgba(250,204,21,0.15)", fg: "#facc15", label: "Needs human review" };
    default:
      return { bg: "rgba(96,165,250,0.15)", fg: "#60a5fa", label: "Awaiting review" };
  }
}

function releaseTone(state: DeliverableReview["releaseDecision"]["approvalState"]): { bg: string; fg: string; label: string } {
  switch (state) {
    case "released":
      return { bg: "rgba(16,185,129,0.15)", fg: "#34d399", label: "Released" };
    case "approved_hold":
      return { bg: "rgba(59,130,246,0.15)", fg: "#93c5fd", label: "Approved + hold" };
    case "rejected":
      return { bg: "rgba(239,68,68,0.15)", fg: "#fca5a5", label: "Rejected" };
    case "escalated":
      return { bg: "rgba(245,158,11,0.15)", fg: "#f59e0b", label: "Escalated" };
    default:
      return { bg: "rgba(148,163,184,0.15)", fg: "#cbd5e1", label: "Pending" };
  }
}

function formatDate(value: string): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function scoreColor(score: number): string {
  if (score >= 7) return "#22c55e";
  if (score >= 5) return "#f59e0b";
  return "#ef4444";
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div style={{ ...panelStyle(), minWidth: 0 }}>
      <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: "#f8fafc" }}>{value}</div>
      {hint ? <div style={{ fontSize: 12, color: "#64748b", marginTop: 4 }}>{hint}</div> : null}
    </div>
  );
}

function Chip({ label, bg, fg }: { label: string; bg: string; fg: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 10px", borderRadius: 999, background: bg, color: fg, fontSize: 12, fontWeight: 700 }}>
      {label}
    </span>
  );
}

export function QualityGateTab({ context }: PluginDetailTabProps) {
  const issueId = context.entityId;
  const reviewQuery = usePluginData<ReviewStatusData>("quality_gate.review", { issueId });
  const configQuery = usePluginData<ConfigData>("quality_gate.config", {});

  const submitAction = usePluginAction("quality_gate.submit");
  const approveAction = usePluginAction("quality_gate.approve");
  const approveHoldAction = usePluginAction("quality_gate.approve_hold");
  const rejectAction = usePluginAction("quality_gate.reject");
  const assignAction = usePluginAction("quality_gate.assign");
  const returnAction = usePluginAction("quality_gate.return_to_agent");
  const escalateAction = usePluginAction("quality_gate.escalate");
  const nextStepAction = usePluginAction("quality_gate.generate_next_step");

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [operatorNote, setOperatorNote] = useState("");
  const [summaryInput, setSummaryInput] = useState("");
  const [qualityScoreInput, setQualityScoreInput] = useState("8");
  const [assignInput, setAssignInput] = useState("");
  const [returnInstruction, setReturnInstruction] = useState("");
  const [returnAgent, setReturnAgent] = useState("");
  const [escalateNote, setEscalateNote] = useState("");
  const [escalateTo, setEscalateTo] = useState("");
  const [nextStepDraft, setNextStepDraft] = useState("");

  const review = reviewQuery.data?.review;
  const issue = reviewQuery.data?.issue;
  const config = configQuery.data;

  useEffect(() => {
    if (review) {
      setNextStepDraft(review.nextStepTemplate);
      setAssignInput(review.assignedTo ?? "");
      setReturnAgent(review.handoffTask.targetAgentId ?? "");
      setReturnInstruction(review.handoffTask.instructionMd || "");
    }
  }, [review?.id, review?.updatedAt]);

  const statusChip = review ? statusTone(review.status) : statusTone("pending_review");
  const releaseChip = review ? releaseTone(review.releaseDecision.approvalState) : releaseTone("pending");

  const confidence = review?.draftArtifact.confidence ?? 0;
  const confidenceLabel = useMemo(() => {
    if (confidence >= 80) return "High confidence";
    if (confidence >= 60) return "Moderate confidence";
    return "Needs scrutiny";
  }, [confidence]);

  async function runAction(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      const payload = result as { ok?: boolean; error?: string; message?: string; template?: string };
      if (payload && payload.ok === false) {
        setError(payload.error ?? "Action failed.");
      } else {
        if (payload?.template) setNextStepDraft(payload.template);
        setMessage(payload?.message ?? success);
        await Promise.all([reviewQuery.refresh(), configQuery.refresh()]);
      }
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(false);
    }
  }

  if (reviewQuery.loading && !reviewQuery.data) {
    return <div style={{ padding: 24, color: "#cbd5e1", fontFamily: "system-ui" }}>Loading quality gate…</div>;
  }

  return (
    <div style={{ padding: 24, minHeight: "100%", background: "linear-gradient(180deg, #020617 0%, #0f172a 100%)", color: "#e2e8f0", fontFamily: "Inter, system-ui, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", marginBottom: 18, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 12, letterSpacing: 1.2, textTransform: "uppercase", color: "#38bdf8", fontWeight: 700 }}>Evidence-centric review cockpit</div>
          <h2 style={{ margin: "6px 0 8px", fontSize: 28, lineHeight: 1.1 }}>{issue?.title ?? `Issue ${issueId}`}</h2>
          <div style={{ color: "#94a3b8", fontSize: 13 }}>Issue ID: <code>{issueId}</code>{issue?.status ? ` · Host status: ${issue.status}` : ""}</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Chip label={statusChip.label} bg={statusChip.bg} fg={statusChip.fg} />
          <Chip label={releaseChip.label} bg={releaseChip.bg} fg={releaseChip.fg} />
          <Chip label={confidenceLabel} bg="rgba(148,163,184,0.15)" fg="#e2e8f0" />
        </div>
      </div>

      {error ? <div style={{ ...panelStyle(), borderColor: "rgba(248,113,113,0.4)", color: "#fecaca", marginBottom: 16 }}>{error}</div> : null}
      {message ? <div style={{ ...panelStyle(), borderColor: "rgba(74,222,128,0.4)", color: "#bbf7d0", marginBottom: 16 }}>{message}</div> : null}

      {!review ? (
        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "1.2fr 0.8fr" }}>
          <div style={panelStyle()}>
            <h3 style={{ marginTop: 0 }}>Create the first review package</h3>
            <p style={{ color: "#94a3b8", fontSize: 14 }}>Turn this issue into an evidence bundle with a draft artifact, risk flags, and next-step guidance.</p>
            <div style={{ display: "grid", gap: 12 }}>
              <textarea value={summaryInput} onChange={(event) => setSummaryInput(event.target.value)} rows={6} placeholder="Summarize the deliverable or current draft…" style={textInputStyle()} />
              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "160px 1fr" }}>
                <input value={qualityScoreInput} onChange={(event) => setQualityScoreInput(event.target.value)} placeholder="8" style={textInputStyle()} />
                <input value={operatorNote} onChange={(event) => setOperatorNote(event.target.value)} placeholder="Optional operator note…" style={textInputStyle()} />
              </div>
              <button
                disabled={busy}
                onClick={() => runAction(() => submitAction({ issue_id: issueId, summary: summaryInput, quality_score: Number(qualityScoreInput || 0), comment: operatorNote }), "Review package created.")}
                style={buttonStyle("#2563eb", busy)}
              >
                {busy ? "Submitting…" : "Create review package"}
              </button>
            </div>
          </div>
          <div style={panelStyle()}>
            <h3 style={{ marginTop: 0 }}>What gets created</h3>
            <ul style={{ color: "#cbd5e1", lineHeight: 1.7, paddingLeft: 18 }}>
              <li>Evidence hash + issue-linked markdown evidence document</li>
              <li>Draft artifact with confidence and revision tracking</li>
              <li>Risk cards derived from thresholds and failed checks</li>
              <li>Operator next-step template for revision, follow-up, or release</li>
            </ul>
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <MetricCard label="Display score" value={`${review.qualityScore}/10`} hint={`Rendered score (${scoreColor(review.qualityScore)})`} />
            <MetricCard label="Decision score" value={`${review.decisionScore}/10`} hint="Thresholds operate on this score." />
            <MetricCard label="Confidence" value={`${review.draftArtifact.confidence}%`} hint={`${review.riskFlags.length} active risk flag(s)`} />
            <MetricCard label="Evidence hash" value={review.evidenceBundle.hash} hint="Stored in issue documents for audit." />
          </div>

          <div style={{ ...panelStyle(), display: "grid", gap: 14 }}>
            <div>
              <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, letterSpacing: 1.1, textTransform: "uppercase" }}>Reviewer summary</div>
              <h3 style={{ margin: "6px 0" }}>{review.reviewSummary.headline}</h3>
              <div style={{ color: "#94a3b8", fontSize: 14 }}>{review.reviewSummary.disposition} · {review.reviewSummary.reviewerHint}</div>
            </div>

            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1.3fr 1fr" }}>
              <div style={{ display: "grid", gap: 12 }}>
                <div style={panelStyle()}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 10 }}>
                    <div>
                      <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, textTransform: "uppercase" }}>Draft artifact</div>
                      <h4 style={{ margin: "4px 0 0" }}>{review.draftArtifact.title}</h4>
                    </div>
                    <div style={{ color: scoreColor(review.qualityScore), fontWeight: 700 }}>{review.draftArtifact.confidence}% confident</div>
                  </div>
                  <div style={{ whiteSpace: "pre-wrap", color: "#e2e8f0", lineHeight: 1.6 }}>{review.draftArtifact.bodyMd}</div>
                </div>

                <div style={panelStyle()}>
                  <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Operator action bar</div>
                  <div style={{ display: "grid", gap: 10 }}>
                    <textarea value={operatorNote} onChange={(event) => setOperatorNote(event.target.value)} rows={4} placeholder="Reviewer note for approvals or revisions…" style={textInputStyle()} />
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                      <button disabled={busy} onClick={() => runAction(() => approveHoldAction({ issue_id: issueId, comment: operatorNote }), "Approved and held.")} style={buttonStyle("#0284c7", busy)}>Approve</button>
                      <button disabled={busy} onClick={() => runAction(() => approveAction({ issue_id: issueId, comment: operatorNote }), "Approved and released.")} style={buttonStyle("#16a34a", busy)}>Approve &amp; Release</button>
                      <button disabled={busy} onClick={() => runAction(() => rejectAction({ issue_id: issueId, comment: operatorNote || "Revise this deliverable using the evidence package." }), "Revision requested.")} style={buttonStyle("#dc2626", busy)}>Request revision</button>
                    </div>
                  </div>
                </div>

                <div style={panelStyle()}>
                  <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Next-step template</div>
                  <textarea value={nextStepDraft} onChange={(event) => setNextStepDraft(event.target.value)} rows={12} style={textInputStyle()} />
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                    <button disabled={busy} onClick={() => runAction(() => nextStepAction({ issue_id: issueId, goal: "revision" }), "Revision template refreshed.")} style={buttonStyle("#475569", busy)}>Refresh revision template</button>
                    <button disabled={busy} onClick={() => runAction(() => nextStepAction({ issue_id: issueId, goal: "release" }), "Release template refreshed.")} style={buttonStyle("#475569", busy)}>Refresh release template</button>
                  </div>
                </div>
              </div>

              <div style={{ display: "grid", gap: 12 }}>
                <div style={panelStyle()}>
                  <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Risk flags</div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {review.riskFlags.length > 0 ? review.riskFlags.map((flag) => (
                      <div key={flag.id} style={{ border: "1px solid #1e293b", borderRadius: 12, padding: 12, background: "#020617" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                          <strong>{flag.label}</strong>
                          <span style={{ textTransform: "uppercase", fontSize: 11, color: flag.level === "critical" ? "#f87171" : flag.level === "high" ? "#fb7185" : flag.level === "medium" ? "#facc15" : "#93c5fd" }}>{flag.level}</span>
                        </div>
                        <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 6 }}>{flag.detail}</div>
                      </div>
                    )) : <div style={{ color: "#94a3b8" }}>No active risk flags.</div>}
                  </div>
                </div>

                <div style={panelStyle()}>
                  <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Evidence bundle</div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {review.evidenceBundle.inputRefs.concat(review.evidenceBundle.retrievedContext).map((ref) => (
                      <div key={ref.id} style={{ borderBottom: "1px solid #1e293b", paddingBottom: 8 }}>
                        <div style={{ color: "#e2e8f0", fontWeight: 600 }}>{ref.label}</div>
                        <div style={{ color: "#94a3b8", fontSize: 12, textTransform: "uppercase" }}>{ref.kind}</div>
                        <div style={{ color: "#cbd5e1", fontSize: 13, marginTop: 4, whiteSpace: "pre-wrap" }}>{ref.value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                <div style={panelStyle()}>
                  <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Trace & standards</div>
                  <div style={{ color: "#cbd5e1", fontSize: 13, lineHeight: 1.7 }}>
                    <strong>Standards</strong>
                    <ul>
                      {review.evidenceBundle.standards.map((standard) => <li key={standard}>{standard}</li>)}
                    </ul>
                    <strong>Trace</strong>
                    <ul>
                      {review.evidenceBundle.trace.map((step) => <li key={`${step.label}-${step.value}`}>{step.label}: {step.value}</li>)}
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr" }}>
            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Return to agent</div>
              <div style={{ display: "grid", gap: 10 }}>
                <input value={returnAgent} onChange={(event) => setReturnAgent(event.target.value)} placeholder="Optional Paperclip agent ID…" style={textInputStyle()} />
                <textarea value={returnInstruction} onChange={(event) => setReturnInstruction(event.target.value)} rows={6} placeholder="Revision instruction for the responsible agent…" style={textInputStyle()} />
                <button disabled={busy} onClick={() => runAction(() => returnAction({ issue_id: issueId, target_agent_id: returnAgent || undefined, instruction: returnInstruction || nextStepDraft }), "Returned to agent.")} style={buttonStyle("#7c3aed", busy)}>Return to agent</button>
              </div>
            </div>

            <div style={panelStyle()}>
              <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Escalation & assignment</div>
              <div style={{ display: "grid", gap: 10 }}>
                <input value={assignInput} onChange={(event) => setAssignInput(event.target.value)} placeholder="Assign reviewer…" style={textInputStyle()} />
                <button disabled={busy || !assignInput.trim()} onClick={() => runAction(() => assignAction({ issue_id: issueId, assigned_to: assignInput.trim() }), `Assigned to ${assignInput.trim()}.`)} style={buttonStyle("#6366f1", busy || !assignInput.trim())}>Assign reviewer</button>
                <input value={escalateTo} onChange={(event) => setEscalateTo(event.target.value)} placeholder="Escalate to…" style={textInputStyle()} />
                <textarea value={escalateNote} onChange={(event) => setEscalateNote(event.target.value)} rows={4} placeholder="Why this needs a higher-scope review…" style={textInputStyle()} />
                <button disabled={busy || !escalateNote.trim()} onClick={() => runAction(() => escalateAction({ issue_id: issueId, comment: escalateNote, escalate_to: escalateTo || undefined }), "Escalated for review.")} style={buttonStyle("#f59e0b", busy || !escalateNote.trim())}>Escalate</button>
              </div>
            </div>
          </div>

          <div style={panelStyle()}>
            <div style={{ fontSize: 12, color: "#38bdf8", fontWeight: 700, textTransform: "uppercase", marginBottom: 10 }}>Timeline</div>
            <div style={{ display: "grid", gap: 10 }}>
              {[...review.history].reverse().map((entry, index) => (
                <div key={`${entry.action}-${entry.createdAt}-${index}`} style={{ display: "grid", gap: 4, paddingBottom: 10, borderBottom: "1px solid #1e293b" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                    <strong>{entry.action}</strong>
                    <span style={{ color: "#94a3b8", fontSize: 12 }}>{entry.reviewerName} · {formatDate(entry.createdAt)}</span>
                  </div>
                  {entry.comment ? <div style={{ color: "#cbd5e1", fontSize: 13, whiteSpace: "pre-wrap" }}>{entry.comment}</div> : null}
                </div>
              ))}
            </div>
          </div>

          {config ? (
            <div style={{ ...panelStyle(), color: "#94a3b8", fontSize: 13 }}>
              Thresholds · min pass <strong style={{ color: "#e2e8f0" }}>{config.minQualityScore}</strong> · human review ≤ <strong style={{ color: "#e2e8f0" }}>{config.blockThreshold}</strong> · auto-reject &lt; <strong style={{ color: "#e2e8f0" }}>{config.autoRejectBelow}</strong>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default QualityGateTab;
