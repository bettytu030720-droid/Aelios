type Translate = (zh: string, en: string) => string;

function windowResult(t: Translate) {
  return `<article class="py-3">
    <div class="flex flex-wrap items-center gap-2">
      <span class="chip" :class="window.status === 'failed' ? 'chip-err' : window.writes && (window.writes.candidates || window.writes.memories || window.writes.revisions) ? 'chip-ok' : 'chip-dim'" x-text="rollingOutcomeLabel(window)"></span>
      <time class="text-xs muted" :datetime="window.finished_at" x-text="rollingWindowTime(window.finished_at)"></time>
      <span class="text-xs muted" x-show="window.message_count != null" x-text="L(window.message_count + ' 条消息', window.message_count + ' messages')"></span>
    </div>
    <p class="mt-1 text-sm" x-text="window.status === 'failed' ? rollingFailureLabel(window) : rollingWriteSummary(window)"></p>
    <p x-show="window.disposition" class="mt-1 text-xs muted" x-text="rollingDispositionLabel(window)"></p>
    <div x-show="window.writes" class="mt-1 flex flex-wrap gap-3 text-xs">
      <button x-show="window.writes && window.writes.candidates" type="button" @click="reviewTab = 'daily'; go('review')" class="link">${t("查看待审候选", "Open Review")}</button>
      <button x-show="window.writes && (window.writes.memories || window.writes.revisions)" type="button" @click="go('memory')" class="link">${t("打开记忆库", "Open Memories")}</button>
    </div>
    <details class="mt-1 text-xs muted">
      <summary class="cursor-pointer">${t("调用详情", "Call details")}</summary>
      <p class="mt-1 break-all" x-text="window.model || L('当时使用的模型未记录', 'Model was not recorded')"></p>
      <p x-text="L('尝试 ' + window.attempts + ' 次 · Clef ' + window.clef_calls + ' 次 · 抽取 ' + window.extractor_calls + ' 次', window.attempts + ' attempts · ' + window.clef_calls + ' Clef calls · ' + window.extractor_calls + ' extraction calls')"></p>
      <p x-show="Number.isFinite(window.duration_ms)" x-text="L('耗时 ', 'Elapsed ') + Math.round(window.duration_ms / 1000) + L(' 秒', ' s')"></p>
      <p x-show="window.failure" x-text="window.failure && rollingPhaseLabel(window.failure.phase)"></p>
      <p x-show="window.status === 'completed' && window.last_failure" x-text="L('重试前 ', 'Before retrying ') + rollingFailureLabel(window)"></p>
      <code class="break-all" x-text="window.window_key"></code>
    </details>
  </article>`;
}

export function rollingStatusPanel(t: Translate): string {
  return `<template x-if="rollingStatus()">
    <section id="daytime-dream" class="panel panel-pad space-y-3">
      <div class="flex flex-wrap items-baseline gap-2">
        <h2 class="h2">${t("白天整理", "Daytime Dream")}</h2>
        <span class="chip" :class="rollingStatus().on ? 'chip-ok' : 'chip-dim'" x-text="rollingStatus().on ? L('已开启', 'On') : L('已关闭', 'Off')"></span>
        <span x-show="rollingStatus().on && rollingStatus().backlog != null" class="text-xs muted" x-text="L('上次刷新时待整理 ' + rollingStatus().backlog + ' 条', rollingStatus().backlog + ' messages waiting at last refresh')"></span>
      </div>
      <p class="text-xs muted break-all" x-show="rollingStatus().model" x-text="L('抽取模型 ', 'Extraction model ') + rollingStatus().model"></p>
      <p role="status" x-show="rollingStatusError" class="banner banner-warn" x-text="rollingStatusError"></p>
      <p x-show="rollingStatus().on && rollingStatus().queue_available === false" class="banner banner-warn">${t("白天整理缺少队列，无法启动。", "Daytime Dream cannot start because its queue is missing.")}</p>
      <template x-for="current in rollingStatus().current_window ? [rollingStatus().current_window] : []" :key="current.window_key">
        <div class="banner" :class="current.state === 'running' ? '' : 'banner-warn'" role="status">
          <div class="min-w-0 space-y-1">
            <div class="font-semibold" x-text="rollingCurrentLabel(current) + ' · ' + rollingPhaseLabel(current.phase)"></div>
            <p class="text-xs" x-text="L('尝试 ', 'Attempts ') + current.attempts + (current.max_attempts ? ' / ' + current.max_attempts : '') + L(' · 最近进度 ', ' · Last progress ') + rollingWindowTime(current.last_activity_at)"></p>
            <p class="text-xs break-all" x-show="current.phase === 'extraction'" x-text="current.model"></p>
            <p class="text-xs" x-show="current.last_failure" x-text="rollingFailureLabel(current)"></p>
            <p class="text-xs" x-show="current.state === 'stalled'">${t("这一批长时间没有确认进度。可用下方的窗口编号核对 Worker 日志。", "This window has reported no progress for some time. Use the window ID to check the Worker logs.")}</p>
            <code class="text-xs break-all" x-text="current.window_key"></code>
          </div>
        </div>
      </template>
      <div x-show="!rollingStatus().recent_windows.length" class="text-sm muted">${t("还没有白天整理结果。", "No Daytime Dream results yet.")}</div>
      <div x-show="rollingStatus().recent_windows.length">
        <h3 class="font-semibold">${t("最近结果", "Recent results")}</h3>
        <div class="divide">
          <template x-for="window in rollingStatus().recent_windows" :key="window.window_key">${windowResult(t)}</template>
        </div>
      </div>
      <details x-show="olderRollingFailures().length">
        <summary class="cursor-pointer text-sm font-medium">${t("更早的失败", "Earlier failures")}</summary>
        <div class="divide">
          <template x-for="window in olderRollingFailures()" :key="window.window_key">${windowResult(t)}</template>
        </div>
      </details>
    </section>
  </template>`;
}
