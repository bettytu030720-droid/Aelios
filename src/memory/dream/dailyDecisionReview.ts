import { getMemoryById } from "../../db/memories";
import { getMessagesByIds } from "../../db/messages";
import { candidateApprovalWrite, settlePendingCandidate } from "../../db/v2/candidateReview";
import type { MemoryCandidateRow } from "../../db/v2/candidates";
import { getActiveMemoryByFactKey } from "../../db/v2/memories";
import type { Env, MessageRecord } from "../../types";
import { askClef, buildClefInput, classifyDreamOperation, CLEF_REVIEW_TIMEOUT_MS } from "../clefJudge";
import { applyScopedDecision, SCOPED_DECISION_SOURCE } from "../currentState/apply";
import { findDecisionConfirmation } from "../currentState/evidence";
import { decisionKey } from "../currentState/scopeKey";
import { getDateRangeForLabel, readDailyCursor } from "../dreamDates";
import { readDreamTimeZone } from "../dreamEnv";
import type { ExtractedMemory } from "../extract";
import { isExplicitMemory, type DailyDecisionProposal, type DreamOperationProposal } from "../provenance";
import { listNightlyInboxBacklog } from "../rolling/nightly";
import type { DreamSpeakers } from "../speakers";
import { readDreamCursorValue } from "./helpers";
import { DreamModelTimeoutError, withDreamModelDeadline } from "./modelCall";
import { formatDateLabel } from "../../utils/time";

export async function isDecisionDayComplete(db: D1Database, namespace: string, dateLabel: string, timeZone: string) {
  const { startIso, endIso } = getDateRangeForLabel(dateLabel, timeZone);
  const cursor = await readDreamCursorValue(db, { namespace, dateLabel });
  return readDailyCursor(cursor, startIso, endIso).done &&
    (await listNightlyInboxBacklog(db, namespace, startIso, endIso, 1)).length === 0;
}

/** A day's decision is reviewed only after that day is over and its extraction is finished. */
export async function isDecisionDayClosed(env: Env, namespace: string, dateLabel: string): Promise<boolean> {
  const timeZone = readDreamTimeZone(env);
  return dateLabel < formatDateLabel(new Date(), timeZone) &&
    isDecisionDayComplete(env.DB, namespace, dateLabel, timeZone);
}

/** Rebuild the decision from its one cited confirmation, or null when that message no longer supports it. */
function confirmedDecision(
  candidate: MemoryCandidateRow, decision: DailyDecisionProposal, messages: MessageRecord[], sourceIds: string[]
): ExtractedMemory | null {
  const [confirmation] = messages;
  const proposal: ExtractedMemory = {
    type: candidate.type, content: candidate.content, confidence: candidate.confidence, importance: candidate.importance,
    tags: [], source_message_ids: sourceIds, attributed_role: "user", evidence_quote: confirmation?.content, decision
  };
  if (!decisionKey(decision.scope_key) || messages.length !== 1 ||
    Date.parse(confirmation.created_at) !== Date.parse(decision.at) ||
    !findDecisionConfirmation(proposal, messages)) return null;
  return proposal;
}

/**
 * Save an approved daily decision as the next version of its subject, in the same batch that
 * marks the candidate approved. A reviewed snapshot that changed in the meantime throws.
 */
async function saveDailyDecision(
  env: Env, candidate: MemoryCandidateRow, proposal: ExtractedMemory, decision: DailyDecisionProposal,
  input: { messages: MessageRecord[]; note: string; actor: string }
): Promise<{ outcome: "approved"; id: string } | { outcome: "superseded" | "protected" }> {
  const write = candidateApprovalWrite(env.DB, candidate, { source: "dream_extract", target: null, note: input.note });
  const result = await applyScopedDecision(env, candidate.namespace, proposal, decision.state_of, {
    review: { id: candidate.id, messages: input.messages, write, actor: input.actor }
  });
  if (!result) return { outcome: "protected" };
  return result.current ? { outcome: "approved", id: result.id } : { outcome: "superseded" };
}

async function judgeDecision(
  env: Env, candidate: MemoryCandidateRow, messages: MessageRecord[], speakers: DreamSpeakers | null,
  operation: DreamOperationProposal | undefined, signal: AbortSignal
): Promise<"approve" | "discard" | "uncertain" | null> {
  if (operation && candidate.fact_key) {
    const current = await getActiveMemoryByFactKey(env.DB, { namespace: candidate.namespace, factKey: candidate.fact_key });
    const old = current && await getMemoryById(env.DB, { namespace: candidate.namespace, id: current.id });
    const writable = Boolean(old && old.status === "active" && old.source === SCOPED_DECISION_SOURCE &&
      !old.pinned && !isExplicitMemory(old));
    const action = await classifyDreamOperation(env, candidate, messages, speakers, operation,
      old ? { content: old.content, writable } : null, signal);
    if (action === null) return null;
    if (action === "add" || (action === "update" && writable)) return "approve";
    return action === "no_op" ? "discard" : "uncertain";
  }
  const result = await askClef(env, buildClefInput("add", candidate, messages, speakers, null), "add", signal);
  return result ? result.grounded && result.durable ? "approve" : "discard" : null;
}

export async function reviewDailyDecision(
  env: Env,
  candidate: MemoryCandidateRow,
  input: {
    decision: DailyDecisionProposal; operation?: DreamOperationProposal; messages: MessageRecord[];
    sourceIds: string[]; speakers: DreamSpeakers | null; judgePrefix: string;
  }
): Promise<"approved" | "discarded" | "kept" | "failed"> {
  const { decision, operation, messages, sourceIds, speakers, judgePrefix } = input;
  const db = env.DB;
  const hold = async (note: string, outcome: "kept" | "failed" = "kept") => {
    if (candidate.decision_note !== note) await settlePendingCandidate(db, candidate, { status: "pending", note }).run();
    return outcome;
  };
  if (decision.ambiguous) return hold("daily_decision_ambiguous");
  const factKey = decisionKey(decision.scope_key);
  const proposal = confirmedDecision(candidate, decision, messages, sourceIds);
  if (!factKey || !proposal) return hold("daily_decision_evidence_missing");
  const discard = async (note: string) => {
    const result = await settlePendingCandidate(db, candidate, { status: "discarded", note: judgePrefix + note }).run();
    return result.meta.changes ? "discarded" : "kept";
  };
  try {
    const verdict = await withDreamModelDeadline(signal =>
      judgeDecision(env, { ...candidate, fact_key: factKey }, messages, speakers, operation, signal),
    CLEF_REVIEW_TIMEOUT_MS);
    if (verdict === null) return hold("daily_decision_review_failed", "failed");
    if (verdict === "uncertain") return hold("daily_decision_uncertain");
    if (verdict === "discard") return discard("Clef found no durable, supported decision to save.");
  } catch (error) {
    console.warn("daily decision: review failed", { namespace: candidate.namespace, id: candidate.id, error });
    return hold(error instanceof DreamModelTimeoutError ? "daily_decision_review_timeout" : "daily_decision_review_failed", "failed");
  }

  try {
    const saved = await saveDailyDecision(env, candidate, proposal, decision, {
      messages, actor: "judge", note: `${judgePrefix}Saved the last confirmed decision of ${decision.date}.`
    });
    if (saved.outcome === "protected") return hold("daily_decision_target_protected");
    return saved.outcome === "approved" ? "approved"
      : discard("This decision was already recorded or superseded by a later confirmation.");
  } catch (error) {
    console.warn("daily decision: write failed", { namespace: candidate.namespace, id: candidate.id, error });
    return hold("daily_decision_write_failed", "failed");
  }
}

export type ManualDailyDecisionResult =
  | { ok: true; status: "approved" | "discarded"; memoryId: string | null }
  | { ok: false; error: string };

/**
 * A person (admin page or MCP) saves or drops a daily decision. Like the nightly review, this waits
 * until the day is over, so a later confirmation that day is not cut off, and an approval becomes
 * the next version of the subject's decision rather than a separate memory.
 */
export async function reviewDailyDecisionByHand(
  env: Env,
  candidate: MemoryCandidateRow,
  decision: DailyDecisionProposal,
  input: { approve: boolean; actor: string; note: string; sourceIds: string[] }
): Promise<ManualDailyDecisionResult> {
  const changed = { ok: false as const, error: "The decision or its cited message changed during review. Reload and try again." };
  if (!await isDecisionDayClosed(env, candidate.namespace, decision.date)) {
    return { ok: false, error: `This is the decision for ${decision.date}. It can be reviewed once that day is over and its Dream run has finished, so a later change that day is not lost.` };
  }
  if (!input.approve) {
    const result = await settlePendingCandidate(env.DB, candidate, { status: "discarded", note: input.note }).run();
    return result.meta.changes ? { ok: true, status: "discarded", memoryId: null } : changed;
  }
  const { sourceIds } = input;
  const messages = sourceIds.length ? await getMessagesByIds(env.DB, { namespace: candidate.namespace, ids: sourceIds }) : [];
  const proposal = confirmedDecision(candidate, decision, messages, sourceIds);
  if (!proposal) return { ok: false, error: "The message that confirmed this decision is no longer available. Discard it instead." };
  try {
    const saved = await saveDailyDecision(env, candidate, proposal, decision, { messages, actor: input.actor, note: input.note });
    if (saved.outcome === "approved") return { ok: true, status: "approved", memoryId: saved.id };
    return { ok: false, error: saved.outcome === "protected"
      ? "The current decision on this subject is pinned or written by hand. Change it on the memory page."
      : "The same or a later decision on this subject is already saved. Discard this one." };
  } catch {
    return changed;
  }
}
