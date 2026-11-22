import { type DreamFollowup, readDreamFollowup, recordDreamFollowup } from "../../db/dreamFollowup";
import { getDailyLog } from "../../db/v2/logs";
import type { Env } from "../../types";
import { type JudgeRunResult, runCandidateJudge } from "../candidateJudge";
import { type DiaryWriterStats, isDiaryWriterEnabled, writeDiaryAfterDream } from "../diaryWriter";
import type { DailyDigestRunResult } from "./helpers";

const DIARY_RESERVE_MS = 2 * 60_000;
type DiaryAction = "write" | "resume" | "wait" | "skip";

export function diaryAction(result: DailyDigestRunResult): DiaryAction {
  if (result.ran) return result.stats.hasMore ? "wait" : "write";
  return result.reason === "already_done" ? "resume" : "skip";
}

function diaryProgress(result: DiaryWriterStats): NonNullable<DreamFollowup["diary"]> {
  const { reason } = result;
  if (result.ran) return { status: "written" };
  if (!result.enabled) return { status: "off", reason };
  if (reason === "dream_not_done") return { status: "waiting", reason };
  if (reason === "no_messages" || reason === "week_already_rolled_up") return { status: "skipped", reason };
  return { status: "failed", reason };
}

async function record<K extends keyof DreamFollowup>(
  env: Env, namespace: string, dateLabel: string, stage: K, state: NonNullable<DreamFollowup[K]>
): Promise<void> {
  try {
    await recordDreamFollowup(env.DB, namespace, dateLabel, stage, state);
  } catch (error) {
    console.error("dream: follow-up status could not be saved", { namespace, dateLabel, stage, error });
  }
}

export async function runDreamDiary(
  env: Env, namespace: string, dateLabel: string, deadlineAt?: number, runDiary = writeDiaryAfterDream
): Promise<DiaryWriterStats> {
  try {
    const result = await runDiary(env, namespace, dateLabel, { deadlineAt });
    await record(env, namespace, dateLabel, "diary", diaryProgress(result));
    return result;
  } catch (error) {
    console.error("dream: diary writer failed", { namespace, dateLabel, error });
    await record(env, namespace, dateLabel, "diary", { status: "failed" });
    return { enabled: true, date: dateLabel, ran: false, reason: "diary_writer_failed" };
  }
}

async function hasFinishedDiary(env: Env, namespace: string, dateLabel: string): Promise<boolean> {
  try {
    const prior = (await readDreamFollowup(env.DB, namespace, dateLabel))?.diary;
    if (prior && prior.status !== "written") return false;
    // Older deployments have diary rows without a phase report. Keep visible entries on resume.
    return Boolean(await getDailyLog(env.DB, { namespace, date: dateLabel }));
  } catch (error) {
    console.warn("dream: could not confirm an existing diary", { namespace, dateLabel, error });
    return false;
  }
}

/** Review is scoped to the space. Diary generation is scoped to a completed dialogue date. */
export async function runDreamFollowups(
  env: Env,
  namespace: string,
  dateLabel: string,
  diary: DiaryAction,
  options: { deadlineAt?: number; runDiary?: typeof writeDiaryAfterDream } = {}
): Promise<{ candidate_judge: JudgeRunResult | { ran: false; error: string }; diary_writer?: DiaryWriterStats }> {
  const needsDiary = diary === "write" || (diary === "resume" && !await hasFinishedDiary(env, namespace, dateLabel));
  const deadline = options.deadlineAt;
  let candidate_judge: JudgeRunResult | { ran: false; error: string };
  try {
    candidate_judge = await runCandidateJudge(env, namespace, {
      deadlineAt: deadline === undefined ? undefined : deadline - (needsDiary ? DIARY_RESERVE_MS : 0)
    });
    await record(env, namespace, dateLabel, "review", {
      status: !candidate_judge.ran ? "off" : candidate_judge.reason === "time_budget" || candidate_judge.failed ? "partial" : "done",
      approved: candidate_judge.approved,
      failed: candidate_judge.failed
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("dream: candidate review failed", { namespace, dateLabel, error });
    candidate_judge = { ran: false, error: message };
    await record(env, namespace, dateLabel, "review", { status: "failed", approved: 0, failed: 0 });
  }
  if (!needsDiary) {
    if (diary === "wait") {
      const enabled = isDiaryWriterEnabled(env);
      return { candidate_judge, diary_writer: { enabled, ran: false, date: dateLabel, reason: enabled ? "dream_not_done" : "disabled" } };
    }
    return { candidate_judge };
  }
  const diary_writer = await runDreamDiary(env, namespace, dateLabel, deadline, options.runDiary);
  return { candidate_judge, diary_writer };
}
