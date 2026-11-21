import { archiveMemory, getActiveMemoryByFactKey, supersedeMemory, upsertMemoryByFactKey } from "../db/v2/memories";
import { approvedCandidateMemory, type MemoryCandidateRow } from "../db/v2/candidates";
import type { CandidateApprovalWrite } from "../db/v2/operationReview";
import type { Env } from "../types";
import { reviewedOrigin } from "./provenance";
import { createVectorMemory } from "./vectorStore";

// approve 保留 supersede 历史：有明确 target 就更新该记忆；否则有 fact_key 先查 active 同 key，
// 有就 supersede，没有就 upsert；两者都没有才直接建条目。自动批量决策与人工审核使用同一目标语义。
export async function approveCandidate(
  env: Env,
  namespace: string,
  candidate: MemoryCandidateRow,
  tags: string[],
  sourceMessageIds: string[],
  source = "judge",
  write?: CandidateApprovalWrite
): Promise<string> {
  if (candidate.source === "dream_delete" && candidate.target_memory_id) {
    const archived = await archiveMemory(env, { namespace, id: candidate.target_memory_id }, write);
    if (!archived) throw new Error("target memory not found");
    return candidate.target_memory_id;
  }

  const saved = write ? null : await approvedCandidateMemory(env.DB, namespace, candidate.id);
  if (saved) return saved;
  const provenance = reviewedOrigin(candidate, source);
  const factKey = candidate.fact_key?.trim() || null;

  if (candidate.target_memory_id) {
    const result = await supersedeMemory(env, {
      namespace,
      oldId: candidate.target_memory_id,
      newContent: candidate.content,
      newType: candidate.type,
      newFactKey: factKey,
      importance: candidate.importance,
      confidence: candidate.confidence,
      tags,
      source,
      sourceMessageIds, provenance,
      reason: "candidate_judge_approve"
    }, write);
    return result.newId;
  }

  if (factKey) {
    const existing = await getActiveMemoryByFactKey(env.DB, { namespace, factKey });
    if (existing) {
      const result = await supersedeMemory(env, {
        namespace,
        oldId: existing.id,
        newContent: candidate.content,
        newType: candidate.type,
        newFactKey: factKey,
        importance: candidate.importance,
        confidence: candidate.confidence,
        tags,
        source,
        sourceMessageIds, provenance,
        reason: "candidate_judge_approve"
      });
      return result.newId;
    }

    const result = await upsertMemoryByFactKey(env, {
      namespace,
      factKey,
      content: candidate.content,
      type: candidate.type,
      importance: candidate.importance,
      confidence: candidate.confidence,
      tags,
      source,
      sourceMessageIds, provenance
    });
    return result.id;
  }

  const created = await createVectorMemory(env, {
    namespace,
    type: candidate.type,
    content: candidate.content,
    importance: candidate.importance,
    confidence: candidate.confidence,
    tags,
    source,
    sourceMessageIds, provenance
  }, write);
  return created.id;
}
