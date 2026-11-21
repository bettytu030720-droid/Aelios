-- A status refresh can find the current window and recent failures without scanning chat history.
CREATE INDEX idx_rolling_inbox_current_window
ON rolling_inbox(namespace) WHERE done_at IS NULL AND window_key GLOB 'rolling_*';

CREATE INDEX idx_rolling_window_failures
ON memory_events(namespace, created_at DESC, id DESC)
WHERE event_type='rolling_window' AND json_extract(payload_json,'$.status')='failed';

-- Older workers closed these windows before any writes. Leave the retained originals for nightly
-- Dream. An old generic write failure may have applied part of a draft, so keep its settlement.
UPDATE rolling_inbox
SET done_at=NULL, rolling_skipped=1, window_key=NULL, claimed_at=NULL, progress=NULL
WHERE done_at IS NOT NULL AND error IN ('triage_failed','extraction_failed','extractor_timeout')
  AND (namespace, window_key) IN (
    SELECT namespace, json_extract(payload_json,'$.window_key')
    FROM memory_events
    WHERE event_type='rolling_window' AND json_extract(payload_json,'$.status')='failed'
      AND json_extract(payload_json,'$.error') IN ('triage_failed','extraction_failed','extractor_timeout')
  );
