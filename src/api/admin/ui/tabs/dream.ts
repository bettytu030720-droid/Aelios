import { I, t } from "../helpers";
import { rollingStatusPanel } from "../../rolling";
import { nightlyProgressCard } from "../components/dreamProgress";

export const ADMIN_TAB_DREAM = `      <!-- ===== 夜间整理 ===== -->
      <section x-show="savedApiKey.trim() && page === 'dream'" class="page" @visibilitychange.document="if (!document.hidden && page === 'dream' && !rollingStatusError) scheduleDreamPolling()">
        <header class="page-head">
          <div>
            <h1 class="h1">${t("整理记录", "Dream activity")}</h1>
          </div>
          <button type="button" @click="refreshDream()" class="btn btn-icon inline-flex" :aria-label="L('刷新', 'Refresh')" :title="L('刷新', 'Refresh')">${I.refresh}</button>
        </header>

        <p x-show="dreamStatusError" role="status" class="banner banner-warn" x-text="dreamStatusError"></p>
        ${nightlyProgressCard("dreamStatus")}
        ${rollingStatusPanel(t)}

        <div class="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
          <div class="flex flex-col gap-5">
            <section class="panel">
              <div class="panel-head">
                <h2 class="h2">${t("每天的对话量", "Chats per day")}</h2>
                <span class="text-xs muted" x-text="dreamStatus && dreamStatus.time_zone ? L('按 ', 'Days follow ') + dreamStatus.time_zone + L(' 分天', '') : ''"></span>
              </div>
              <div class="flex flex-col gap-2.5 px-[18px] py-4">
                <template x-if="dreamDayBars().length === 0"><p class="text-[13px] muted">${t("还没有消息记录。", "No messages yet.")}</p></template>
                <template x-for="day in dreamDayBars()" :key="day.date">
                  <div class="day-bar">
                    <span class="w-[72px] flex-none muted" x-text="dayLabel(day.date, true)"></span>
                    <span class="raw-bar-track" aria-hidden="true"><span class="raw-bar-fill block" :class="day.done ? 'is-done' : ''" :style="'width:' + day.widthPct + '%'"></span></span>
                    <span class="w-10 flex-none text-right tabular-nums" :style="day.pending ? 'color: var(--ct)' : ''" x-text="day.raw"></span>
                    <span class="chip hidden flex-none sm:inline-flex" :class="day.done ? 'chip-ok' : (day.pending ? 'chip-warn' : 'chip-dim')" x-text="day.stateLabel"></span>
                  </div>
                </template>
              </div>
            </section>

            <section id="dream-run" class="panel panel-pad flex flex-col gap-4">
              <div>
                <h2 class="h2">${t("按日期继续整理", "Continue by date")}</h2>
                <p class="mt-1 text-[13px] muted">${t("从上次保存的进度接着做。提交后可以关掉页面。", "Continue from the last saved progress. You can close this page after submitting.")}</p>
              </div>
              <div class="flex flex-wrap items-end gap-3">
                <label class="block"><span class="label">${t("对话日期", "Chat date")}</span><input type="date" x-model="dreamDate" class="field w-auto"></label>
                <label class="check"><input type="checkbox" x-model="dreamDryRun"><span>${t("只预览，不写入", "Preview only, don’t save")}</span></label>
                <button type="button" @click="triggerDream()" :disabled="dreamTriggering || (!dreamDryRun && dreamActiveRun)" class="btn btn-primary ml-auto">${I.moon}<span x-text="dreamTriggering ? (dreamDryRun ? L('预览中，请保持页面打开…', 'Previewing. Keep this page open…') : L('提交中…', 'Submitting…')) : (dreamDryRun ? L('预览', 'Preview') : L('继续整理', 'Continue'))"></span></button>
              </div>
              <details class="text-xs muted">
                <summary class="cursor-pointer">${t("更多选项", "More options")}</summary>
                <label class="check mt-2"><input type="checkbox" x-model="dreamForce"><span>${t("从头重新整理这一天", "Start this date from the beginning")}</span></label>
              </details>

              <div id="dream-active-run" x-show="dreamActiveRun" class="banner flex-wrap" :class="dreamActiveRun && dreamActiveRun.stale ? 'banner-warn' : ''">
                <div class="min-w-0 flex-1">
                  <div x-text="dreamActiveRun && (dayLabel(dreamActiveRun.date_label, true) + ' · ' + dreamStatusLabel(dreamActiveRun.status, dreamActiveRun.stale))"></div>
                  <p class="mt-1 text-xs" x-show="dreamActiveRun && dreamActiveRun.stale">${t("超过 20 分钟没收到完成结果。确认任务已经停止后，可以标记中断并继续这一天。", "No completion was recorded within 20 minutes. If the task has stopped, mark it as stopped and continue this date.")}</p>
                  <details class="mt-1 text-xs muted" x-show="dreamActiveRun">
                    <summary class="cursor-pointer">${t("技术详情", "Technical details")}</summary>
                    <code class="break-all" x-text="dreamActiveRun?.id"></code>
                  </details>
                </div>
                <button type="button" x-show="dreamActiveRun && dreamActiveRun.stale" @click="resolveDreamRun()" :disabled="dreamResolving" class="btn btn-sm btn-warn"><span x-text="dreamResolving ? L('标记中…', 'Marking…') : L('标记为中断', 'Mark as stopped')"></span></button>
              </div>

              <div x-show="dreamRunResult" class="flex flex-col gap-3">
                <template x-if="dreamRunResult && dreamRunResult.run_id">
                  <div class="banner" x-text="dayLabel(dreamRunResult.date, true) + ' · ' + dreamStatusLabel(dreamRunResult.status, dreamRunResult.stale)"></div>
                </template>
                <template x-if="dreamRunResult && dreamRunResult.result && !dreamRunResult.result.ran">
                  <div class="banner" x-text="dreamReasonLabel(dreamRunResult.result.reason)"></div>
                </template>
                <template x-if="dreamRunResult && !dreamRunResult.dry_run && dreamRunResult.result && dreamRunResult.result.ran">
                  <div class="banner banner-ok"><span class="font-semibold">${t("这一批对话已整理。", "This batch of chats is processed.")}</span> <span x-text="dreamRunStatsLine()"></span></div>
                </template>
                <template x-if="dreamRunResult && dreamRunResult.dry_run && dreamRunResult.result && dreamRunResult.result.ran">
                  <div class="flex flex-col gap-3 rounded-[12px] p-4" style="background: var(--soft)">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-semibold" x-text="L('预览 · ', 'Preview · ') + dayLabel(dreamDate || dreamAnchorDate())"></span>
                      <span class="chip chip-ok" x-text="L('新增 ', '') + dreamProposalList('memories_to_add').length + L('', ' new')"></span>
                      <span class="chip chip-warn" x-text="L('更新 ', '') + dreamProposalList('memories_to_update').length + L('', ' updated')"></span>
                      <span class="chip chip-err" x-text="L('移除 ', '') + dreamProposalList('memories_to_delete').length + L('', ' removed')"></span>
                    </div>
                    <div x-show="dreamProposal() && (dreamProposal().title || dreamProposal().summary)">
                      <div class="font-semibold" x-text="dreamProposal() && (dreamProposal().title || '')"></div>
                      <p class="mt-1 whitespace-pre-wrap text-[13px] leading-6" style="color: var(--t2)" x-text="dreamProposal() && (dreamProposal().summary || '')"></p>
                    </div>
                    <template x-if="dreamExtracted().length === 0"><p class="text-[13px] muted">${t("这一晚没有找到要记的。", "Nothing worth remembering from this night.")}</p></template>
                    <template x-for="(mem, idx) in dreamExtracted()" :key="idx">
                      <div class="flex items-start gap-2.5">
                        <span class="chip" :class="typeChipClass(mem.type)" x-text="typeLabel(mem.type)"></span>
                        <span class="min-w-0 flex-1 text-sm leading-6" x-text="mem.content"></span>
                      </div>
                    </template>
                    <details>
                      <summary class="text-xs muted">${t("技术细节", "Technical details")}</summary>
                      <div class="mt-2 flex flex-col gap-2">
                        <template x-if="dreamRoutingGroups().length === 0"><p class="text-xs muted">${t("没有路由项。", "No routing items.")}</p></template>
                        <template x-for="group in dreamRoutingGroups()" :key="group.key">
                          <div>
                            <div class="mb-1 flex items-center gap-2 text-xs"><span class="chip chip-violet" x-text="group.label"></span><span class="muted" x-text="group.items.length"></span></div>
                            <template x-for="(item, i) in group.items" :key="i">
                              <div class="flex items-start gap-2 text-xs leading-6"><span class="chip chip-dim" x-text="dreamRoutingKindLabel(item.kind)"></span><span class="min-w-0 flex-1" x-text="item.content || item.target_id || item.fact_key || '—'"></span></div>
                            </template>
                          </div>
                        </template>
                      </div>
                    </details>
                  </div>
                </template>
              </div>
            </section>
          </div>

          <section class="panel panel-pad">
            <h2 class="h2">${t("最近 7 天的整理批次", "Processing batches in the last 7 days")}</h2>
            <p x-show="dreamFinishedCount()" class="mb-4 mt-1 text-xs muted" x-text="L(dreamOkCount() + ' / ' + dreamFinishedCount() + ' 批完成 · 处理 ' + dreamProcessedTotal() + ' 条消息', dreamOkCount() + ' / ' + dreamFinishedCount() + ' batches completed · ' + dreamProcessedTotal() + ' messages processed')"></p>
            <template x-if="dreamRuns.length === 0"><p class="text-[13px] muted">${t("近 7 天还没有整理记录。", "No runs in the last 7 days.")}</p></template>
            <div class="dream-rail flex flex-col gap-4">
              <template x-for="run in dreamRuns" :key="run.id">
                <div class="dream-rail-item" :class="dreamRailClass(run.stale ? 'stale' : run.status)">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-semibold" x-text="dayLabel(run.date_label, true)"></span>
                    <span class="chip" :class="dreamStatusChipClass(run.status)">
                      <span x-show="run.status === 'running' && !run.stale" class="breathe inline-block h-1.5 w-1.5 rounded-full bg-current"></span>
                      <span x-text="dreamStatusLabel(run.status, run.stale)"></span>
                    </span>
                    <span class="text-xs muted" x-text="dreamTriggerLabel(run.trigger) + ' · ' + dreamDuration(run)"></span>
                  </div>
                  <p x-show="run.processed_messages != null" class="mt-0.5 text-xs muted" x-text="L(run.processed_messages + ' 条消息', run.processed_messages + ' messages')"></p>
                  <p x-show="dreamRunNote(run)" class="mt-1 text-xs leading-5" x-text="dreamRunNote(run)"></p>
                  <button type="button" x-show="canResumeDreamRun(run)" @click="prepareDreamResume(run.date_label)" class="btn btn-sm mt-2" x-text="L('继续这一天', 'Continue this date')"></button>
                  <details class="mt-1 text-xs muted">
                    <summary class="cursor-pointer">${t("技术详情", "Technical details")}</summary>
                    <div class="mt-1 space-y-1 break-all">
                      <p x-text="run.model || L('模型未记录', 'Model not recorded')"></p>
                      <code x-text="run.id"></code>
                      <pre x-show="run.reason || run.error" class="whitespace-pre-wrap" x-text="[run.reason, run.error].filter(Boolean).join(' · ')"></pre>
                    </div>
                  </details>
                </div>
              </template>
            </div>
          </section>
        </div>

        <section class="panel">
          <div class="panel-head pb-1">
            <div>
              <h2 class="h2">${t("按日期查看记忆变动", "Memory changes by date")}</h2>
              <p class="mt-1 text-[13px] muted">${t("以实际写入和审核的日期为准。", "Dates reflect when records were saved or reviewed.")}</p>
            </div>
            <label class="flex items-center gap-2 text-[13px] muted"><span>${t("日期", "Date")}</span><input type="date" x-model="dreamHarvestDate" @change="loadDreamHarvest()" class="field field-sm"></label>
          </div>
          <div x-show="dreamHarvestLoading" class="px-[18px] py-4 text-[13px] muted" x-text="L('加载中…', 'Loading…')"></div>
          <div x-show="!dreamHarvest && !dreamHarvestLoading" class="px-[18px] py-4 text-[13px] muted">${t("选一个日期看看。", "Pick a date.")}</div>
          <div x-show="dreamHarvest" class="grid gap-3 p-[18px] md:grid-cols-3">
            <div class="rounded-[12px] p-3.5" style="background: var(--soft)">
              <button type="button" @click="harvestOpen.new = !harvestOpen.new" class="flex w-full items-center gap-2 text-left" :aria-expanded="harvestOpen.new ? 'true' : 'false'">
                <span class="harvest-dot" aria-hidden="true"></span><span class="font-semibold">${t("新记住", "Newly remembered")}</span>
                <span class="text-xs muted" x-text="dreamHarvestCreated().length"></span>
                <span class="chev ml-auto" :class="harvestOpen.new ? 'is-open' : ''">${I.chevron}</span>
              </button>
              <div x-show="harvestOpen.new" class="mt-3 flex flex-col gap-2.5">
                <template x-if="dreamHarvestCreated().length === 0"><p class="text-xs muted">${t("这一天没有新增记忆。", "No memories were added on this date.")}</p></template>
                <template x-for="item in dreamHarvestCreated()" :key="item.id">
                  <div class="flex items-start gap-2"><span class="chip" :class="typeChipClass(item.type)" x-text="typeLabel(item.type)"></span><span class="min-w-0 flex-1 text-[13px] leading-6" x-text="item.content"></span></div>
                </template>
              </div>
            </div>
            <div class="rounded-[12px] p-3.5" style="background: var(--soft)">
              <button type="button" @click="harvestOpen.dim = !harvestOpen.dim" class="flex w-full items-center gap-2 text-left" :aria-expanded="harvestOpen.dim ? 'true' : 'false'">
                <span class="dot" aria-hidden="true"></span><span class="font-semibold">${t("淡出", "Faded")}</span>
                <span class="text-xs muted" x-text="dreamHarvestDormant().length"></span>
                <span class="chev ml-auto" :class="harvestOpen.dim ? 'is-open' : ''">${I.chevron}</span>
              </button>
              <div x-show="harvestOpen.dim" class="mt-3 flex flex-col gap-2.5">
                <template x-if="dreamHarvestDormant().length === 0"><p class="text-xs muted">${t("这一天没有记忆归档或被替换。", "No memories were archived or replaced on this date.")}</p></template>
                <template x-for="item in dreamHarvestDormant()" :key="item.id">
                  <div class="text-[13px] leading-6">
                    <div class="flex flex-wrap items-center gap-2 text-xs"><span class="chip chip-dim" x-text="dreamDormantLabel(item.status)"></span><span class="chip" :class="typeChipClass(item.type)" x-text="typeLabel(item.type)"></span></div>
                    <p class="mt-1 muted" x-text="item.content"></p>
                    <p x-show="item.superseded_by" class="text-[11px] muted"><span x-text="L('接替它的：', 'Replaced by: ')"></span><span class="mono" x-text="item.superseded_by"></span></p>
                  </div>
                </template>
              </div>
            </div>
            <div class="rounded-[12px] p-3.5" style="background: var(--soft)">
              <button type="button" @click="harvestOpen.judged = !harvestOpen.judged" class="flex w-full items-center gap-2 text-left" :aria-expanded="harvestOpen.judged ? 'true' : 'false'">
                <span class="dot" style="background: var(--vline)" aria-hidden="true"></span><span class="font-semibold">${t("审核结果", "Review decisions")}</span>
                <span class="text-xs muted" x-text="dreamHarvestCandidates().length"></span>
                <span class="chev ml-auto" :class="harvestOpen.judged ? 'is-open' : ''">${I.chevron}</span>
              </button>
              <div x-show="harvestOpen.judged" class="mt-3 flex flex-col gap-2.5">
                <template x-if="dreamHarvestCandidates().length === 0"><p class="text-xs muted">${t("这一天没有审核结果。", "No review decisions on this date.")}</p></template>
                <template x-for="item in dreamHarvestCandidates()" :key="item.id">
                  <div class="text-[13px] leading-6">
                    <div class="flex flex-wrap items-center gap-2 text-xs"><span class="chip" :class="item.status === 'approved' ? 'chip-ok' : 'chip-dim'" x-text="dreamCandidateStatusLabel(item.status)"></span><span class="muted" x-text="dreamCandidateSourceLabel(item.source)"></span></div>
                    <p class="mt-1" x-text="item.content"></p>
                    <p x-show="item.decision_note" class="text-[11px] muted" x-text="item.decision_note"></p>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </section>
      </section>
`;
