import { nowIso } from "../utils/time";

export interface DreamFollowup {
  review?: { status: "done" | "off" | "partial" | "failed"; approved: number; failed: number };
  diary?: { status: "written" | "off" | "waiting" | "skipped" | "failed"; reason?: string };
}

function eventId(namespace: string, dateLabel: string): string {
  return `evt_dream_followup:${namespace}:${dateLabel}`;
}

export async function readDreamFollowup(db: D1Database, namespace: string, dateLabel: string): Promise<DreamFollowup | null> {
  const row = await db.prepare("SELECT payload_json FROM memory_events WHERE id=? AND namespace=?")
    .bind(eventId(namespace, dateLabel), namespace).first<{ payload_json: string }>();
  return row ? JSON.parse(row.payload_json) as DreamFollowup : null;
}

export async function listDreamFollowups(db: D1Database, namespace: string, dateLabels: string[]): Promise<Record<string, DreamFollowup>> {
  const prefix = eventId(namespace, "");
  const rows = await db.prepare(`SELECT id,payload_json FROM memory_events WHERE id IN (SELECT value FROM json_each(?))
    AND namespace=?`)
    .bind(JSON.stringify(dateLabels.map(label => prefix + label)), namespace).all<{ id: string; payload_json: string }>();
  return Object.fromEntries(rows.results.map(row => [row.id.slice(prefix.length), JSON.parse(row.payload_json) as DreamFollowup]));
}

export async function recordDreamFollowup<K extends keyof DreamFollowup>(
  db: D1Database, namespace: string, dateLabel: string, stage: K, state: NonNullable<DreamFollowup[K]>
): Promise<void> {
  const value = JSON.stringify(state);
  await db.prepare(`INSERT INTO memory_events (id,namespace,event_type,payload_json,created_at)
    VALUES (?,?,'dream_followup',?,?)
    ON CONFLICT(id) DO UPDATE SET payload_json=json_set(memory_events.payload_json,?,json(?)),
      created_at=excluded.created_at`)
    .bind(eventId(namespace, dateLabel), namespace, JSON.stringify({ [stage]: state }), nowIso(), `$.${stage}`, value).run();
}
