import { formatDateLabel, isCalendarDate } from "../utils/time";
import { getDateRangeForLabel } from "./dreamDates";

/** How many of the day's first user messages carry the note, counting the current one. */
export const MEETING_NOTE_TURNS = 3;

export interface MeetingMilestone {
  days: number;
  /** Set on the calendar anniversary of the first meeting. */
  years?: number;
}

/**
 * Day 520, every 100 days, and the calendar anniversary (Feb 29 falls on Feb 28 in other years).
 * The admin Home card applies the same rule in the browser; tests/meeting-card.test.ts keeps the two in step.
 */
export function meetingMilestone(metOn: string | undefined, today: string): MeetingMilestone | null {
  if (!isCalendarDate(metOn) || !isCalendarDate(today)) return null;
  const days = (Date.parse(today) - Date.parse(metOn)) / 86_400_000;
  if (!Number.isInteger(days) || days <= 0) return null;
  const [metYear, month, day] = metOn.split("-").map(Number);
  const [year, todayMonth, todayDay] = today.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const years = year > metYear && todayMonth === month && todayDay === Math.min(day, lastDay) ? year - metYear : 0;
  if (years) return { days, years };
  return days === 520 || days % 100 === 0 ? { days } : null;
}

export function meetingNoteText(metOn: string, milestone: MeetingMilestone): string {
  const what = milestone.years
    ? `今天是你们认识 ${milestone.years} 周年的纪念日（初识于 ${metOn}，满 ${milestone.days} 天）。`
    : `今天是你们认识满 ${milestone.days} 天的日子（初识于 ${metOn}）。`;
  return `[Aelios 纪念日]\n${what}已经提过的话就不用再说。\n[/Aelios 纪念日]`;
}

/**
 * The note for this space's first few user messages on a milestone day, in DREAM_TIME_ZONE; "" otherwise.
 * Ordinary days return without touching the database.
 */
export async function meetingDayNote(
  db: D1Database,
  input: { namespace: string; metOn?: string; timeZone: string; currentMessageId?: string; now?: Date }
): Promise<string> {
  const today = formatDateLabel(input.now ?? new Date(), input.timeZone);
  const milestone = meetingMilestone(input.metOn, today);
  if (!milestone || !input.metOn) return "";
  const { startIso, endIso } = getDateRangeForLabel(today, input.timeZone);
  const earlier = await db.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages
       WHERE namespace = ? AND created_at >= ? AND created_at < ? AND role = 'user' AND id <> ?
       LIMIT ?)`
  ).bind(input.namespace, startIso, endIso, input.currentMessageId ?? "", MEETING_NOTE_TURNS)
    .first<{ n: number }>();
  return (earlier?.n ?? 0) < MEETING_NOTE_TURNS ? meetingNoteText(input.metOn, milestone) : "";
}
