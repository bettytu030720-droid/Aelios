import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { MEETING_CARD, MEETING_CARD_ASSETS } from "../src/api/admin/ui/components/meetingCard";

function page(reducedMotion = false) {
  let now = new Date(2026, 10, 22, 23, 59).getTime();
  class LocalDate extends Date {
    constructor(year?: number, month = 0, day = 1) {
      if (year === undefined) super(now);
      else super(year, month, day);
    }
  }
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let id = 0;
  const script = MEETING_CARD_ASSETS.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const mount = runInNewContext(`${script}\nmeetingDayClock`, {
    Date: LocalDate,
    window: {
      matchMedia: () => ({ matches: reducedMotion }),
      clearTimeout: (key: number) => timers.delete(key),
      setTimeout(callback: () => void, delay: number) {
        timers.set(++id, { callback, delay });
        return id;
      }
    }
  });
  return {
    mount, timers,
    runTimer(delay: number) {
      const entry = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(entry);
      timers.delete(entry[0]);
      now += delay;
      entry[1].callback();
    }
  };
}

test("the meeting card uses calendar days and refreshes at local midnight", () => {
  const { mount, timers, runTimer } = page();
  const clock = mount();
  clock.init();
  assert.equal(clock.daysSinceMeeting("2025-04-01"), 600);
  assert.equal(clock.daysSinceMeeting("2026-11-22"), 0);
  assert.equal(clock.daysSinceMeeting("2026-11-23"), null);
  assert.equal(clock.daysSinceMeeting(""), null);
  assert.match(MEETING_CARD, /x-if="page === 'today' && currentIdentity\(\)\?\.metOn"/);
  runTimer(60_000);
  assert.equal(clock.daysSinceMeeting("2025-04-01"), 601);
  clock.destroy();
  assert.equal(timers.size, 0);
});

test("gold stars fall once per assistant on day 520, multiples of 100 or 365, and then clear", () => {
  const { mount, runTimer } = page();
  const clock = mount();
  clock.init();
  const identity = (slug: string, days: number) => ({
    slug, metOn: new Date(clock.meetingToday - days * 86400000).toISOString().slice(0, 10)
  });
  for (const days of [0, 1, 519, 601, 731]) {
    clock.celebrateMeetingDay(identity("cedar", days));
    assert.equal(clock.meetingStars.length, 0, String(days));
  }
  for (const days of [100, 365, 520, 600, 730]) {
    const current = identity("cedar", days);
    clock.celebrateMeetingDay(current);
    assert.ok(clock.meetingStars.length > 0, String(days));
    runTimer(4300);
    assert.equal(clock.meetingStars.length, 0);
    clock.destroy();
    const reopened = mount();
    reopened.init();
    reopened.celebrateMeetingDay(current);
    assert.equal(reopened.meetingStars.length, 0);
    reopened.destroy();
    clock.init();
  }
  clock.celebrateMeetingDay(identity("another-assistant", 600));
  assert.ok(clock.meetingStars.length > 0);
  assert.match(MEETING_CARD, /aria-hidden="true"[\s\S]*✨/);
  assert.match(MEETING_CARD_ASSETS, /pointer-events: none/);
});

test("reduced motion keeps the number visible", () => {
  const clock = page(true).mount();
  clock.init();
  clock.celebrateMeetingDay({ slug: "cedar", metOn: "2025-04-01" });
  assert.equal(clock.daysSinceMeeting("2025-04-01"), 600);
  assert.equal(clock.meetingStars.length, 0);
});
