import type { Env } from "../../types";
import { readDreamModel } from "../dreamEnv";
import { staleClaimBefore } from "./inbox";
import { type RollingFailure, rollingPhase, type RollingWrites, type WindowProgress } from "./progress";
import { isDaytimeDreamOn, rollingSettings } from "./settings";

interface RollingWindowStats {
  window_key: string;
  status: "completed" | "failed";
  error: string | null;
  attempts: number;
  clef_calls: number;
  extractor_calls: number;
  event_count: number;
  duration_ms: number;
  model?: string;
  started_at?: string;
  message_count?: number;
  failure?: RollingFailure;
  last_failure?: RollingFailure;
  disposition?: "nightly" | "check_writes";
  writes?: RollingWrites;
}

interface CurrentWindowRow {
  window_key: string;
  claimed_at: string | null;
  attempts: number;
  progress: string;
}

export async function getRollingDreamStatus(env: Env, namespace: string, { includeBacklog = true, includeHistory = true } = {}) {
  const on = isDaytimeDreamOn(env);
  const db = env.DB;
  const [backlog, current, recent, failures] = await Promise.all([
    includeBacklog ? db.prepare("SELECT COUNT(*) AS count FROM rolling_inbox WHERE namespace=? AND rolling_skipped=0 AND done_at IS NULL")
      .bind(namespace).first<{ count: number }>() : null,
    db.prepare(`SELECT window_key,claimed_at,attempts,progress FROM rolling_inbox INDEXED BY idx_rolling_inbox_current_window
      WHERE namespace=? AND done_at IS NULL AND window_key GLOB 'rolling_*' ORDER BY seq LIMIT 1`)
      .bind(namespace).first<CurrentWindowRow>(),
    db.prepare(`SELECT payload_json,created_at FROM memory_events WHERE namespace=? AND event_type='rolling_window'
      ORDER BY created_at DESC,id DESC LIMIT ?`).bind(namespace, includeHistory ? 8 : 1).all<{ payload_json: string; created_at: string }>(),
    includeHistory ? db.prepare(`SELECT payload_json,created_at FROM memory_events INDEXED BY idx_rolling_window_failures
      WHERE namespace=? AND event_type='rolling_window'
      AND json_extract(payload_json,'$.status')='failed' ORDER BY created_at DESC,id DESC LIMIT 8`)
      .bind(namespace).all<{ payload_json: string; created_at: string }>() : null
  ]);
  const summarize = (rows: typeof recent.results) => rows.map(row => ({
    ...JSON.parse(row.payload_json) as RollingWindowStats, finished_at: row.created_at
  }));
  const progress = current ? JSON.parse(current.progress) as WindowProgress | null : null;
  const cutoff = staleClaimBefore(env);
  const recentClaim = current?.claimed_at && current.claimed_at >= cutoff;
  const lastActivity = current?.claimed_at ?? progress?.lastFailure?.at ?? progress?.startedAt;
  return {
    on,
    queue_available: Boolean(env.MEMORY_QUEUE),
    model: readDreamModel(env),
    ...(includeBacklog ? { backlog: backlog?.count ?? 0 } : {}),
    active_window: on && current && recentClaim ? { window_key: current.window_key, claimed_at: current.claimed_at } : null,
    current_window: current && progress ? {
      window_key: current.window_key,
      started_at: progress.startedAt,
      last_activity_at: lastActivity,
      model: progress.model,
      message_count: progress.messageCount,
      phase: rollingPhase(progress),
      attempts: current.attempts,
      max_attempts: rollingSettings(env).maxAttempts,
      state: recentClaim ? "running"
        : lastActivity && lastActivity < cutoff ? "stalled"
        : on ? "retrying" : "paused",
      last_failure: progress.lastFailure
    } : null,
    recent_windows: summarize(recent.results),
    failed_windows: summarize(failures?.results ?? [])
  };
}
