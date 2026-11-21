import { createMemoryCandidate } from "../../db/v2/candidates";
import type { Env, MessageRecord } from "../../types";
import { formatDateLabel } from "../../utils/time";
import { findDecisionConfirmation } from "../currentState/evidence";
import { readDreamTimeZone } from "../dreamEnv";
import type { ExtractedMemory } from "../extract";
import { dreamOrigin, type DreamOperationProposal, UNCLASSIFIED_DREAM_SOURCE } from "../provenance";

/** Accumulate one pending decision per scope and calendar day, citing only the latest confirmation. */
export async function queueDailyDecision(
  env: Env,
  namespace: string,
  candidate: ExtractedMemory,
  messages: readonly MessageRecord[],
  options: { guard?: D1PreparedStatement; recallIds?: string[]; windowKey?: string; operation?: DreamOperationProposal } = {}
) {
  if (!candidate.decision || !candidate.evidence_quote) return null;
  const message = findDecisionConfirmation(candidate, messages);
  const timestamp = message ? Date.parse(message.created_at) : NaN;
  if (!message || message.namespace !== namespace || !Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  const sourceIds = [message.id];
  const { recallIds, windowKey, operation } = options;
  return createMemoryCandidate(env.DB, {
    namespace,
    type: candidate.type,
    content: candidate.content,
    confidence: candidate.confidence,
    importance: candidate.importance,
    tags: candidate.tags,
    source: operation ? UNCLASSIFIED_DREAM_SOURCE : "dream_extract",
    sourceMessageIds: sourceIds,
    provenance: {
      ...dreamOrigin(sourceIds, { messages: messages.map(item => item.id), memories: recallIds }),
      ...(windowKey ? { recording_actor: "rolling_dream", rolling_window_key: windowKey } : {}),
      attributed_actor: "user",
      evidence_relation: "paraphrase",
      ...(operation ? { proposed_operation: operation } : {}),
      daily_decision: {
        ...candidate.decision,
        state_of: candidate.decision.state_of.filter(id => recallIds?.includes(id)),
        date: formatDateLabel(date, readDreamTimeZone(env)),
        at: date.toISOString()
      }
    }
  }, options.guard);
}

export async function listPendingDecisionScopes(db: D1Database, namespace: string): Promise<string[]> {
  const result = await db.prepare(`SELECT DISTINCT json_extract(
      CASE WHEN json_valid(provenance) THEN provenance END,'$.daily_decision.scope_key') AS scope
    FROM (SELECT provenance,type FROM memory_candidates WHERE namespace=? AND status='pending'
      ORDER BY created_at DESC LIMIT 128)
    WHERE type='decision' AND scope IS NOT NULL LIMIT 64`).bind(namespace).all<{ scope: string }>();
  return result.results.map(row => row.scope);
}
