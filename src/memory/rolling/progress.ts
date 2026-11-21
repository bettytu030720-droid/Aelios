import type { TriageAnswers } from "./triage";

export type RollingPhase = "triage" | "extraction" | "write" | "finish";
export type RollingFailureReason =
  | "triage_failed" | "triage_timeout"
  | "extraction_failed" | "extractor_timeout" | "extractor_http_error" | "extractor_request_failed"
  | "extractor_truncated" | "extractor_invalid_json" | "extractor_invalid_shape" | "extractor_invalid_operation"
  | "attempts_exhausted" | "lease_changed" | "window_processing_failed";

export interface RollingFailure {
  reason: RollingFailureReason;
  phase: RollingPhase;
  at: string;
  http_status?: number;
}

export class RollingStepError extends Error {
  constructor(
    readonly reason: RollingFailureReason,
    readonly retryable = true,
    readonly httpStatus?: number
  ) {
    super(reason);
  }
}

export interface WindowProgress {
  model: string;
  chars: number;
  startedAt: string;
  messageCount?: number;
  triage?: TriageAnswers | null;
  extract?: boolean;
  completed: string[];
  clefCalls: number;
  extractorCalls: number;
  eventCount: number;
  committing?: boolean;
  lastFailure?: RollingFailure;
}

export interface RollingWrites {
  candidates: number;
  memories: number;
  revisions: number;
}

export function rollingPhase(progress: WindowProgress): RollingPhase {
  if (progress.committing) return "write";
  if (progress.extract === undefined) return "triage";
  return progress.extract ? "extraction" : "finish";
}
