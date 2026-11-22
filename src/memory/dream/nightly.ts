import { readCursor, writeCursor } from "../../db/retention";
import type { Env } from "../../types";
import { isDreamEnabled } from "../dreamEnv";
import { diaryAction, runDreamDiary, runDreamFollowups } from "./followups";
import { runDailyMemoryDigest, runDreamBackfill } from "./orchestrator";

// Keep a minute for Worker shutdown and bookkeeping before the 15-minute wall limit.
export const DREAM_BACKGROUND_BUDGET_MS = 14 * 60_000;
const FOLLOWUP_RESERVE_MS = 4 * 60_000;
const START_WORK_MARGIN_MS = 30_000;

function nightlyBatchLimit(env: Env): number {
  const limit = Number(env.DREAM_MAX_RUNS || env.DAILY_DIGEST_MAX_RUNS || 10);
  return Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 10) : 10;
}

export async function runNightlyDream(env: Env, namespace: string, dateLabel: string, deadlineAt: number): Promise<unknown[]> {
  const results: unknown[] = [];
  const extractUntil = deadlineAt - FOLLOWUP_RESERVE_MS;
  let diary: ReturnType<typeof diaryAction> = "skip";

  try {
    const batchLimit = nightlyBatchLimit(env);
    for (let batch = 0; batch < batchLimit && Date.now() + START_WORK_MARGIN_MS < extractUntil; batch += 1) {
      const result = await runDailyMemoryDigest(env, namespace, { dateLabel, trigger: "cron", deadlineAt: extractUntil });
      results.push({ type: "primary", result });
      diary = diaryAction(result);
      if (!result.ran || !result.stats.hasMore) break;
    }
  } catch (error) {
    console.error("nightly dream: extraction stopped", { namespace, dateLabel, error });
  }

  const { candidate_judge, diary_writer } = await runDreamFollowups(env, namespace, dateLabel, diary, { deadlineAt });
  results.push({ type: "candidate_judge", result: candidate_judge });
  if (diary_writer) results.push({ type: "diary_writer", result: diary_writer });
  return results;
}

export async function runNightlyCatchup(env: Env, namespace: string, dateLabel: string, deadlineAt: number): Promise<unknown[]> {
  const results: unknown[] = [];
  const hasTime = () => Date.now() + START_WORK_MARGIN_MS < deadlineAt;
  if (!hasTime()) return results;

  if (isDreamEnabled(env)) {
    const backfill = await runDreamBackfill(env, namespace, { anchorDateLabel: dateLabel, deadlineAt });
    for (const item of backfill) {
      results.push({ type: "backfill", date_label: item.dateLabel, result: item.result });
      if (hasTime() && diaryAction(item.result) === "write") {
        const result = await runDreamDiary(env, namespace, item.dateLabel, deadlineAt);
        results.push({ type: "backfill_diary", date_label: item.dateLabel, result });
      }
    }
  }

  if (!hasTime()) return results;
  const rebuildCursor = `diary_rebuild:${namespace}`;
  const afterDate = await readCursor(env.DB, rebuildCursor);
  const rebuild = await env.DB.prepare(`SELECT date FROM daily_log WHERE namespace=? AND needs_rebuild=1
    ORDER BY (date <= ?) ASC, date LIMIT 3`).bind(namespace, afterDate ?? "").all<{ date: string }>();
  for (const { date } of rebuild.results) {
    if (!hasTime()) break;
    const result = await runDreamDiary(env, namespace, date, deadlineAt);
    results.push({ type: "backfill_diary", date_label: date, result });
    await writeCursor(env.DB, rebuildCursor, date);
  }
  return results;
}
