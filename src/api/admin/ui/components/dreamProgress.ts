import { t } from "../helpers";

export function nightlyProgressCard(status: "home.status" | "dreamStatus"): string {
  const isHome = status === "home.status";
  const diary = isHome ? ", homeHasDiary(home.status.anchor_date_label)" : "";
  return `<template x-if="${status} && ${status}.anchor_date_label && !${isHome ? "home.dreamStatusError" : "dreamStatusError"}">
    <section class="panel panel-pad">
      <template x-for="progress in [nightlyProgress(${status}, ${status}.anchor_date_label${diary})]" :key="progress.date">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div class="min-w-0">
            <h2 class="h2">${t("昨晚整理", "Last night")} <span class="ml-1 text-xs font-normal muted" x-text="dayLabel(progress.date, true)"></span></h2>
            <p class="mt-1 text-sm font-medium" x-text="progress.title"></p>
            <p x-show="progress.review" class="mt-1 text-[13px] muted" x-text="progress.review"></p>
            <p x-show="progress.diary" class="text-[13px] muted" x-text="progress.diary"></p>
          </div>
          <button x-show="progress.needsAttention" type="button" class="btn btn-sm" @click="openDreamProgress(progress, ${status})"
            x-text="${status}.active_run ? L('查看任务状态', 'Check task status') : L('继续整理', 'Continue processing')"></button>
        </div>
      </template>
    </section>
  </template>`;
}
