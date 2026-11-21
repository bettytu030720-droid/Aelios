import { getMemoryById } from "../../db/memories";
import { candidateApprovalWrite, settlePendingCandidate } from "../../db/v2/candidateReview";
import type { MemoryCandidateRow } from "../../db/v2/candidates";
import { getActiveMemoryByFactKey } from "../../db/v2/memories";
import type { Env, MessageRecord } from "../../types";
import { askClef, buildClefInput, classifyDreamOperation, CLEF_REVIEW_TIMEOUT_MS } from "../clefJudge";
import { applyScopedDecision, SCOPED_DECISION_SOURCE } from "../currentState/apply";
import { findDecisionConfirmation } from "../currentState/evidence";
import { decisionKey } from "../currentState/scopeKey";
import { getDateRangeForLabel, readDailyCursor } from "../dreamDates";
import type { ExtractedMemory } from "../extract";
import { isExplicitMemory, type DailyDecisionProposal, type DreamOperationProposal } from "../provenance";
import { listNightlyInboxBacklog } from "../rolling/nightly";
import type { DreamSpeakers } from "../speakers";
import { readDreamCursorValue } from "./helpers";
import { DreamModelTimeoutError, withDreamModelDeadline } from "./modelCall";

export async function isDecisionDayComplete(db: D1Database, namespace: string, dateLabel: string, timeZone: string) {
  const { startIso, endIso } = getDateRangeForLabel(dateLabel, timeZone);
  const cursor = await readDreamCursorValue(db, { namespace, dateLabel });
  return readDailyCursor(cursor, startIso, endIso).done &&
    (await listNightlyInboxBacklog(db, namespace, startIso, endIso, 1)).length === 0;
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
  const [confirmation] = messages;
  const proposal: ExtractedMemory = {
    type: candidate.type, content: candidate.content, confidence: candidate.confidence, importance: candidate.importance,
    tags: [], source_message_ids: sourceIds, attributed_role: "user", evidence_quote: confirmation?.content, decision
  };
  if (!factKey || messages.length !== 1 || Date.parse(confirmation.created_at) !== Date.parse(decision.at) ||
    !findDecisionConfirmation(proposal, messages)) return hold("daily_decision_evidence_missing");
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

  const write = candidateApprovalWrite(db, candidate, {
    source: "dream_extract", target: null, note: `${judgePrefix}Saved the last confirmed decision of ${decision.date}.`
  });
  try {
    const result = await applyScopedDecision(env, candidate.namespace, proposal, decision.state_of, {
      review: { id: candidate.id, messages, write }
    });
    if (!result) return hold("daily_decision_target_protected");
    return result.current ? "approved" : discard("This decision was already recorded or superseded by a later confirmation.");
  } catch (error) {
    console.warn("daily decision: write failed", { namespace: candidate.namespace, id: candidate.id, error });
    return hold("daily_decision_write_failed", "failed");
  }
}
