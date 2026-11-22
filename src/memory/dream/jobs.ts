import { claimQueuedDreamRun, failActiveDreamRun } from "../../db/dreamRuns";
import type { DreamRunQueueMessage, Env } from "../../types";
import { runDailyMemoryDigest } from "../dailyDigest";
import { writeDiaryAfterDream } from "../diaryWriter";
import { diaryAction, runDreamFollowups } from "./followups";
import { DREAM_BACKGROUND_BUDGET_MS } from "./nightly";

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
    const deadlineAt = Date.now() + DREAM_BACKGROUND_BUDGET_MS;
    const result = await runDigest(env, job.namespace, {
      dateLabel: job.dateLabel,
      force: job.force,
      trigger: "manual",
      runId: job.runId
    });
    await runDreamFollowups(env, job.namespace, job.dateLabel, diaryAction(result), { deadlineAt, runDiary });
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
