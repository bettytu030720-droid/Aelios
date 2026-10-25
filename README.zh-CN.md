简体中文 | [English](README.md)

# Aelios

给 AI 加一颗长期记忆。换窗口、换客户端、换模型，记忆跟着你走。

它是一个跑在 Cloudflare 上的记忆网关：你的 Chatbox / Claude Code / Codex 先连它，它再把请求转给模型。对话会被记下来，下次自动想起来。

## 让 AI 帮你配

用 Claude Code、Codex 这类能跑命令的 AI，把这段话发给它：

```text
帮我装好、配好 Aelios（我的 AI 记忆网关）。先读 https://raw.githubusercontent.com/wusaki0723/Aelios/main/docs/setup-with-ai.md ，照着做。需要我在浏览器里点、或者需要我自己填 key 的时候，停下来告诉我去哪儿填。
```

从零开始也行：它会帮你 fork、部署、生成 Cloudflare 令牌、配好助手、导入以前的记忆，最后交给你一个地址、一把 API Key 和要选的模型名，填进聊天软件就能用。你要准备一个 Cloudflare 账号（免费）和一个模型的 key；自己动手的只有在浏览器里点「允许」（新装两次），和把模型的 key 存进 Cloudflare 后台（它会告诉你去哪儿填）。

推荐 **API 模式加 MCP 连接器**：聊天经过 Aelios，每句话自动记、自动想起来；再接上 MCP，助手还能主动查、主动记。只有 Claude 订阅、没有 API 的，才只用 MCP。

想自己动手，看下面的三步。

## 怎么用

就三步。

### 1. 部署

先 Fork 本仓库，再部署你的 Fork。这样以后每次更新都只要点一下（见[更新到最新版](#更新到最新版)）。

1. 点本页右上角的 **Fork**。
2. 在 Cloudflare 后台进 **Workers & Pages → Create → Import a repository**，连上 GitHub，选你的 Fork。项目名保持 `companion-memory-proxy`，构建命令 `npm ci`，部署命令 `npm run deploy`。部署命令会自己建好 D1 数据库、Vectorize 索引和队列。
3. 部署好以后，进 Worker 的 **Settings → Variables and Secrets**，加 Secret `CHATBOX_API_KEY`：自己编一个密码，比如 `sk-my-aelios`。只有这一个必填，其余可选的钥匙见 [SECRETS.md](SECRETS.md)。

部署完会得到一个地址，类似：

```
https://companion-memory-proxy.<你的子域>.workers.dev
```

不要用裸 `wrangler deploy`，那样不会建库。

**不推荐：一键部署按钮。** [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wusaki0723/Aelios)

按钮能用，但 Cloudflare 是把本仓库复制一份到你账号里的新仓库，不是 Fork。复制品在 GitHub 上没有 Sync fork，以后每次更新都得手动把新代码拉过去。实在要用的话：表单里只必填 `CHATBOX_API_KEY`；Vectorize 那栏照抄 Dimensions `1024`、Metric `cosine`；构建命令 `npm ci`，部署命令 `npm run deploy`。已经用按钮装好了？看[用按钮装的怎么办](#用按钮装的怎么办)。

### 2. 加一个助手

浏览器打开：

```
https://<你的 Worker 地址>/admin
```

填 Worker 地址和刚才那把钥匙，进「设置」。

1. **上游地址**：填你的 Cloudflare 账号 ID（32 位）。要用完整聊天转发的话，再在 Worker Secrets 里加 `CLOUDFLARE_API_TOKEN`。
2. **助手**：点「添加助手」，例如：

   | 栏 | 填什么 | 例子 |
   |---|---|---|
   | 名字 | 地址里那一段，小写英文 | `coder` |
   | 主模型 | 只有这些模型会记、会召回 | `anthropic/claude-opus-4-5` |
   | 钥匙 | 谁能用这个助手 | 勾选主钥匙 |

3. 点「保存」。

一个助手一个地址。名字写成 `coder`，地址就是：

```
https://<你的 Worker 地址>/coder/v1
```

主模型才有记忆。没登记的模型（比如 Claude Code 里的小模型）只是路过，不记也不召。

### 3. 客户端指过来

API Key 一律填 `CHATBOX_API_KEY`。模型名写成 `厂商/模型`，比如 `anthropic/claude-opus-4-5`。

| 你用什么 | 填这个地址 |
|---|---|
| Chatbox、Cherry Studio 等 | `https://<Worker 地址>/coder/v1` |
| Claude Code | `ANTHROPIC_BASE_URL=https://<Worker 地址>/coder` |
| Codex | `base_url = https://<Worker 地址>/coder/v1`，并设 `wire_api = "responses"` |

不带助手名的 `/v1` 会走这把钥匙的第一个助手。

试一句：「请记住：我的测试暗号是苹果星星-0428。」过一会儿再问：「我的测试暗号是什么？」答出来就通了。

## 更新到最新版

GitHub 不会自己更新 Fork。有新版本时：

1. 在 GitHub 打开你的 Fork，点 **Sync fork → Update branch**。
2. Cloudflare 看到新提交会自己构建、部署，进度在 Worker 的 **Deployments** 里看得到。

记忆、设置、助手和钥匙都存在你的 Cloudflare 账号里，不在仓库里，同步不会丢。改设置请在 `/admin` 里改，别去改 Fork 里的文件，这样 Sync fork 一直是点一下就好，不会冲突。

想让它自动同步？[Pull](https://github.com/apps/pull) 这个 App 能定时帮 Fork 同步。但那样每个新版本都会不经你看就直接上线，包括数据库迁移；而且 Pull 默认把你的 Fork 硬重置成本仓库，你自己的提交会被丢掉。推荐手动点同步。

### 用按钮装的怎么办

按钮装出来的是复制品，不是 Fork，没有 Sync fork。把 Worker 换到 Fork 上就好，记忆和设置都在 Cloudflare 里，不会动。

1. Fork 本仓库。
2. 如果你当时在按钮的设置页改过 D1 数据库或 Vectorize 索引的名字：进 Worker 的 **Settings → Build → Build Variables and Secrets**，加 `CMP_D1_NAME` 和 `CMP_VECTORIZE_NAME`，填你改过的名字。不加的话，构建会新建两个空的，记忆看起来像没了（其实还在旧库里）。
3. 在 **Settings → Build** 点 **Disconnect**，再点 **Connect** 选你的 Fork，构建命令 `npm ci`，部署命令 `npm run deploy`。
4. 如果 Cloudflare 往你的 Fork 提了一个修 Worker 名字的 PR，合掉它。

之后 Cloudflare 会在你的 Fork 有变化时从它构建，所以下次点 Sync fork 就更新上来了。在那之前 Worker 继续跑现在的版本。

## 平时怎么管

打开 `/admin`，底部几个标签：

| 标签 | 干什么 |
|---|---|
| **今日** | 今天聊了什么 |
| **审核队列** | 夜间整理出来的候选记忆。默认每晚由 Cloudflare 的 clef 审完，这周定下的都列在这里，不对就撤回。设置里关掉 clef 后候选留在这里等你批，也可以让助手用 MCP 自己审。从别处导进来的单独放在「导入的」一栏，只等你自己点 |
| **重要记忆** | 浏览、搜索、改、删；被原地改写过的记忆点「旧版」能看到改之前的样子，也能恢复 |
| **更多** | 珍贵原文、术语表、小本本、导入导出、维护工具 |
| **设置** | 上游、助手、环境参数 |

想让 AI 记住、忘掉、改掉什么，在面板点就行。

### 搬记忆：导出、导入

在「更多 → 导入导出」，每样都按当前选的空间来：

- **导出**：md 或 jsonl。md 一行一条（日期、正文、#标签、反引号里的 key），能直接打开改，改完原样导回来：key 一样的会改写原来那条，旧版留着。
- **导入整理好的条目**：一行一条，`- 2025-12-15 [偏好] 内容 #标签`，日期、类型、标签都可以省；普通的 md 列表、一段段文字也认。页面上有一段提示词，贴给原来用的 AI，它就按这个格式把记得的事列出来。可以直接写进库（一字不差的跳过，跟库里很像的转去审核），也可以全部先进审核。
- **导入聊天记录**：认 ChatGPT、Claude 导出的 `conversations.json`、酒馆的 `.jsonl`、「名字：内容」一行一句的文本。文件在页面里拆开、按天切段，一段段交给夜里整理记忆用的那个模型（`DREAM_MODEL`）读，抽出来的只进审核页「导入的」，点了才算数；页面上看得到进度和花了多少 token。原话只存被候选引用的那几句，不进聊天记录表，不受 7 天清理影响，也不会被夜里再整理一遍。页面关了下次选同一个文件接着做。

## 它实际在做什么

```
你的客户端  →  Aelios（认助手、记、召回）  →  模型
```

- 你每说一句，相关旧记忆会贴到这次对话里。
- 对话原文先存下来；夜里自动整理成长期记忆（Dream），每个助手用自己在聊的那个模型决定记不记，它定下的你随时能撤回。
- 记忆存在你自己的 Cloudflare（D1 + Vectorize），不绑某个聊天窗口。

一个助手可以写一个空间、读好几个空间。比如新对话写 `coder`，同时还能读旧库 `coder-old` 和共享的 `shared-docs`。不填召回空间就只读自己那个。

### Dream 的执行与失败状态

管理页 Dream 控制台里的非预演手动 Dream 交给已有的持久化 `MEMORY_QUEUE`，确认入队后立即给出任务 ID；此后关页不会取消排队任务。页面每五秒查询状态，刷新后也能重新找到任务。队列每批只取一条消息，避免多个耗时 Dream 共用一次执行的时间预算。

API 客户端在 `POST /v1/dream/run` 中显式传 `{"background":true}`，其余 namespace、date、force 参数照旧。确认入队返回 HTTP **202**，带 `data.run_id` 和 `data.status="queued"`，通过 `GET /v1/dream/status` 查询；缺队列或入队失败返回 **503**。和旧接口一样，每个手动任务只处理一批，不一定处理完整一天，是否还有后续批次要看游标。不传 background 的旧调用仍同步返回，dry-run 也保持同步。

- 同一空间有 queued/running 任务时，不能再次后台入队，force 也不绕过。它不是覆盖 cron 和旧同步调用的全局租约。
- 摘要、抽取每次调用含读响应体限时 120 秒；两段抽取阶段总预算八分钟，最多缩批三次。JSON 或结构不合格时，摘要与抽取一起改读同一小批，后半批留待之后处理；明确的空候选和坏输出分开。一份整体合格的输出里个别不可用的条目（空白、超长、类型不对）会被丢弃并在日志里计数，不再让整批失败；列表类型不对、缺少候选列表，或非空列表里一条都不可用，仍算坏输出。抽取调用与摘要共用同一份输出预算（`DREAM_MAX_TOKENS`，最高 8000）。模型或格式失败不推进游标、不主动删除这批原文，独立的保留期策略仍照常生效。
- 超过 20 分钟还未确认完成的记录显示为**可能中断、状态未确认**，不再一直装作正常运行。这只是只读提示，不等于已经证明执行停止。旧的未收尾记录要先核对日志，再由操作者明确收尾，不会为了放行新任务而偷偷清掉。核对日志后，可在面板点**核查后标记为已中断**（或调用 `POST /v1/dream/resolve`，body 为 `{"run_id":"…"}`，权限同样是 `memory:write`），把超过 20 分钟的 queued/running 记录收尾；更新的或已结束的记录会被拒绝。收尾后该记录显示为出错，不再阻止新任务；它已经写入的内容不会回滚。
- 每批 Dream 会在当天的日记条目上留一份整理草稿，当天最后一批做完后，真正的日记再把它替换掉。夜间 cron 只写昨天的日记，所以手动任务、手动补跑接口和 cron 补跑现在会在某一天的最后一批完成后自己写日记（最后一批没完成前什么都不做，日记写失败也不会撤销 Dream）。日记页的**用原文重写这篇**（`POST /admin/diary-rewrite`，body 为 `{"date":"YYYY-MM-DD"}`）可以重写任何聊天原文还在保留期内的一天，会替换它现在的文字；那一周已经汇总成周记后会被拒绝。
- 条件领取防止同一任务重复投递时再次执行整理；这**不等于 exactly-once 完成，也不是自动崩溃恢复**。领取后出现未知结果、可能已部分落库时，不自动重放，先核查再重试。手动整理后的候选审核保留；审核失败不撤销已经完成的 Dream。

## 可选功能

**完整聊天网关**（想让 Aelios 转发各家模型，用你自己的 key 计费）

1. Cloudflare → AI → AI Gateway，建一个 gateway，把各家 key 存在它下面。
2. Worker Secrets 加 `CLOUDFLARE_API_TOKEN`。
3. `/admin` 设置里，上游填 32 位账号 ID，再加助手。

不配这些，记忆召回和夜间整理也能跑（走 Workers AI）。这三步可以交给 AI 做，见[让 AI 帮你配](#让-ai-帮你配)。

**用你的 ChatGPT 套餐**（有 ChatGPT Plus / Pro，想让助手直接用套餐额度，不用 API key；走的是 OpenAI 的 Sign in with ChatGPT）

1. `/admin` → 设置 → **ChatGPT 套餐** → *Continue with ChatGPT*，登录并同意。
2. 同意之后浏览器会跳到一个打不开的 `127.0.0.1` 页面，**这是正常的**：把地址栏里那一整条地址复制下来，贴进 `/admin` 里的框，点「完成登录」。
3. 模型名写 `chatgpt/<模型名>`；点「测试」能看到你这个账号能用哪些。想让它带记忆，把 `chatgpt/*` 加进助手的主模型。

要知道的：它只连你自己的账号，别把这条线路分给别人。用量计入你套餐的限额（ChatGPT 设置 → Usage 里管）。chat/completions、Anthropic messages、responses 三种格式的客户端都能用（前两种会翻成 Responses 再翻回来，Claude 那种带思考块的也行）；OpenAI 的套餐线路不收图片生成、文件搜索、代码解释器、MCP 这类托管工具，函数工具和联网搜索可以。不用加新的 Secret：token 加密存在 D1 里，密钥由 `CHATBOX_API_KEY` 派生，换了这把 key 就要重新登录。`npm run deploy` 会把新迁移一并应用。夜间任务也能用套餐：在设置里把 Dream 用的模型（日记模型也行）填成 `chatgpt/<模型名>`。它们一晚上会发好几次请求，都算在套餐额度里；哪晚额度用完，这些任务就像别的模型报错一样失败，记忆库本身不受影响。

**在 Claude 官方 App（网页、手机）、Claude Code、Codex 里用 MCP 记忆**

```
https://<Worker 地址>/mcp?token=<CHATBOX_API_KEY>
```

- Claude 官方 App：在连接器页面（claude.ai/customize/connectors）添加自定义连接器，填上面的地址。网页上加好，手机 App 里也有。工具权限里把只读那一组设成「总是允许」，不然每次想起来都要点一下。
- 官方 App 不读 MCP 服务器自带的使用说明。想让它记得用，在个人偏好或项目说明里贴这段：

```
我给你接了 Aelios 记忆连接器，那是你对我的长期记忆。每个新对话先调 wake_up 再回我；我提到以前的人和事，或者你要猜我的事之前，先 recall；我说了新的事、改了主意、许了约定，当场 remember；聊得差不多了调 log_conversation。
```

- 官方 App 的对话不经过 Aelios，夜里的日记和候选靠助手调 `log_conversation` 交过来；走网关的客户端不用调。
- 默认只列 10 个常用工具；要 `memory_get`、`memory_export` 这类维护工具，地址后面加 `&tools=all`。

只有 Claude 订阅、走不了 API 时，想让 Claude Code 每条消息自动召回、批量写回，用仓库里的 Hook：[`integrations/claude-code/`](./integrations/claude-code/README.md)。

**看图**

加 Secret `GUIDE_DOG_API_KEY`，客户端改成：

- 地址：`https://<Worker 地址>/v1/guide-dog`
- 模型：`companion`

导盲犬只转述图片，不写记忆。

**住在 Cloudflare 里的伴侣：[Aelios-resident](https://github.com/wusaki0723/Aelios-resident)**

另一个 Worker（一个 Durable Object，基于 Cloudflare 的 Think），在 Telegram 和它自己的网页上跟你聊，两边是同一段对话。接上 Aelios 后，它的聊天跟别的客户端一样从你助手的 `/v1` 过，想起旧事、记下来都由 Aelios 做；它还会用记忆工具，搜网搜到的长期知识存进世界知识。另外：你停下来一阵，它给之后的自己写交接信；到点主动找你；搜网、读网页；接别的 MCP；模型、人设和设置都在它的网页上改。Workers 免费档就能跑。接法是在它的设置页填这个 Aelios 的地址、key 和用哪个助手聊（选的模型要在那个助手的主模型里），部署看它的 README。

## 最容易踩的坑

- 部署用 `npm run deploy`，不要裸 `wrangler deploy`。
- 助手名字是地址的一部分，用 `coder` 这种英文，别用空格。
- 模型名要带厂商前缀：`anthropic/claude-opus-4-5`，不要只写 `claude-opus-4-5`。
- 只有助手里登记的主模型才有记忆。小模型、杂务模型别写进去。
- Vectorize 索引别手动删（`memo-kb`，1024 维 cosine）。

## 想看细节

- 网关怎么路由、怎么记、怎么召回：[docs/memory-gateway.md](docs/memory-gateway.md)
- 请求会改什么、thinking 怎么处理：[docs/request-contract.md](docs/request-contract.md)
- 哪些密钥必填：[SECRETS.md](./SECRETS.md)
- 维护、端点、MCP 工具：下面这一段

---

# 给维护的人

Cloudflare Workers 上的记忆网关。帮用户部署时只关联**用户自己的 fork**，Secrets 都在用户自己的账号。

| 资源 | 值 |
|---|---|
| Worker | `companion-memory-proxy` |
| D1 | `companion_memory_proxy` |
| Vectorize | `memo-kb`（1024 维 cosine） |
| Queue | `companion-memory` |
| Embedding | `workers-ai/@cf/baai/bge-m3` |

入口：`/<助手>/v1/chat/completions`、`/<助手>/v1/messages`、`/<助手>/v1/responses`。不带助手名的 `/v1/...` 走该钥匙的第一个助手。

CF 上游：chat 走 compat（全厂商，BYOK）；messages / responses 走各厂商原生端点。模型名原样透传，厂商认不出来由上游报错。自定义 OpenAI 兼容地址原样转发。

配置三层，都在 `/admin` 的「设置」：上游、助手、环境参数。优先级：面板保存的 > `GATEWAY_CONFIG` > 空配置。

### 常用端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| GET | `/admin` | 管理面板 |
| GET | `/v1/models` | 模型列表 |
| POST | `/<助手>/v1/chat/completions` | OpenAI 兼容聊天 |
| POST | `/<助手>/v1/messages` | Anthropic messages |
| POST | `/<助手>/v1/responses` | OpenAI responses |
| GET / POST | `/api/gateway/chatgpt/*` | ChatGPT 套餐登录（主人钥匙）：`status`、`login`、`callback`、`test`、`welcome`、`logout` |
| GET / POST | `/mcp` | MCP 记忆工具 |
| GET / POST | `/v1/memories` | 记忆列表 / 新建 |
| POST | `/v1/memory/recall` | 动态召回（hook 优先用这个） |
| POST | `/v1/search/memories` | 原始搜索（不记账） |
| POST | `/v1/ingest/messages` | 写入原始聊天 |
| GET | `/v1/memory_boot` | 冷启动包 |
| GET | `/v1/diary` `/v1/diary/recent` | 日记 |
| GET / POST / DELETE | `/v1/precious` `/v1/glossary` | 珍贵原文 / 术语表 |
| GET / POST / PATCH / DELETE | `/v1/notebook` | 小本本；`/:id` 打开、改、删一页，`DELETE ?confirm=all` 清空当前空间的小本本 |
| GET / POST | `/v1/candidates` | 审核队列；`?scope=daily` 只要日常整理的，`/decisions?days=7` 自动决定清单，`/:id/undo` 撤回，`/:id/sources` 挂的原话 |
| GET | `/v1/memories/export?format=md\|jsonl` | 导出当前空间的记忆和珍贵（`memory:read` 就够） |
| GET | `/v1/memories/:id/revisions` | 这条记忆原地改写前的旧版 |
| GET / POST | `/v1/import/*` | 导入：`info`、`entries/preview`、`entries`、`batches`、`chat/chunk`、`candidates` |

非 `/health` `/admin` 都要 `Authorization: Bearer <key>`。网关按助手钥匙鉴权，记忆接口按 `memory:read` / `memory:write`。

### MCP 工具

`wake_up` `recall` `remember` `keep_moment` `forget` `learn_word` `read_diary` `log_conversation` `list_memories` `notebook`

`notebook` 是小本本：助手按页名自己读、自己改的笔记，比如备考进度。不会被自动召回，夜里不会被改写，也不会过期；在「更多 → 小本本」能看、能改、能删、能整本清空。

clef 自动审关着时多列 `memory_candidates` `memory_review`；地址加 `&tools=all` 再多列 `memory_get` `memory_export`。旧名字（`memory_boot`、`memory_recall`、`memory_search`、`memory_upsert`、`memory_supersede`、`memory_archive`、`memory_delete`、`memory_ingest`、`memory_pin`、`glossary_set`、`diary_get`、`memory_list`）不再列出，按旧名调用照样能用。

### 记忆怎么走

写入：助手直写 `remember`；夜里 cron（`10 20 * * *`）从当天对话抽事实 → 候选由 Cloudflare 的 clef 判记住或放下（`CLEF_AUTO_REVIEW`，默认开；关掉后候选留给人工，或让助手用 MCP 的 `memory_candidates`、`memory_review` 自己审），并写日记 / 周记 / 月记。

召回：最后一句用户话 → 向量搜索 + 词面 → 原文片段批量重排 + 规则 → 把干净原文贴到当前消息末尾。默认不调用生成式 LLM，日常最多一条，回答旧事最多两条；低分不凑数，重排失败回落词面。分数与取舍可在 `/admin → 设置` 查看。传输信封、哈希和消息 ID 不进入日常提示，同一会话里直接相邻且 90 秒内的两句会合并；主动搜索仍返回完整记录和 ID。日记不自动注入。

清理：消息约 7 天；一条记忆 180 天里没被改写、没被想起、也没再被提到，才标过期（置顶和 identity、persona 不会过期），失效记录再过 30 天硬删。

### 本地验证

```bash
npm install
npm run verify
```

测试需要 Node.js 22+。

CI 里 lint 是阻断的：`npm run lint` 必须零 error 才能合并。仍有 17 个 `noNonNullAssertion` warning，这条规则在 `biome.json` 里被降为 warning，不影响退出码 —— 清不清由改到那行的人自己判断，别用 Biome 的自动修复批量改，它会把 `x!.y` 换成 `x?.y`，把「出错就炸」变成「悄悄返回 undefined」。

## License

AGPL-3.0

可自由使用、修改；若把修改后的版本对外提供网络服务，须以相同许可开源修改后的源码。

v1 最终封存点在 tag `v1-final`（当时仍是 MIT）。

## 交流

QQ 群：**1091783659**
