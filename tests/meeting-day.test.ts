import assert from "node:assert/strict";
import { test } from "node:test";
import { MEETING_NOTE_TURNS, meetingDayNote, meetingMilestone } from "../src/memory/meetingDay";
import { sqliteFixture } from "./support/sqlite";

test("milestones are day 520, every 100 days and the calendar anniversary", () => {
  assert.deepEqual(meetingMilestone("2025-04-01", "2026-11-22"), { days: 600 });
  assert.deepEqual(meetingMilestone("2025-04-01", "2026-09-03"), { days: 520 });
  assert.equal(meetingMilestone("2025-04-01", "2026-09-02"), null);
  assert.deepEqual(meetingMilestone("2025-11-22", "2026-11-22"), { days: 365, years: 1 });
  // 2023-11-22 to 2026-11-22 crosses Feb 29, 2024: the anniversary is day 1096, not 1095.
  assert.deepEqual(meetingMilestone("2023-11-22", "2026-11-22"), { days: 1096, years: 3 });
  assert.equal(meetingMilestone("2023-11-23", "2026-11-22"), null);
  assert.deepEqual(meetingMilestone("2024-02-29", "2026-02-28"), { days: 730, years: 2 });
  assert.equal(meetingMilestone("2024-02-29", "2026-03-01"), null);
  for (const metOn of [undefined, "", "2026-11-22", "2026-11-23", "2025-02-29"]) {
    assert.equal(meetingMilestone(metOn, "2026-11-22"), null, String(metOn));
  }
});

test("the note rides only on the space's first few user messages of the milestone day", async (t) => {
  const { sqlite, db } = sqliteFixture(t);
  const now = new Date("2026-11-22T09:00:00.000+08:00");
  const note = (metOn = "2025-04-01", currentMessageId = "current") =>
    meetingDayNote(db, { namespace: "home", metOn, timeZone: "Asia/Shanghai", currentMessageId, now });
  const say = (id: string, at: string, role = "user", namespace = "home") => sqlite.prepare(
    `INSERT INTO messages (id, conversation_id, namespace, role, content, source, created_at)
     VALUES (?, 'c', ?, ?, '早', 'gateway', ?)`).run(id, namespace, role, at);

  assert.match(await note(), /^\[Aelios 纪念日\]\n今天是你们认识满 600 天的日子（初识于 2025-04-01）。/);
  assert.equal(await note("2025-04-02"), "");
  assert.match(await note("2025-11-22"), /认识 1 周年的纪念日（初识于 2025-11-22，满 365 天）/);

  // Yesterday (Shanghai), assistant lines, other spaces and the current message do not count.
  say("yesterday", "2026-11-21T15:59:00.000Z");
  say("reply", "2026-11-22T00:10:00.000Z", "assistant");
  say("elsewhere", "2026-11-22T00:10:00.000Z", "user", "other");
  say("current", "2026-11-22T00:20:00.000Z");
  assert.notEqual(await note(), "");
  for (let index = 1; index < MEETING_NOTE_TURNS; index += 1) say(`turn-${index}`, `2026-11-22T00:1${index}:00.000Z`);
  assert.notEqual(await note(), "", "the third message of the day still carries it");
  say("turn-last", "2026-11-22T00:30:00.000Z");
  assert.equal(await note(), "");
});

test("an ordinary day never touches the database", async () => {
  const db = { prepare() { throw new Error("no query expected"); } } as unknown as D1Database;
  const now = new Date("2026-11-23T09:00:00.000+08:00");
  assert.equal(await meetingDayNote(db, { namespace: "home", metOn: "2025-04-01", timeZone: "Asia/Shanghai", now }), "");
  assert.equal(await meetingDayNote(db, { namespace: "home", timeZone: "Asia/Shanghai", now }), "");
});
