import { I, t } from "../helpers";

export const MEETING_CARD = `
        <template x-if="page === 'today' && currentIdentity()?.metOn">
          <div x-data="meetingDayClock()" x-effect="celebrateMeetingDay(currentIdentity())" @focus.window="refreshMeetingDay()">
            <section class="panel meeting-card" x-show="daysSinceMeeting(currentIdentity()?.metOn) !== null" aria-labelledby="meeting-card-title">
              <div class="meeting-card-main">
                <span class="meeting-card-heart" aria-hidden="true">${I.heart}</span>
                <div class="min-w-0">
                  <h2 id="meeting-card-title" class="h2" x-text="L('你和' + gwIdentityTitle(currentIdentity()) + '认识了', 'You’ve known ' + gwIdentityTitle(currentIdentity()) + ' for')"></h2>
                  <p class="meeting-card-date">${t("初识于", "Since")} <time :datetime="currentIdentity()?.metOn" x-text="currentIdentity()?.metOn"></time></p>
                </div>
              </div>
              <p class="meeting-card-count">
                <strong x-text="daysSinceMeeting(currentIdentity()?.metOn)?.toLocaleString(locale())"></strong>
                <span x-text="L('天', daysSinceMeeting(currentIdentity()?.metOn) === 1 ? 'day' : 'days')"></span>
              </p>
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
  .panel.meeting-card {
    display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
    gap: 12px 20px; padding: 14px 18px;
    background: linear-gradient(115deg, var(--reb), transparent 72%), var(--panel);
  }
  .meeting-card-main { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1 1 180px; }
  .meeting-card-main h2 { word-break: normal; overflow-wrap: anywhere; }
  .meeting-card-heart {
    display: grid; place-items: center; width: 38px; height: 38px; flex: none;
    border-radius: 12px; background: var(--reb); color: var(--re);
  }
  .meeting-card-date { margin-top: 2px; color: var(--t3); font-size: 12px; }
  .meeting-card-count { display: flex; align-items: baseline; gap: 6px; margin-inline-start: auto; color: var(--re); white-space: nowrap; }
  .meeting-card-count strong { font-size: clamp(30px, 4vw, 42px); font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.15; }
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
    daysSinceMeeting(metOn) {
      // Convert both calendar dates to UTC midnights so DST cannot add or subtract a day.
      const days = (this.meetingToday - Date.parse(metOn)) / 86400000;
      return Number.isInteger(days) && days >= 0 ? days : null;
    },
    celebrateMeetingDay(identity) {
      const days = this.daysSinceMeeting(identity?.metOn);
      const milestone = [identity?.slug, this.meetingToday, days].join(':');
      if (viewedMilestone === milestone) return;
      viewedMilestone = milestone;
      window.clearTimeout(starsTimer);
      this.meetingStars = [];
      if (!days || (days !== 520 && days % 100 !== 0 && days % 365 !== 0) ||
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
