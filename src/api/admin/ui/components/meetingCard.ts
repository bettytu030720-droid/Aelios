import { I } from "../helpers";

export const MEETING_CARD = `
        <template x-if="page === 'today' && currentIdentity()?.metOn">
          <div x-data="meetingDayClock()" x-effect="celebrateMeetingDay(currentIdentity())" @focus.window="refreshMeetingDay()">
            <section class="panel meeting-card" x-show="daysSinceMeeting(currentIdentity()?.metOn) !== null" aria-labelledby="meeting-card-title">
              <div class="meeting-card-main">
                <span class="meeting-card-heart" aria-hidden="true">${I.heart}</span>
                <div class="min-w-0">
                  <h2 id="meeting-card-title" class="h2 meeting-card-title" x-text="L('你和' + gwIdentityTitle(currentIdentity()), 'You & ' + gwIdentityTitle(currentIdentity()))"></h2>
                  <p class="meeting-card-date"><span x-text="L('初识于', 'Since')"></span> <time :datetime="currentIdentity()?.metOn" x-text="meetingDateLabel(currentIdentity()?.metOn, locale())"></time></p>
                </div>
              </div>
              <div class="meeting-card-count">
                <span class="meeting-card-caption" x-text="L('认识了', 'Known for')"></span>
                <p class="meeting-card-number">
                  <strong x-text="daysSinceMeeting(currentIdentity()?.metOn)?.toLocaleString(locale())"></strong>
                  <span x-text="L('天', daysSinceMeeting(currentIdentity()?.metOn) === 1 ? 'day' : 'days')"></span>
                </p>
              </div>
            </section>
            <div class="meeting-stars" x-show="meetingStars.length" aria-hidden="true">
              <template x-for="(star, index) in meetingStars" :key="index">
                <span class="meeting-star" :style="star">✨</span>
              </template>
            </div>
          </div>
        </template>
`;

export const MEETING_CARD_ASSETS = `<style>
  /* Frosted glass in the style of iOS: a see-through tint, strong blur and a lit top edge. */
  .panel.meeting-card {
    position: relative; isolation: isolate; overflow: hidden; container-type: inline-size;
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px; padding: 18px; border-radius: 22px;
    background: linear-gradient(135deg, rgba(255, 255, 255, .62), rgba(255, 255, 255, .26));
    border: 1px solid rgba(255, 255, 255, .72);
    backdrop-filter: blur(28px) saturate(180%); -webkit-backdrop-filter: blur(28px) saturate(180%);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .9), inset 0 -1px 0 rgba(255, 255, 255, .28), 0 10px 32px rgba(76, 60, 160, .1);
  }
  .panel.meeting-card::before {
    content: ""; position: absolute; inset: 0; z-index: -1; border-radius: inherit; pointer-events: none;
    background: radial-gradient(120% 90% at 0% 0%, rgba(255, 255, 255, .55), transparent 58%);
  }
  :root[data-theme="dark"] .panel.meeting-card {
    background: linear-gradient(135deg, rgba(255, 255, 255, .13), rgba(255, 255, 255, .04));
    border-color: rgba(255, 255, 255, .16);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .22), inset 0 -1px 0 rgba(255, 255, 255, .05), 0 12px 36px rgba(0, 0, 0, .35);
  }
  :root[data-theme="dark"] .panel.meeting-card::before {
    background: radial-gradient(120% 90% at 0% 0%, rgba(255, 255, 255, .14), transparent 58%);
  }
  .meeting-card-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1 1 auto; }
  .meeting-card-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meeting-card-heart {
    display: grid; place-items: center; width: 42px; height: 42px; flex: none; border-radius: 14px; color: var(--re);
    background: rgba(255, 255, 255, .5); border: 1px solid rgba(255, 255, 255, .78);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .95), 0 2px 10px rgba(76, 60, 160, .08);
  }
  :root[data-theme="dark"] .meeting-card-heart {
    background: rgba(255, 255, 255, .08); border-color: rgba(255, 255, 255, .14);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .18);
  }
  .meeting-card-date { margin-top: 3px; color: var(--t3); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meeting-card-count { display: flex; flex-direction: column; align-items: flex-end; flex: none; }
  .meeting-card-caption { color: var(--t3); font-size: 12px; }
  .meeting-card-number { display: flex; align-items: baseline; gap: 6px; color: var(--re); white-space: nowrap; }
  .meeting-card-number strong { font-size: 42px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.1; letter-spacing: -.02em; }
  /* Phone width: a smaller icon and number keep the name, the date and the count on one row. */
  @container (max-width: 420px) {
    .meeting-card-heart { width: 36px; height: 36px; border-radius: 12px; }
    .meeting-card-number strong { font-size: 30px; }
    .meeting-card-number span, .meeting-card-caption { font-size: 11px; }
  }
  .meeting-stars { position: fixed; inset: 0; z-index: 80; overflow: hidden; pointer-events: none; }
  .meeting-star {
    position: absolute; top: -60px; left: var(--star-left); font-size: var(--star-size); line-height: 1;
    animation: meeting-star-fall var(--star-time) linear var(--star-delay) both;
  }
  @keyframes meeting-star-fall {
    from { opacity: 0; transform: translate3d(0, 0, 0) rotate(-10deg); }
    15%, 78% { opacity: 1; }
    to { opacity: 0; transform: translate3d(var(--star-drift), calc(100vh + 120px), 0) rotate(12deg); }
  }
  @media (prefers-reduced-motion: reduce) { .meeting-stars { display: none !important; } }
</style>
<script>
const playedMeetingMilestones = new Set();

function meetingDayClock() {
  let midnightTimer;
  let starsTimer;
  let viewedMilestone;
  return {
    meetingToday: NaN,
    meetingStars: [],
    init() { this.refreshMeetingDay(); },
    destroy() {
      window.clearTimeout(midnightTimer);
      window.clearTimeout(starsTimer);
    },
    refreshMeetingDay() {
      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth();
      const day = now.getDate();
      this.meetingToday = Date.UTC(year, month, day);
      const nextMidnight = new Date(year, month, day + 1);
      window.clearTimeout(midnightTimer);
      midnightTimer = window.setTimeout(() => this.refreshMeetingDay(), nextMidnight.getTime() - now.getTime());
    },
    // "2023年7月26日" or "Jul 26, 2023". The date is read and written in UTC so no time zone can shift it.
    meetingDateLabel(metOn, locale) {
      const time = Date.parse(metOn);
      if (!Number.isFinite(time)) return metOn || '';
      return new Date(time).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    },
    daysSinceMeeting(metOn) {
      // Convert both calendar dates to UTC midnights so DST cannot add or subtract a day.
      const days = (this.meetingToday - Date.parse(metOn)) / 86400000;
      return Number.isInteger(days) && days >= 0 ? days : null;
    },
    // Same month and day as the first meeting, in a later year. Feb 29 counts as Feb 28 in other years.
    isMeetingAnniversary(metOn) {
      const [metYear, month, day] = String(metOn || '').split('-').map(Number);
      if (!metYear || !month || !day || !Number.isFinite(this.meetingToday)) return false;
      const today = new Date(this.meetingToday);
      const year = today.getUTCFullYear();
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return year > metYear && today.getUTCMonth() + 1 === month && today.getUTCDate() === Math.min(day, lastDay);
    },
    celebrateMeetingDay(identity) {
      const days = this.daysSinceMeeting(identity?.metOn);
      const milestone = [identity?.slug, this.meetingToday, days].join(':');
      if (viewedMilestone === milestone) return;
      viewedMilestone = milestone;
      window.clearTimeout(starsTimer);
      this.meetingStars = [];
      if (!days || (days !== 520 && days % 100 !== 0 && !this.isMeetingAnniversary(identity?.metOn)) ||
        playedMeetingMilestones.has(milestone) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      playedMeetingMilestones.add(milestone);
      const count = 18;
      this.meetingStars = Array.from({ length: count }, (_, index) => ({
        '--star-left': ((index + Math.random()) * 96 / count) + '%',
        '--star-size': Math.round(26 + Math.random() * 19) + 'px',
        '--star-delay': Math.round(Math.random() * 820) + 'ms',
        '--star-time': Math.round(2300 + Math.random() * 1100) + 'ms',
        '--star-drift': Math.round((Math.random() - 0.5) * 76) + 'px'
      }));
      starsTimer = window.setTimeout(() => { this.meetingStars = []; }, 4300);
    }
  };
}
</script>`;
