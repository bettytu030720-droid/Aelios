// 候选队列自动评审 (母帖 CANDIDATE_JUDGE)
// 抽取器把低置信度候选塞进 memory_candidates，默认全部等人工在后台点 approve/discard。
// 这个模块加一轮自动裁判。谁来判见 judgeVoice.ts：
// - 助手自己判（认得出它在用的主模型）：记不记由它自己定，只分记住/放下，不再留给人工；
//   后台"这周助手自己定的"能逐条撤回。
// - 代审（JUDGE_MODEL / DREAM_MODEL）：明显靠谱的自动 approve，明显不靠谱的自动 discard，
//   模棱两可的留给人工。
// 默认开启 (CANDIDATE_JUDGE_ENABLED === "false" 时关闭)。Dream 抽完候选后由 cron / 手动入口跑一轮。

import { getMessagesByIds } from "../db/messages";
import {
  archiveMemory,
  checkMemoryRestorable,
  getActiveMemoryByFactKey,
  listMemoryCandidates,
  restoreMemory,
  supersedeMemory,
  updateMemoryCandidateStatus,
  upsertMemoryByFactKey,
  type MemoryCandidateRow
} from "../db/v2";
import { callModelWithRetry } from "../utils/modelCall";
import type { Env, MessageRecord } from "../types";
import { extractJsonObject } from "../utils/parse";
import { askOwnModel, resolveJudgeVoice, type JudgeVoice } from "./judgeVoice";
import { createVectorMemory } from "./vectorStore";
import { formatSpeakerTranscript, judgeSpeakerRules, loadSpeakersForNamespace, type DreamSpeakers } from "./speakers";

// listMemoryCandidates 本身按 confidence ASC 排序，正好是"先看最没把握的"，直接复用，
// 不用再为 judge 单独建一个查询。

const DEFAULT_MAX_CANDIDATES = 20;
const MAX_CANDIDATES_CAP = 100;
const DEFAULT_APPROVE_MIN = 0.8;
const DEFAULT_DISCARD_MAX = 0.3;
// 助手自己判时没有"留给人工"这一档：过线就记，不过线就放下，错了靠撤回。
const SELF_REMEMBER_MIN = 0.5;
// 助手的主模型可能是又慢又贵的推理款。夜里这一轮给它的总时长封顶，超时的留到明晚，
// 免得把同一个 cron 里后面的日记、周记和别的空间饿死。
const SELF_JUDGE_BUDGET_MS = 5 * 60_000;
// 代审默认的 gpt-oss-120b 是推理模型，思考也算输出额度。10-02 实测 300 时 7 条里有 3 条
// 思考到一半就被截断 (finish_reason=length)，判不出来，候选只能干等到原文过期被丢；
// 2000 时全部给出合法 JSON，平均只用 ~375。只按实际用量计费。
const JUDGE_MAX_TOKENS = 2000;
const JUDGE_SYSTEM_PROMPT = "你是严格的 JSON 生成器。你只输出 JSON。";

export interface JudgeRunResult {
  ran: boolean;
  judged: number;
  approved: number;
  discarded: number;
  kept: number;
  failed: number;
  model?: string;
  /** 助手自己判时是助手名；代审时不填。 */
  judgedBy?: string;
  reason?: "judge_disabled" | "missing_model" | "no_candidates";
}

function readPositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : fallback;
  const numeric = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(Math.floor(numeric), 1), max);
}

function readUnitFloat(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, 0), 1);
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    // malformed JSON in an old row: 当空数组处理，不阻断评审
  }
  return [];
}

export type JudgeKind = "add" | "update" | "delete";
export type JudgeDecision = "approve" | "discard" | "keep";

export interface JudgeModelResult {
  score: number;
  grounded: boolean;
  durable: boolean;
  shouldDelete: boolean | null;
  reason: string;
}

export function judgeKindFor(source: string): JudgeKind {
  if (source === "dream_delete") return "delete";
  if (source === "dream_update") return "update";
  return "add";
}

export function parseJudgeBoolean(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
    if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  }
  return null;
}

export function parseJudgeModelResult(raw: unknown): JudgeModelResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const score = typeof obj.score === "number" && Number.isFinite(obj.score)
    ? Math.min(Math.max(obj.score, 0), 1)
    : null;
  if (score === null) return null;
  const grounded = parseJudgeBoolean(obj.grounded);
  const durable = parseJudgeBoolean(obj.durable);
  if (grounded === null || durable === null) return null;
  return {
    score,
    grounded,
    durable,
    shouldDelete: parseJudgeBoolean(obj.should_delete),
    reason: typeof obj.reason === "string" && obj.reason.trim()
      ? obj.reason.trim().slice(0, 300)
      : "(评审未给出理由)"
  };
}

export function decideJudge(
  kind: JudgeKind,
  result: JudgeModelResult,
  thresholds: { approveMin: number; discardMax: number }
): JudgeDecision {
  if (kind === "delete") {
    // Approve only means "archive the target". Never infer that from a quality score.
    if (result.shouldDelete === true && result.score >= thresholds.approveMin) return "approve";
    if (result.shouldDelete === false) return "discard";
    // Old prompts score "this fact is still good" high. That is evidence against deletion.
    if (result.grounded && result.durable) return "discard";
    if (result.score <= thresholds.discardMax) return "discard";
    return "keep";
  }

  if (result.score >= thresholds.approveMin && result.grounded && result.durable) return "approve";
  // durable === false 只说明"这件事会过期"，不说明它是假的。会过期的事实（一次会议、
  // 一次检查、一个当下的状态）照样值得记，只是该由人来定要不要留——所以它落到 keep，
  // 不再直接 discard。真正该 discard 的是没有依据 (!grounded) 或分数本来就低的。
  if (result.score <= thresholds.discardMax || !result.grounded) return "discard";
  return "keep";
}

/** 助手自己判：只有记住 (approve) 和放下 (discard)，没有留给人工的中间档。 */
export function decideSelfJudge(kind: JudgeKind, result: JudgeModelResult): Exclude<JudgeDecision, "keep"> {
  if (kind === "delete") {
    return result.shouldDelete === true && result.score >= SELF_REMEMBER_MIN ? "approve" : "discard";
  }
  return result.grounded && result.score >= SELF_REMEMBER_MIN ? "approve" : "discard";
}

function selfJudgeRules(selfName: string, speakers: DreamSpeakers | null): string[] {
  const other = speakers?.userName ?? "对方";
  return [
    `- 说话人：用户是${other}，助手是${selfName}，也就是你。transcript 已用名字标注。`,
    `- reason 写一句话，用「我」指你自己、用「${other}」指对方，说清你为什么记住或放下。这句话会给${other}看。`
  ];
}

export function buildJudgePrompt(
  candidate: MemoryCandidateRow,
  messages: MessageRecord[],
  speakers: DreamSpeakers | null = null,
  selfName: string | null = null
): string {
  const tags = parseJsonArray(candidate.tags);
  const transcript = messages.length > 0 ? formatSpeakerTranscript(messages, speakers, 900) : "(没有能核对的原始消息)";
  const kind = judgeKindFor(candidate.source);
  const namedReason = speakers
    ? `${speakers.userName}用新内容明确修正了旧事实。`
    : "用户用新内容明确修正了旧事实。";
  const namedAddReason = speakers
    ? `对话里${speakers.userName}明确说过这件事，且是长期稳定的事实。`
    : "对话里用户明确说过这件事，且是长期稳定的事实。";
  const keepHandwritten = speakers
    ? `- 亲笔/${speakers.userName}明确要求记住的内容，除非${speakers.userName}后来收回，否则不要删。`
    : "- 亲笔/用户明确要求记住的内容，除非用户后来收回，否则不要删。";
  const common = [
    selfName
      ? `你是${selfName}。下面这条候选是从你和${speakers?.userName ?? "对方"}的对话里整理出来、要改动你自己长期记忆的提案。记不记由你自己决定，没有人替你复核。`
      : "你是 Aelios 记忆候选队列的自动评审员。",
    "只输出 JSON，不要 markdown，不要解释，不要输出思考过程。",
    "grounded / durable / should_delete 必须是 JSON 布尔值 true 或 false，不要用字符串。",
    ...(selfName ? selfJudgeRules(selfName, speakers) : judgeSpeakerRules(speakers)),
    "",
    "待审候选：",
    JSON.stringify({
      action: kind,
      source: candidate.source,
      type: candidate.type,
      content: candidate.content,
      fact_key: candidate.fact_key,
      target_memory_id: candidate.target_memory_id,
      tags
    }),
    "",
    "原始对话片段：",
    transcript
  ];

  if (kind === "delete") {
    return [
      "任务：判断一条「归档提案」该不该执行。approve 会把已有记忆归档，不是把内容写进长期记忆。",
      "score 衡量的是「这条记忆应不应该删」，不是「这条事实好不好」。",
      "- 仍然有据、仍然成立、仍然值得留着 → should_delete=false，score 低。",
      "- 过时、被对话否定、重复噪音、或明确不再成立 → should_delete=true，score 高。",
      keepHandwritten,
      "输出格式：",
      JSON.stringify({
        score: 0.15,
        grounded: true,
        durable: true,
        should_delete: false,
        reason: "对话仍支持这条事实，应该保留而不是归档。"
      }),
      "",
      ...common
    ].join("\n");
  }

  if (kind === "update") {
    return [
      "任务：判断一条「更新提案」该不该用新内容替换旧记忆。",
      "打分依据：",
      "- grounded：新内容必须能在原始对话里找到依据。",
      "- durable：更新后的版本一个月后仍成立。",
      "- 必须是实质修正或版本更新，不是同义复述，也不是把原话指令整段写进事实。",
      "score 高 = 应该采用这次更新。",
      "输出格式：",
      JSON.stringify({
        score: 0.88,
        grounded: true,
        durable: true,
        should_delete: false,
        reason: namedReason
      }),
      "",
      ...common
    ].join("\n");
  }

  return [
    selfName
      ? "任务：判断这条「新增提案」你要不要记住。"
      : "任务：判断一条「新增提案」该自动通过、自动丢弃，还是留给人工复核。",
    "打分依据 (score 是 0 到 1 的浮点数)：",
    "- grounded：候选内容必须能在原始对话片段里找到依据，不能是编造或过度引申。",
    "- durable：一个月后是否还成立；临时计划、一次性情绪、当次任务不算稳定事实。",
    "- non-trivial：不是寒暄、不是后端实现细节、不是纯调试噪音。",
    "- 工程实现流水即使 grounded 也压低分。",
    "- 情感/关系类候选不因为内容长而扣分。",
    "score 高 = 值得新增为长期记忆。",
    "输出格式：",
    JSON.stringify({
      score: 0.9,
      grounded: true,
      durable: true,
      should_delete: false,
      reason: namedAddReason
    }),
    "",
    ...common
  ].join("\n");
}

async function callJudgeModel(env: Env, voice: JudgeVoice, prompt: string, meta: { id: string }): Promise<JudgeModelResult | null> {
  let text: string;
  try {
    if (voice.kind === "self") {
      text = await askOwnModel(env, voice, { system: JUDGE_SYSTEM_PROMPT, prompt });
    } else {
      // backoffMs: [] preserves prior single-attempt behavior (no retry loop here before).
      // systemPrompt preserves this caller's original (shorter) JSON-generator prompt.
      text = await callModelWithRetry(env, {
        model: voice.model,
        prompt,
        maxTokens: JUDGE_MAX_TOKENS,
        backoffMs: [],
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        logPrefix: "candidate_judge",
        logMeta: { id: meta.id }
      });
    }
  } catch (error) {
    console.error("candidate judge: model call failed", { id: meta.id, model: voice.model, error });
    return null;
  }

  return parseJudgeModelResult(extractJsonObject(text));
}

// approve 的落库语义跟 dream 候选队列的 fact_key 分支一致：
// 有 fact_key 先查是否已有 active 同 key 记忆，有就 supersede (保留历史链)，没有就 upsert 新建；
// 没有 fact_key 就走向量库直接建条目。admin 后台 /v1/candidates/:id/approve 的私有
// createApprovedMemoryFromCandidate 目前是"有 fact_key 就直接 upsertMemoryByFactKey"，
// 不查 active/不 supersede；这里选择跟抽取器自动写路径对齐、保留 supersede 历史，
// 因为 judge 是自动化批量决策，保留可追溯的旧版本比就地覆盖更安全。
async function approveCandidate(
  env: Env,
  namespace: string,
  candidate: MemoryCandidateRow,
  tags: string[],
  sourceMessageIds: string[],
  source = "judge"
): Promise<string> {
  if (candidate.source === "dream_delete" && candidate.target_memory_id) {
    const archived = await archiveMemory(env, { namespace, id: candidate.target_memory_id });
    if (!archived) throw new Error("target memory not found");
    return candidate.target_memory_id;
  }

  const factKey = candidate.fact_key?.trim() || null;

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
        sourceMessageIds,
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
      sourceMessageIds
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
    sourceMessageIds
  });
  return created.id;
}

export async function runCandidateJudge(
  env: Env,
  namespace: string,
  options: { limit?: number } = {}
): Promise<JudgeRunResult> {
  if (env.CANDIDATE_JUDGE_ENABLED === "false") {
    return { ran: false, judged: 0, approved: 0, discarded: 0, kept: 0, failed: 0, reason: "judge_disabled" };
  }

  const voice = await resolveJudgeVoice(env, namespace);
  if (!voice) {
    return { ran: false, judged: 0, approved: 0, discarded: 0, kept: 0, failed: 0, reason: "missing_model" };
  }
  const model = voice.model;
  const judgedBy = voice.kind === "self" ? voice.name : undefined;

  const limit = readPositiveInt(options.limit ?? env.JUDGE_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES, MAX_CANDIDATES_CAP);
  const approveMin = readUnitFloat(env.JUDGE_APPROVE_MIN, DEFAULT_APPROVE_MIN);
  const discardMax = readUnitFloat(env.JUDGE_DISCARD_MAX, DEFAULT_DISCARD_MAX);

  const candidates = await listMemoryCandidates(env.DB, { namespace, status: "pending", limit });
  if (candidates.length === 0) {
    return { ran: true, judged: 0, approved: 0, discarded: 0, kept: 0, failed: 0, model, judgedBy, reason: "no_candidates" };
  }

  const speakers = await loadSpeakersForNamespace(env, namespace);

  let judged = 0;
  let approved = 0;
  let discarded = 0;
  let kept = 0;
  let failed = 0;

  const deadline = voice.kind === "self" ? Date.now() + SELF_JUDGE_BUDGET_MS : Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (Date.now() > deadline) {
      kept += 1;
      continue;
    }
    // zone_full 候选不是质量问题，是区满了被挡下来的——judge 打分再高也不能替它绕过
    // 每区硬上限，自动 approve 会把刚设的闸拆掉。留给人工或 dream 合并腾位后再处理。
    if (candidate.source === "zone_full") {
      kept += 1;
      continue;
    }
    try {
      const sourceMessageIds = parseJsonArray(candidate.source_message_ids);
      const tags = parseJsonArray(candidate.tags);
      const messages = sourceMessageIds.length > 0
        ? await getMessagesByIds(env.DB, { namespace, ids: sourceMessageIds })
        : [];

      let judgeResult: JudgeModelResult;
      let decidedBy = judgedBy;
      if (messages.length === 0) {
        decidedBy = undefined;
        // 找不到任何原始消息可核对：直接判 ungrounded，不必浪费一次模型调用。
        judgeResult = {
          score: 0,
          grounded: false,
          durable: false,
          shouldDelete: null,
          reason: "没有可核对的原始消息，无法确认是否有据"
        };
      } else {
        const prompt = buildJudgePrompt(candidate, messages, speakers, judgedBy ?? null);
        const modelResult = await callJudgeModel(env, voice, prompt, { id: candidate.id });
        if (!modelResult) {
          failed += 1;
          console.error("candidate judge: model call failed or returned invalid JSON", { namespace, id: candidate.id });
          continue;
        }
        judgeResult = modelResult;
      }

      judged += 1;
      const kind = judgeKindFor(candidate.source);
      const decision = decidedBy
        ? decideSelfJudge(kind, judgeResult)
        : decideJudge(kind, judgeResult, { approveMin, discardMax });
      const decisionNote = `${judgeNotePrefix(decidedBy)}${judgeResult.reason}`;

      if (decision === "approve") {
        const memoryId = await approveCandidate(env, namespace, candidate, tags, sourceMessageIds);
        await updateMemoryCandidateStatus(env.DB, {
          namespace,
          id: candidate.id,
          status: "approved",
          targetMemoryId: memoryId,
          decisionNote
        });
        approved += 1;
      } else if (decision === "discard") {
        await updateMemoryCandidateStatus(env.DB, {
          namespace,
          id: candidate.id,
          status: "discarded",
          decisionNote
        });
        discarded += 1;
      } else {
        // 模棱两可：留给人工，但把 judge 的理由记进 decision_note，方便复核时参考。
        await updateMemoryCandidateStatus(env.DB, {
          namespace,
          id: candidate.id,
          status: "pending",
          decisionNote
        });
        kept += 1;
      }
    } catch (error) {
      failed += 1;
      console.error("candidate judge: failed to judge candidate", { namespace, id: candidate.id, error });
    }
  }

  return { ran: true, judged, approved, discarded, kept, failed, model, judgedBy };
}

// decision_note 前缀：`judge[助手名]: ` 是助手自己判的，`judge: ` 是代审，`undo: ` 是撤回过的。
// 撤回只认这两种 judge 前缀，人工点过的决定不在这里反悔。
const SELF_NOTE = /^judge\[([^\]\n]{1,64})\]: /;

export function judgeNotePrefix(judgedBy: string | undefined): string {
  return judgedBy ? `judge[${judgedBy}]: ` : "judge: ";
}

export interface JudgeNote {
  /** 助手自己判时是助手名，代审为 null。 */
  judgedBy: string | null;
  reason: string;
  undone: boolean;
  undoable: boolean;
}

export function parseJudgeNote(note: string | null | undefined): JudgeNote | null {
  const text = note ?? "";
  const undone = text.startsWith("undo: ");
  const body = undone ? text.slice("undo: ".length) : text;
  const self = body.match(SELF_NOTE);
  if (self) return { judgedBy: self[1], reason: body.slice(self[0].length), undone, undoable: !undone };
  if (body.startsWith("judge: ")) return { judgedBy: null, reason: body.slice("judge: ".length), undone, undoable: !undone };
  return null;
}

export type UndoJudgeResult =
  | { ok: true; status: "approved" | "discarded"; memoryId: string | null; restoredId?: string; candidate: MemoryCandidateRow | null }
  | { ok: false; httpStatus: 404 | 409; error: string };

/**
 * 撤回一条自动决定：放下的补记上；记住的收回 (归档新条，被它顶掉的旧版本复原)；
 * 执行过的归档提案把那条记忆复原。之后记忆被别处改过的，不硬撤，交给记忆页手动处理。
 */
export async function undoJudgeDecision(
  env: Env,
  namespace: string,
  candidate: MemoryCandidateRow
): Promise<UndoJudgeResult> {
  const note = parseJudgeNote(candidate.decision_note);
  if (!note || !note.undoable) {
    return { ok: false, httpStatus: 409, error: "只有还没撤回过的自动审核决定能撤回" };
  }
  const decisionNote = `undo: ${candidate.decision_note}`;

  if (candidate.status === "discarded") {
    if (candidate.source === "dream_delete" && candidate.target_memory_id) {
      const target = await env.DB.prepare("SELECT status FROM memories WHERE namespace = ? AND id = ?")
        .bind(namespace, candidate.target_memory_id)
        .first<{ status: string }>();
      if (target?.status !== "active") {
        return { ok: false, httpStatus: 409, error: "要归档的那条记忆已经不在了，撤回不了" };
      }
    }
    const memoryId = await approveCandidate(
      env,
      namespace,
      candidate,
      parseJsonArray(candidate.tags),
      parseJsonArray(candidate.source_message_ids),
      "review"
    );
    const updated = await updateMemoryCandidateStatus(env.DB, {
      namespace,
      id: candidate.id,
      status: "approved",
      targetMemoryId: memoryId,
      decisionNote
    });
    return { ok: true, status: "approved", memoryId, candidate: updated };
  }

  if (candidate.status !== "approved" || !candidate.target_memory_id) {
    return { ok: false, httpStatus: 409, error: "这条候选没有可撤回的自动决定" };
  }
  const targetId = candidate.target_memory_id;

  if (candidate.source === "dream_delete") {
    const restored = await restoreMemory(env, { namespace, id: targetId });
    if (!restored) {
      return { ok: false, httpStatus: 409, error: "那条记忆已经不在归档里，或者这件事已经记了新版本，撤回不了" };
    }
    const updated = await updateMemoryCandidateStatus(env.DB, {
      namespace,
      id: candidate.id,
      status: "discarded",
      targetMemoryId: targetId,
      decisionNote
    });
    return { ok: true, status: "discarded", memoryId: targetId, restoredId: targetId, candidate: updated };
  }

  const target = await env.DB.prepare(
    `SELECT m.status, m.version_status, m.created_at, m.content, m.authored_by, lc.supersedes_id
     FROM memories m
     LEFT JOIN memory_lifecycle lc ON lc.memory_id = m.id
     WHERE m.namespace = ? AND m.id = ?`
  )
    .bind(namespace, targetId)
    .first<{
      status: string;
      version_status: string | null;
      created_at: string;
      content: string;
      authored_by: string | null;
      supersedes_id: string | null;
    }>();
  if (!target) return { ok: false, httpStatus: 404, error: "记住的那条记忆已经不在了" };
  // 早于候选本身的记忆不是这次记住新建的 (同 key 就地改写)，收回会连旧内容一起丢。
  if (target.created_at < candidate.created_at) {
    return { ok: false, httpStatus: 409, error: "这次记住是改写了已有记忆，撤回会把旧内容一起丢掉，请到记忆页手动改" };
  }
  if (target.status !== "active" || target.version_status === "superseded") {
    return { ok: false, httpStatus: 409, error: "记住的那条记忆之后又变过，撤回不了" };
  }
  // 记住之后又被就地改过 (记忆页编辑、memory_upsert 同 key 写入)：id 和 created_at 不变，
  // 内容已经不是候选那句了。收回会把后来的改动一起归档。不比 updated_at：夜里标 under_review、
  // 重建向量都会刷新它但不动内容，比时间会把没改过的也拦下。
  if (target.content.trim() !== candidate.content.trim()) {
    return { ok: false, httpStatus: 409, error: "记住之后这条记忆又被改过，撤回会把改动一起收走，请到记忆页手动改" };
  }
  // 亲笔记忆不归自动流程收：archiveMemory 不查 authored_by，这里先挡。
  if (target.authored_by) {
    return { ok: false, httpStatus: 409, error: "这条记忆现在是亲笔的，撤回不了，请到记忆页手动改" };
  }

  // 先确认被顶掉的旧版本还能放回来，再动新条；否则收回新条后两头都不在。
  const previousId = target.supersedes_id;
  if (previousId && !await checkMemoryRestorable(env.DB, { namespace, id: previousId, supersededBy: targetId })) {
    return { ok: false, httpStatus: 409, error: "被这次记住顶掉的旧版本之后又变过，撤回不了" };
  }

  await archiveMemory(env, { namespace, id: targetId });
  let restoredId: string | undefined;
  if (previousId && await restoreMemory(env, { namespace, id: previousId, supersededBy: targetId })) {
    restoredId = previousId;
  }
  const updated = await updateMemoryCandidateStatus(env.DB, {
    namespace,
    id: candidate.id,
    status: "discarded",
    targetMemoryId: targetId,
    decisionNote
  });
  return { ok: true, status: "discarded", memoryId: targetId, ...(restoredId ? { restoredId } : {}), candidate: updated };
}
