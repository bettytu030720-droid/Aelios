import { createMemoryCandidate } from "../../db/v2";
import type { Env } from "../../types";
import { formatDateLabel } from "../../utils/time";
import { queueDailyDecision } from "../dream/dailyDecisions";
import { readDreamTimeZone } from "../dreamEnv";
import { dreamOrigin, type MemoryProvenance, parseOrigin, UNCLASSIFIED_DREAM_SOURCE } from "../provenance";
import type { GroundedWindowEvent } from "./apply";
import { assertRollingLease, finishRollingWindow, loadRollingDrafts, type RollingDraft } from "./checkpoint";
import { episodeMemory, extendDreamCandidate, findEpisodeCandidate, writableTarget } from "./episodes";
import type { RollingClaim } from "./inbox";
import type { RollingWrites } from "./progress";
import { rollingSettings } from "./settings";
import { applyStateDelta, loadRollingState } from "./state";

interface AppliedEvent {
  candidateId?: string;
  write?: { kind: keyof RollingWrites; id: string };
}

async function applyEvent(
  env: Env, claim: RollingClaim, draft: RollingDraft, event: GroundedWindowEvent
): Promise<AppliedEvent | null> {
  const { namespace, rows } = claim;
  const db = env.DB;
  const seen = rows.map(row => row.id);
  const cited = event.source_message_ids;
  const guard = assertRollingLease(db, claim);
  const candidate = {
    type: event.type, content: event.content, tags: [], confidence: 0.8, importance: 0.6,
    source_message_ids: cited, attributed_role: event.attributed_role, evidence_quote: event.evidence_quote,
    decision: event.decision
  };
  const operation = event.op === "unclassified" && event.reported_op ? {
    reported_op: event.reported_op,
    ...(event.target_memory_id && event.target_revision
      ? { target: { id: event.target_memory_id, revision: event.target_revision } } : {})
  } : undefined;
  const daily = event.decision ? await queueDailyDecision(env, namespace, candidate, rows, {
    guard, recallIds: draft.recall_ids, windowKey: claim.key, operation
  }) : null;
  if (daily) return parseOrigin(daily.provenance)?.rolling_window_key === claim.key
    ? { candidateId: daily.id, write: { kind: "candidates", id: daily.id } } : null;

  const latest = Math.max(...rows.filter(row => cited.includes(row.id)).map(row => Date.parse(row.created_at)));
  const date = Number.isFinite(latest) ? formatDateLabel(new Date(latest), readDreamTimeZone(env)) : undefined;
  const episode = date && event.episode_key && event.op !== "unclassified"
    ? { episode_key: event.episode_key, episode_date: date } : {};
  let target = event.target_memory_id && event.op === "update" ? await writableTarget(db, namespace, event.target_memory_id) : null;
  if (event.op === "update" && !target) return null;
  const originFor = (targetId?: string): MemoryProvenance => ({
    ...dreamOrigin(cited, { messages: seen, memories: draft.recall_ids, target: targetId }),
    ...episode,
    recording_actor: "rolling_dream",
    rolling_window_key: claim.key,
    attributed_actor: event.attributed_role ?? "unknown",
    evidence_relation: "paraphrase",
    ...(operation ? { proposed_operation: operation } : {})
  });
  if (date && event.episode_key && event.op === "continuation") {
    const prior = await findEpisodeCandidate(db, namespace, event.episode_key, date);
    if (prior?.status === "pending") {
      const current = await extendDreamCandidate(db, prior, {
        content: event.content, sources: cited, origin: originFor(prior.target_memory_id ?? undefined), guard
      });
      if (!current) throw new Error("Pending episode changed during the rolling commit");
      // A resumed commit sees its own evidence marker even when the continuation is already covered.
      const written = current === "updated" || parseOrigin(prior.provenance)?.rolling_window_key === claim.key;
      return { candidateId: prior.id, write: written ? { kind: "candidates", id: prior.id } : undefined };
    }
    if (prior?.status === "approved") {
      target = await episodeMemory(db, namespace, prior.id);
      if (!target) return null;
      if (target.content.includes(event.content)) {
        const written = parseOrigin(prior.provenance)?.rolling_window_key === claim.key;
        return { candidateId: prior.id, write: written ? { kind: "candidates", id: prior.id } : undefined };
      }
    }
  }
  if (target?.content.trim() === event.content.trim()) return null;
  const saved = await createMemoryCandidate(db, {
    namespace, type: candidate.type, content: candidate.content, confidence: candidate.confidence, importance: candidate.importance,
    sourceMessageIds: cited, provenance: originFor(target?.id),
    source: event.op === "unclassified" ? UNCLASSIFIED_DREAM_SOURCE : target ? "dream_update" : "dream_extract",
    targetMemoryId: target?.id ?? null
  }, guard);
  return {
    candidateId: saved.id,
    write: parseOrigin(saved.provenance)?.rolling_window_key === claim.key ? { kind: "candidates", id: saved.id } : undefined
  };
}

export async function commitRollingDrafts(env: Env, claim: RollingClaim): Promise<boolean> {
  const { namespace, key, rows } = claim;
  const retained = new Set(rows.map(row => row.id));
  const snapshot = await loadRollingState(env, namespace);
  let state = snapshot.state;
  const drafts = await loadRollingDrafts(env.DB, claim);
  const writtenIds: Record<keyof RollingWrites, Set<string>> = { candidates: new Set(), memories: new Set(), revisions: new Set() };
  for (const draft of drafts) {
    const { events, state_delta: delta } = draft.grounded;
    const accepted = new Set<string>();
    const episodeCandidates = new Map<string, string>();
    for (const event of events) {
      if (event.op === "no_op" || !event.source_message_ids.every(id => retained.has(id))) continue;
      const result = await applyEvent(env, claim, draft, event);
      if (!result) continue;
      if (result.write) writtenIds[result.write.kind].add(result.write.id);
      if (event.op === "unclassified") continue;
      for (const id of event.source_message_ids) accepted.add(id);
      if (event.episode_key && result.candidateId) episodeCandidates.set(event.episode_key, result.candidateId);
    }
    const supports = (ids: string[]) => ids.length > 0 && ids.every(id => accepted.has(id));
    state = applyStateDelta(state, {
      close: delta.close?.filter(() => accepted.size > 0),
      open: delta.open?.filter(item => supports(item.evidence_ids)),
      episodes: delta.episodes?.filter(item => supports(item.evidence_ids)).map(item => ({
        ...item, candidate_id: episodeCandidates.get(item.key)
      }))
    }, `${key}:${draft.part}`, rollingSettings(env).stateChars);
  }
  const writes: RollingWrites = {
    candidates: writtenIds.candidates.size, memories: writtenIds.memories.size, revisions: writtenIds.revisions.size
  };
  return finishRollingWindow(env.DB, claim, { state: { ...snapshot, state }, writes });
}
