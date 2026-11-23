import { I, HEART_FILLED, t } from "../helpers";
import { MEETING_CARD } from "../components/meetingCard";

export const ADMIN_TAB_HOME = `      <!-- ===== 首页 ===== -->
      <section x-show="savedApiKey.trim() && page === 'today'" class="page">
        <header class="page-head">
          <div>
            <h1 class="h1">${t("今天", "Today")}</h1>
            <p class="sub" x-text="todayLabel()"></p>
          </div>
          <button type="button" @click="reloadAll()" class="btn btn-icon hidden md:inline-flex" :aria-label="L('刷新', 'Refresh')" :title="L('刷新', 'Refresh')">${I.refresh}</button>
        </header>

        ${MEETING_CARD}

        <p x-show="home.dreamStatusError" class="banner banner-warn" role="status">${t("暂时读不到整理状态，可以刷新再看。", "Dream status is temporarily unavailable. Refresh to check again.")}</p>

        <div class="stats">
          <div class="panel dream-stat stat">
            <span class="stat-label">${t("今天的对话", "Today’s chats")}</span>
            <span class="stat-num" x-text="stats.today_raw_count || 0"></span>
            <span class="stat-sub" x-text="lastMessageTime() ? L('最近一条 ', 'Latest at ') + lastMessageTime() : L('今天还没聊', 'Nothing yet today')"></span>
          </div>
          <div class="panel dream-stat stat">
            <span class="stat-label">${t("待审", "To review")}</span>
            <span class="stat-num" style="color: var(--ct)" x-text="pendingCount"></span>
            <button type="button" @click="go('review')" class="link self-start">${t("去审核 →", "Start review →")}</button>
          </div>
          <div class="panel dream-stat stat">
            <span class="stat-label">${t("昨晚整理", "Last night")}</span>
            <span class="flex items-center gap-2 text-[22px] font-semibold leading-[42px]" :style="'color: ' + homeNightlyColor()">
              <span x-show="homeNightlyProgress()?.done && !homeNightlyProgress()?.needsAttention">${I.checkBig}</span>
              <span class="truncate" x-text="home.dreamStatusError ? L('暂不可读', 'Unavailable') : (homeNightlyProgress()?.title || L('还没跑过', 'Not yet'))"></span>
            </span>
            <span class="stat-sub" x-text="homeNightlySub()"></span>
          </div>
          <div class="panel dream-stat stat">
            <span class="stat-label">${t("记忆库", "Memories")}</span>
            <span class="stat-num"><span x-text="capacityUsed()"></span><span class="text-sm font-medium muted" x-text="' / ' + capacityTotal()"></span></span>
            <span class="bar mt-2" aria-hidden="true"><div :style="'width:' + capacityPercent() + '%'"></div></span>
          </div>
        </div>

        <section x-show="home.status?.rolling && !home.dreamStatusError" class="panel panel-pad flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <h2 class="h2">${t("白天整理", "Daytime Dream")}</h2>
            <p class="mt-1 text-[13px] muted" x-show="homeRollingSummary()" x-text="homeRollingSummary()"></p>
            <p class="mt-1 text-[13px]" role="status" style="color: var(--warn)" x-show="homeRollingWarning()" x-text="homeRollingWarning()"></p>
          </div>
          <button type="button" @click="go('dream')" class="btn btn-sm">${t("查看整理记录", "View Dream activity")}</button>
        </section>

        <section x-show="pendingCount || importPendingCount || homeNightlyProgress()?.needsAttention" class="flex flex-col gap-3">
          <h2 class="h2">${t("需要你处理", "Needs you")}</h2>
          <div class="panel divide">
            <div x-show="pendingCount" class="row">
              <span class="avatar">${I.inbox}</span>
              <div class="min-w-0 flex-1">
                <div class="font-semibold" x-text="L(pendingCount + ' 条新记忆等你确认', pendingCount + ' new memories to confirm')"></div>
                <div class="text-[13px] muted">${t("整理时拿不准的，确认后才会长期记住。", "Found during Dream. They’re kept long-term only after you confirm.")}</div>
              </div>
              <button type="button" @click="reviewTab = 'daily'; go('review')" class="btn btn-primary btn-sm">${t("开始审核", "Start review")}</button>
            </div>
            <div x-show="importPendingCount" class="row">
              <span class="avatar">${I.upload}</span>
              <div class="min-w-0 flex-1">
                <div class="font-semibold" x-text="L('导入的 ' + importPendingCount + ' 条还没看', importPendingCount + ' imported memories not checked yet')"></div>
                <div class="text-[13px] muted">${t("从别处导进来的，要你自己点。", "Brought in from elsewhere. These wait for you.")}</div>
              </div>
              <button type="button" @click="go('review'); openImportReview()" class="btn btn-sm">${t("查看", "View")}</button>
            </div>
            <div x-show="homeNightlyProgress()?.needsAttention" class="row">
              <span class="avatar" style="background: var(--warnbg); color: var(--warn)">${I.alert}</span>
              <div class="min-w-0 flex-1">
                <div class="font-semibold" x-text="homeNightlyProgress() ? (L('昨晚整理 · ', 'Last night · ') + homeNightlyProgress().title) : ''"></div>
                <div class="text-[13px] muted" x-text="homeNightlySub()"></div>
              </div>
              <button type="button" @click="openDreamProgress(homeNightlyProgress(), home.status)" class="btn btn-sm" x-text="home.status?.active_run ? L('查看任务状态', 'Check task status') : L('继续整理', 'Continue processing')"></button>
            </div>
          </div>
        </section>

        <div class="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start">
          <section class="panel">
            <div class="panel-head pb-3">
              <div class="flex items-baseline gap-2">
                <h2 class="h2">${t("今天的对话", "Today’s chats")}</h2>
                <span class="text-[13px] muted" x-text="L(todayMessages.length + ' 条', todayMessages.length + ' messages')"></span>
              </div>
              <div class="seg" role="group" :aria-label="L('按说话人筛选', 'Filter by speaker')">
                <button type="button" @click="homeRole = 'all'" :class="homeRole === 'all' ? 'is-active' : ''" x-text="L('全部', 'All')"></button>
                <button type="button" @click="homeRole = 'user'" :class="homeRole === 'user' ? 'is-active' : ''" x-text="L('你', 'You')"></button>
                <button type="button" @click="homeRole = 'assistant'" :class="homeRole === 'assistant' ? 'is-active' : ''" x-text="L('助手', 'Assistant')"></button>
              </div>
            </div>
            <div class="divide border-t" style="border-color: var(--div)">
              <template x-if="homeMessages().length === 0">
                <div class="empty">${t("今天还没有聊天记录。", "No chats yet today.")}</div>
              </template>
              <template x-for="message in homeMessages()" :key="message.id">
                <article class="flex items-start gap-3 px-[18px] py-3.5" x-data="{ more: false, deleteOpen: false }" :title="message.source || ''">
                  <span class="avatar" :class="message.role === 'user' ? 'avatar-user' : ''" aria-hidden="true" x-text="roleName(message.role).slice(0, 1)"></span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-baseline gap-2 text-xs muted"><span class="font-semibold" style="color: var(--t2)" x-text="roleName(message.role)"></span><span x-text="clock(message.created_at)"></span></div>
                    <p class="mt-1 whitespace-pre-wrap wrap-anywhere text-sm leading-7" :class="more ? '' : 'line-clamp-6'" x-text="message.content"></p>
                    <button type="button" x-show="(message.content || '').length > 320" @click="more = !more" class="link-btn mt-1" x-text="more ? L('收起', 'Show less') : L('展开', 'Show more')"></button>
                  </div>
                  <div class="msg-actions">
                    <div class="relative flex">
                      <button type="button" @click="deleteOpen = !deleteOpen" class="icon-btn" aria-haspopup="menu" :aria-expanded="deleteOpen ? 'true' : 'false'" :aria-label="L('删除', 'Delete')" :title="L('删除', 'Delete')">${I.trash}</button>
                      <div x-show="deleteOpen" @click.outside="deleteOpen = false" @keydown.escape.window="deleteOpen = false" class="menu delete-menu" role="menu">
                        <button type="button" role="menuitem" @click="deleteOpen = false; deleteRaw(message)">
                          <span class="block" x-text="L('只删这句', 'Delete this line')"></span>
                          <span class="block text-xs muted" x-text="L('由它整理出的记忆保留', 'Memories made from it stay')"></span>
                        </button>
                        <button type="button" role="menuitem" @click="deleteOpen = false; deleteRaw(message, 'withdraw')">
                          <span class="block" x-text="L('连同整理出的记忆一起撤回', 'Delete with its memories')"></span>
                          <span class="block text-xs muted" x-text="L('引用它的记忆和待审一起隐藏', 'Also hides memories citing it')"></span>
                        </button>
                      </div>
                    </div>
                    <button type="button" @click="togglePin(message)" class="heart" :class="isPinned(message) ? 'is-on' : ''" :aria-pressed="isPinned(message) ? 'true' : 'false'" :aria-label="isPinned(message) ? L('取消珍贵', 'Remove from keepsakes') : L('收藏为珍贵', 'Save as a keepsake')" :title="isPinned(message) ? L('取消珍贵', 'Remove from keepsakes') : L('收藏为珍贵', 'Save as a keepsake')">
                      <span x-show="isPinned(message)">${HEART_FILLED}</span><span x-show="!isPinned(message)">${I.heart}</span>
                    </button>
                  </div>
                </article>
              </template>
            </div>
            <div x-show="homeFilteredCount() > 8" class="px-[18px] py-3" style="border-top: 1px solid var(--div)">
              <button type="button" @click="homeAll = !homeAll" class="link" x-text="homeAll ? L('收起', 'Show fewer') : L('查看全部 ' + homeFilteredCount() + ' 条 →', 'See all ' + homeFilteredCount() + ' →')"></button>
            </div>
          </section>

          <div class="flex min-w-0 flex-col gap-5">
            <section class="panel" x-show="home.harvest">
              <div class="panel-head">
                <h2 class="h2">${t("昨天新增的记忆", "Memories added yesterday")}</h2>
                <span class="text-[13px] muted" x-text="homeHarvestCreated().length ? L(homeHarvestCreated().length + ' 条', String(homeHarvestCreated().length)) : ''"></span>
              </div>
              <div class="flex flex-col gap-3 px-[18px] py-4">
                <template x-if="homeHarvestCreated().length === 0">
                  <p class="text-[13px] muted">${t("昨天没有新增记忆。", "No memories were added yesterday.")}</p>
                </template>
                <template x-for="item in homeHarvestCreated().slice(0, 5)" :key="item.id">
                  <div class="flex items-start gap-2.5">
                    <span class="chip" :class="typeChipClass(item.type)" x-text="typeLabel(item.type)"></span>
                    <span class="min-w-0 flex-1 wrap-anywhere text-sm leading-6" x-text="item.content"></span>
                  </div>
                </template>
              </div>
              <div class="px-[18px] pb-4"><button type="button" @click="go('memory')" class="link">${t("在记忆库查看 →", "Open in Memories →")}</button></div>
            </section>

            <section class="panel">
              <div class="panel-head">
                <h2 class="h2">${t("最近的日记", "Latest journal")}</h2>
                <span class="text-[13px] muted" x-text="home.diary ? dayLabel(home.diary.date) : ''"></span>
              </div>
              <div class="px-[18px] py-4">
                <template x-if="!home.diary"><p class="text-[13px] muted" x-text="home.diaryLoaded ? L('还没有日记。', 'No journal entries yet.') : L('日记状态待确认。', 'Journal status unconfirmed.')"></p></template>
                <template x-if="home.diary">
                  <div>
                    <div class="mb-1 font-semibold wrap-anywhere" x-text="home.diary.title"></div>
                    <p class="line-clamp-5 wrap-anywhere text-sm leading-7" style="color: var(--t2)" x-text="home.diary.summary"></p>
                  </div>
                </template>
              </div>
              <div x-show="home.diary" class="px-[18px] pb-4"><button type="button" @click="diaryMode = 'daily'; go('diary'); if (home.diary) openDiary('daily:' + home.diary.date)" class="link">${t("读完整篇 →", "Read the full entry →")}</button></div>
            </section>
          </div>
        </div>
      </section>
`;
