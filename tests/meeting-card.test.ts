import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { MEETING_CARD, MEETING_CARD_ASSETS } from "../src/api/admin/ui/components/meetingCard";
import { meetingMilestone } from "../src/memory/meetingDay";

function page(reducedMotion = false, at = new Date(2026, 10, 22, 23, 59).getTime()) {
  let now = at;
  class LocalDate extends Date {
    constructor(...args: number[]) {
      if (args.length === 0) super(now);
      else super(...(args as [number, number, number]));
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

test("gold stars fall once per assistant on day 520, multiples of 100 and calendar anniversaries, and then clear", () => {
  const { mount, runTimer } = page();
  const clock = mount();
  clock.init();
  const identity = (slug: string, days: number) => ({
    slug, metOn: new Date(clock.meetingToday - days * 86400000).toISOString().slice(0, 10)
  });
  // 1095 days back is 2023-11-23: a multiple of 365, but Feb 29, 2024 moves the anniversary to 1096.
  for (const days of [0, 1, 519, 601, 731, 1095]) {
    clock.celebrateMeetingDay(identity("cedar", days));
    assert.equal(clock.meetingStars.length, 0, String(days));
  }
  for (const days of [100, 365, 520, 600, 730, 1096]) {
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

test("someone who met on Feb 29 gets the anniversary on Feb 28 in other years", () => {
  const onDay = (month: number, day: number) => {
    const clock = page(false, new Date(2026, month, day, 9).getTime()).mount();
    clock.init();
    clock.celebrateMeetingDay({ slug: "cedar", metOn: "2024-02-29" });
    return clock.meetingStars.length;
  };
  assert.ok(onDay(1, 28) > 0);
  assert.equal(onDay(2, 1), 0);
  const firstDay = page(false, new Date(2024, 1, 29, 9).getTime()).mount();
  firstDay.init();
  assert.equal(firstDay.isMeetingAnniversary("2024-02-29"), false);
});

test("Home's stars and the gateway's anniversary note agree on every day", () => {
  const clock = page().mount();
  clock.init();
  for (const metOn of ["2024-02-29", "2025-04-01", "2023-11-22"]) {
    for (let time = Date.parse(metOn); time <= Date.parse("2029-03-31"); time += 86_400_000) {
      clock.meetingToday = time;
      clock.celebrateMeetingDay({ slug: metOn, metOn });
      const today = new Date(time).toISOString().slice(0, 10);
      assert.equal(clock.meetingStars.length > 0, meetingMilestone(metOn, today) !== null, `${metOn} on ${today}`);
    }
  }
});

test("the first-met date reads naturally in each language without shifting a day", () => {
  const clock = page().mount();
  assert.equal(clock.meetingDateLabel("2023-07-26", "zh-CN"), "2023年7月26日");
  assert.equal(clock.meetingDateLabel("2023-07-26", "en-US"), "Jul 26, 2023");
  assert.match(MEETING_CARD, /L\('你和' \+ gwIdentityTitle\(currentIdentity\(\)\), 'You & '/);
});
