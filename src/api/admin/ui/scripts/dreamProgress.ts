export const ADMIN_SCRIPT_DREAM_PROGRESS = `    nightlyProgress(status, date, visibleDiary) {
      const day = (status.raw_message_counts || []).find(item => item.date_label === date);
      const cursor = (status.cursors || []).find(item => item.date_label === date)?.cursor;
      const done = typeof cursor === 'string' && cursor.startsWith('done:');
      const run = (status.dream_runs || []).find(item => item.date_label === date && item.reason !== 'dry_run');
      const active = status.active_run;
      const busy = active && active.date_label === date && !active.stale;
      const stopped = (active && active.date_label === date && active.stale) || run?.status === 'error';
      const stages = status.followups?.[date] || {};
      const empty = day?.raw_messages === 0;
      const off = status.nightly_enabled === false;
      const diaryNeedsWork = status.diary_enabled !== false && (stages.diary?.status === 'failed' ||
        (visibleDiary === false && (!stages.diary || stages.diary.status === 'written')));
      const followupNeedsWork = diaryNeedsWork || ['failed', 'partial'].includes(stages.review?.status);
      const canContinue = !off && !empty && !busy && (done ? followupNeedsWork : stopped || Boolean(cursor));
      let title = this.L('等待整理', 'Waiting to be processed');
      if (busy) title = active.status === 'queued' ? this.L('已排队', 'Queued') : this.L('正在整理对话', 'Organizing chats');
      else if (empty) title = this.L('这一天没有对话', 'No chats on this date');
      else if (done) title = this.L('对话已整理', 'Chats processed');
      else if (off) title = this.L('夜间整理已关闭', 'Nightly Dream is off');
      else if (stopped || cursor) title = this.L('还有对话待整理', 'Some chats still need processing');
      return {
        date, title, done, busy, canContinue,
        needsAttention: !busy && !empty && (canContinue || Boolean(active?.stale && active.date_label === date)),
        review: empty ? '' : this.nightlyReviewLabel(stages.review, status.review_enabled, done),
        diary: empty ? '' : this.nightlyDiaryLabel(stages.diary, status.diary_enabled, done, visibleDiary)
      };
    },
    homeNightlyProgress() {
      const status = this.home.status;
      if (!status || !status.anchor_date_label || this.home.dreamStatusError) return null;
      return this.nightlyProgress(status, status.anchor_date_label, this.homeHasDiary(status.anchor_date_label));
    },
    homeNightlyColor() {
      const progress = this.homeNightlyProgress();
      if (!progress) return 'var(--t3)';
      if (progress.needsAttention || progress.busy) return 'var(--warn)';
      if (progress.done) return 'var(--ok)';
      return 'var(--t3)';
    },
    homeNightlySub() {
      if (this.home.dreamStatusError) return this.L('刷新再看', 'Refresh to retry');
      const progress = this.homeNightlyProgress();
      if (!progress) return this.L('还没有记录', 'No runs yet');
      return [progress.review, progress.diary].filter(Boolean).join(' · ') || this.dayLabel(progress.date, true);
    },
    homeHasDiary(date) {
      if (!this.home.diaryLoaded || this.home.diary?.date > date) return undefined;
      return this.home.diary?.date === date;
    },
    nightlyReviewLabel(review, enabled, done) {
      if (review?.status === 'off' || (!review && enabled === false)) return this.L('自动审核已关闭', 'Auto-review is off');
      if (review?.status === 'failed') return this.L('自动审核没完成', 'Auto-review did not finish');
      if (review?.status === 'partial') {
        return review.failed ? this.L('有 ' + review.failed + ' 条暂未审完', review.failed + ' items could not be reviewed')
          : this.L('还有记忆待审核', 'More items are waiting for review');
      }
      if (review?.status === 'done') return review.approved
        ? this.L('本轮自动通过 ' + review.approved + ' 条', review.approved + ' approved in the last review')
        : this.L('本轮没有自动通过的新记忆', 'No memories approved in the last review');
      return done ? this.L('还没有审核结果', 'No review result recorded') : this.L('等待自动审核', 'Waiting for review');
    },
    nightlyDiaryLabel(diary, enabled, done, visibleDiary) {
      if (diary?.status === 'failed') return this.L('日记还没写成', 'Journal could not be written')
        + (diary.reason && diary.reason !== 'diary_writer_failed' ? ' · ' + this.diaryReasonLabel(diary.reason) : '');
      if (diary?.status === 'skipped') return this.diaryReasonLabel(diary.reason);
      if (visibleDiary === true || (visibleDiary !== false && diary?.status === 'written')) return this.L('日记已写好', 'Journal is ready');
      if (diary?.status === 'off' || enabled === false) return this.L('日记生成已关闭', 'Journal writing is off');
      if (done && visibleDiary === false) return this.L('日记还没写好', 'Journal is still missing');
      return done ? this.L('日记状态待确认', 'Journal status unconfirmed') : this.L('整理完对话后写日记', 'Journal follows chat processing');
    },
    openDreamProgress(progress, status) {
      if (!progress || !status) return;
      const active = status.active_run;
      if (active) {
        if (this.page !== 'dream') {
          this.dreamActiveRun = active;
          this.go('dream');
        }
        this.revealSoon('dream-active-run');
      } else if (progress.canContinue) {
        this.prepareDreamResume(progress.date);
      }
    },
    canResumeDreamRun(run) {
      const status = this.dreamStatus;
      if (!status || status.active_run || run.reason === 'dry_run') return false;
      const latest = this.dreamRuns.find(item => item.date_label === run.date_label && item.reason !== 'dry_run');
      return latest?.id === run.id && this.nightlyProgress(status, run.date_label).canContinue;
    },
`;
