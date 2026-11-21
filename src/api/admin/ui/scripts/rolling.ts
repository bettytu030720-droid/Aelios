export const ADMIN_SCRIPT_ROLLING = `    rollingStatus() {
      return this.dreamStatus && this.dreamStatus.rolling;
    },
    rollingShouldPoll() {
      const rolling = this.rollingStatus();
      const window = rolling && rolling.current_window;
      return Boolean(window && (window.state === 'running' || window.state === 'retrying'));
    },
    async loadRollingStatus() {
      const revision = this.spaceRevision;
      try {
        const data = await this.request(this.withNamespace('/v1/dream/status?view=rolling'));
        if (revision !== this.spaceRevision || this.page !== 'dream') return;
        const rolling = data.data && data.data.rolling;
        if (!rolling) throw new Error('Missing Daytime Dream status');
        this.dreamStatus = { ...this.dreamStatus, rolling: { ...this.rollingStatus(), ...rolling } };
        this.rollingStatusError = '';
        this.scheduleDreamPolling();
      } catch {
        if (revision !== this.spaceRevision || this.page !== 'dream') return;
        this.rollingStatusError = this.L('白天整理状态刷新失败。显示的是上次读到的结果。', 'Couldn’t refresh Daytime Dream. The last known status is shown.');
      }
    },
    rollingCurrentLabel(window) {
      const labels = {
        running: ['处理中', 'Running'],
        retrying: ['等待重试', 'Waiting to retry'],
        stalled: ['可能卡住', 'May be stalled'],
        paused: ['等待夜间接手', 'Waiting for nightly Dream']
      };
      return this.L(...(labels[window.state] || labels.running));
    },
    rollingPhaseLabel(phase) {
      const labels = {
        triage: ['Clef 筛选', 'Clef screening'],
        extraction: ['模型抽取', 'Model extraction'],
        write: ['写入条目', 'Saving records'],
        finish: ['整理收尾', 'Finishing']
      };
      return this.L(...(labels[phase] || labels.finish));
    },
    rollingFailureLabel(window) {
      const failure = window.failure || window.last_failure;
      const reason = failure && failure.reason || window.error;
      const labels = {
        triage_failed: ['Clef 筛选失败或没有返回有效判断', 'Clef screening failed or returned no usable verdict'],
        triage_timeout: ['Clef 筛选超时', 'Clef screening timed out'],
        extraction_failed: ['模型抽取失败', 'Model extraction failed'],
        extractor_timeout: ['模型抽取超时', 'Model extraction timed out'],
        extractor_http_error: ['模型服务拒绝或未能完成请求', 'The model service rejected or could not complete the request'],
        extractor_request_failed: ['无法完成模型请求', 'The model request could not be completed'],
        extractor_truncated: ['模型输出被长度上限截断', 'The model output reached its length limit'],
        extractor_invalid_json: ['模型输出无法解析为 JSON', 'The model output was not valid JSON'],
        extractor_invalid_shape: ['模型输出的字段不符合要求', 'The model output had an unexpected structure'],
        extractor_invalid_operation: ['模型返回了未知的记忆操作', 'The model returned an unknown memory operation'],
        attempts_exhausted: ['已用完重试次数', 'Retry limit reached'],
        lease_changed: ['处理权已变化，当前尝试中止', 'The window lease changed and this attempt stopped'],
        window_processing_failed: ['处理过程中出错', 'An error occurred while processing this window']
      };
      const label = this.L(...(labels[reason] || labels.window_processing_failed));
      return label + (failure && failure.http_status ? ' (HTTP ' + failure.http_status + ')' : '');
    },
    rollingOutcomeLabel(window) {
      if (window.status === 'failed') return this.L('失败', 'Failed');
      if (!window.extractor_calls) return this.L('筛选后跳过', 'Skipped after screening');
      if (!window.writes) return this.L('已完成', 'Completed');
      if (window.writes.candidates || window.writes.memories || window.writes.revisions) return this.L('有写入', 'Records saved');
      return this.L('没有写入', 'Nothing saved');
    },
    rollingWriteSummary(window) {
      if (!window.extractor_calls && window.status === 'completed') {
        return this.L('这段对话未进入抽取。', 'This window did not need extraction.');
      }
      if (!window.writes) return this.L('这条历史记录没有写入明细。', 'This older run has no write details.');
      const { candidates, memories, revisions } = window.writes;
      const summary = this.L('待审候选 ' + candidates + ' 条 · 入库记忆 ' + memories + ' 条',
        candidates + ' review candidates · ' + memories + ' memories saved');
      return summary + (revisions ? this.L(' · 历史修订 ' + revisions + ' 条', ' · ' + revisions + ' historical revisions') : '');
    },
    rollingDispositionLabel(window) {
      if (window.disposition === 'nightly') return this.L('原话已留给夜间抽取。', 'The original messages were left for nightly extraction.');
      if (window.disposition === 'check_writes') {
        return this.L('写入未确认，部分条目可能已保存。请核对待审和记忆库。', 'Saving did not finish. Check Review and Memories for records that may already have been saved.');
      }
      return '';
    },
    rollingWindowTime(iso) {
      return iso ? new Date(iso).toLocaleString(this.lang === 'en' ? 'en' : 'zh-CN') : '';
    },
    olderRollingFailures() {
      const rolling = this.rollingStatus();
      if (!rolling) return [];
      const recent = new Set(rolling.recent_windows.map(window => window.window_key));
      return rolling.failed_windows.filter(window => !recent.has(window.window_key));
    },
    homeRollingWarning() {
      const rolling = this.home.rolling;
      if (this.home.dreamStatusError) return this.L('白天整理状态读取失败。', 'Couldn’t read Daytime Dream status.');
      if (!rolling) return '';
      if (rolling.on && rolling.queue_available === false) return this.L('白天整理无法启动，找不到处理队列。', 'Daytime Dream cannot start because the queue is missing.');
      const failure = rolling.failed_windows && rolling.failed_windows[0];
      if (failure && Date.parse(failure.finished_at) > Date.now() - 7 * 86400000) {
        return this.L('最近一次失败 ', 'Last failure ') + this.rollingWindowTime(failure.finished_at) + ' · ' + this.rollingFailureLabel(failure);
      }
      return '';
    },
    homeRollingSummary() {
      const rolling = this.home.rolling;
      if (!rolling || this.home.dreamStatusError) return '';
      const current = rolling.current_window;
      if (current) {
        const summary = this.rollingCurrentLabel(current) + ' · ' + this.rollingPhaseLabel(current.phase);
        return summary + (current.last_failure ? ' · ' + this.rollingFailureLabel(current) : '');
      }
      const last = rolling.recent_windows && rolling.recent_windows[0];
      if (!rolling.on) return this.L('白天整理已关闭。', 'Daytime Dream is off.');
      if (last && last.status === 'failed') return this.rollingDispositionLabel(last);
      return last ? this.L('最近一批 ', 'Latest window ') + this.rollingOutcomeLabel(last) + ' · ' + this.rollingWriteSummary(last)
        : this.L('还没有白天整理记录。', 'No Daytime Dream windows yet.');
    },
`;
