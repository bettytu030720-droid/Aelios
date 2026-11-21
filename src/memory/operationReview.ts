import { getMemoryById } from "../db/memories";
import type { MemoryCandidateRow } from "../db/v2/candidates";
import { isHandAuthorSource } from "../db/v2/memories";
import { operationApprovalWrite, settleOperationCandidate } from "../db/v2/operationReview";
import type { Env, MemoryRecord, MessageRecord } from "../types";
import { approveCandidate } from "./candidateApproval";
import { classifyDreamOperation } from "./clefJudge";
import { isScopedDecisionRecord } from "./currentState/store";
import { DreamModelTimeoutError, withDreamModelDeadline } from "./dream/modelCall";
import { isExplicitMemory, parseOrigin } from "./provenance";
import type { DreamSpeakers } from "./speakers";

const REVIEW_TIMEOUT_MS = 30_000;
const ACTION_SOURCES = { add: "dream_add", update: "dream_update", archive: "dream_delete" };

function isWritableTarget(memory: MemoryRecord, revision: string): boolean {
  return memory.status === "active" && memory.version_status !== "superseded" && !memory.pinned &&
    memory.updated_at === revision && !isExplicitMemory(memory) && !isHandAuthorSource(memory.source) &&
    !isScopedDecisionRecord(memory);
}

/**
 * A person, or the assistant reviewing for them, can keep an unclassified proposal as a new memory.
 * Nothing existing is updated or archived, so this needs no Clef decision and works with auto-review off.
 */
export async function keepOperationAsNewMemory(
  env: Env,
  candidate: MemoryCandidateRow,
  input: { tags: string[]; sourceIds: string[]; reviewer: string; note: string }
): Promise<string> {
  const source = ACTION_SOURCES.add;
  const write = operationApprovalWrite(env.DB, candidate, { source, target: null, note: input.note });
  return approveCandidate(env, candidate.namespace, {
    ...candidate, source, fact_key: null, target_memory_id: null
  }, input.tags, input.sourceIds, input.reviewer, write);
}

export async function reviewDreamOperation(
  env: Env,
  candidate: MemoryCandidateRow,
  input: { messages: MessageRecord[]; sourceIds: string[]; tags: string[]; speakers: DreamSpeakers | null; judgePrefix: string }
): Promise<"approved" | "discarded" | "kept" | "failed"> {
  const { DB: db } = env;
  const { namespace, id } = candidate;
  const { messages, sourceIds, tags, speakers, judgePrefix } = input;
  const hold = async (note: string, outcome: "kept" | "failed" = "kept") => {
    if (candidate.decision_note !== note) await settleOperationCandidate(db, candidate, { status: "pending", note }).run();
    return outcome;
  };
  if (!messages.length || messages.length !== sourceIds.length) return hold("operation_evidence_missing");
  const proposal = parseOrigin(candidate.provenance)?.proposed_operation;
  if (!proposal) return hold("operation_uncertain");

  const old = proposal.target ? await getMemoryById(db, { namespace, id: proposal.target.id }) : null;
  const writable = Boolean(old && proposal.target && isWritableTarget(old, proposal.target.revision));
  let action: Awaited<ReturnType<typeof classifyDreamOperation>>;
  try {
    action = await withDreamModelDeadline((signal) =>
      classifyDreamOperation(env, candidate, messages, speakers, proposal, old ? { content: old.content, writable } : null, signal),
      REVIEW_TIMEOUT_MS
    );
  } catch (error) {
    console.warn("candidate judge: operation classification failed", { namespace, id, error });
    return hold(error instanceof DreamModelTimeoutError ? "operation_clef_timeout" : "operation_clef_failed", "failed");
  }
  if (action === null) return hold("operation_clef_failed", "failed");
  if (action === "uncertain") return hold("operation_uncertain");
  if (action === "no_op") {
    const result = await settleOperationCandidate(db, candidate, {
      status: "discarded", note: `${judgePrefix}No memory change supported.`
    }).run();
    return result.meta.changes ? "discarded" : "kept";
  }

  const target = action === "add" ? null : old;
  if (action !== "add" && (!target || !writable)) return hold("operation_target_unavailable");
  if (action === "update" && target?.content.trim() === candidate.content.trim()) return hold("operation_uncertain");
  const source = ACTION_SOURCES[action];
  const write = operationApprovalWrite(db, candidate, {
    source, target, note: `${judgePrefix}Classified unfamiliar Dream operation as ${action} based on the cited messages.`
  });
  try {
    await approveCandidate(env, namespace, {
      ...candidate, source, fact_key: null, target_memory_id: target?.id ?? null
    }, tags, sourceIds, "judge", write);
    return "approved";
  } catch (error) {
    console.warn("candidate judge: classified operation write failed", { namespace, id, error });
    return hold("operation_write_failed", "failed");
  }
}
