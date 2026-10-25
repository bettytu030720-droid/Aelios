import { claimQueuedDreamRun, failActiveDreamRun } from "../../db/dreamRuns";
import type { DreamRunQueueMessage, Env } from "../../types";
import { runDailyMemoryDigest } from "../dailyDigest";
import { runCandidateJudge } from "../candidateJudge";
import { writeDiaryAfterDream } from "../diaryWriter";

/**
 * At-most-one pipeline invocation per persisted job, not exactly-once completion.
 * After a claim, crashes/unknown outcomes require inspection, never automatic replay.
 * A DB claim failure can be retried safely by the existing queue handler.
 */
export async function runDreamJob(
  env: Env,
  job: DreamRunQueueMessage,
  runDigest: typeof runDailyMemoryDigest = runDailyMemoryDigest,
  runDiary: typeof writeDiaryAfterDream = writeDiaryAfterDream
): Promise<void> {
  if (!(await claimQueuedDreamRun(env.DB, job))) return;
  try {
    const result = await runDigest(env, job.namespace, {
      dateLabel: job.dateLabel,
      force: job.force,
      trigger: "manual",
      runId: job.runId
    });
    // Preserve the synchronous manual endpoint's follow-up review. Its failure does not undo a completed dream.
    try {
      await runCandidateJudge(env, job.namespace);
    } catch {
      console.error("dream: background candidate judge failed", { runId: job.runId });
    }
    // The cron only writes yesterday's diary, so the last batch of any other date needs it written here. It does nothing
    // until that date's dream is complete, never throws, and its failure does not undo the dream.
    if (result?.ran) await runDiary(env, job.namespace, job.dateLabel);
  } catch {
    // The orchestrator also finalizes failures; this fallback only touches an unresolved claim.
    // Do not leak model/provider payloads into persisted job errors.
    await failActiveDreamRun(env.DB, {
      id: job.runId,
      expectedStatus: "running",
      reason: "execution_failed",
      error: "Dream execution failed; inspect status before starting another task."
    });
    // Acknowledged after recording failure: retrying side-effecting work is unsafe.
  }
}
