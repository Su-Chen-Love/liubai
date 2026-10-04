# 留白

把事情放在这里，把空间留给自己。

四象限安排重要与紧急，支持网格或列表；时间范围合并在筛选中（今天、明天、近 3 天、本周、以后、待重新安排、未排期）。顶部提供今天、三天内、本周的快捷筛选，再点已选项恢复全部时间。侧栏可收起，桌面四象限铺满可用空间，紧凑卡片保留标题、日期与子步骤数量；手机自然纵向浏览。「收件箱」接收整段输入，Codex 提出整理结果；明确新增和安全追加可自动保存，其余变化由本人确认。

本文说明 **v0.3 的源码能力与使用方式**。代码合并、网站部署、机器凭据配置和真实账号验收是不同步骤；本文不表示线上已更新或定时任务已经验收。

## 云端日常使用

首版继续使用 Sites 与 ChatGPT 登录，只向受邀用户开放。每个人使用自己的 ChatGPT 账号；任务、收件箱、偏好和变更历史按账号分别保存。当前没有留白自有用户名密码，也没有搭档共享空间。分享链接不等于获得访问权限，公开 GitHub 源码不会公开数据库。

云端 D1 是云端日常使用的主数据库。手机和电脑登录同一账号后访问同一份云端数据。本地 Codex 通过 HTTPS 领取已授权账号的整理工作，并将结果写回这份云库；不把本地数据库与云端整库双向同步。网站保存成功与 Agent 整理完成是两件事。

在「空间与数据」中，每个云端账号都需要本人明确同意，才能启用该账号的本机整理与备份。启用意味着站点管理者的 Mac/Codex 可以处理本账号的任务、输入和偏好，并在本机保留备份。可随时撤销后续访问；既有备份不会立即删除，将在在线维护时按 30 天保留期清理。普通用户不能读取其他账号的数据，站点管理者仍有运维层面的数据库权限。

ChatGPT 登录只确认身份，不附带 ChatGPT 历史、日历、邮件或连接器权限。当前网站不内置模型；整理执行者仍是本机 Codex。

## 日期、紧急程度与手机入口

- 「计划日期」用于安排时间；「截止日期」表示真正的完成期限，二者分开保存。
- 编辑面板保留计划日期、分类、象限和子步骤，截止日期与紧急模式不再单独提供手动设置；现有截止数据仍保留。采用自动模式的未完成任务，默认在截止前 **3 个自然日**进入紧急象限，包含截止当天；逾期仍为紧急，重要性不变。阈值与时区可在设置中修改，默认时区为 Asia/Shanghai。
- 手动象限安排优先于自动计算。旧任务保留原有象限和手动安排，不把旧计划日期擅自改成截止日期。
- 手机打开线上站点并登录同一受邀 ChatGPT 账号。iPhone Safari 用分享菜单「添加到主屏幕」；Android Chrome 用菜单「添加到主屏幕 / 安装应用」。这是在线 PWA 入口，需要联网保存；没有离线操作队列，安装图标也不会让手机承担每小时整理。
- 连接失败时保留当前账号的标签页草稿，不把未确认的请求称为已保存。关闭标签页或清理浏览器数据仍可能丢失未保存草稿。

## 本地开发与独立本地空间

需要 Node.js 22.13 或更新版本。项目主目录为维护者当前使用的 canonical 检出；克隆者在自己的项目目录运行：

```sh
git clone https://github.com/Su-Chen-Love/liubai.git
cd liubai
npm ci
npm run local
```

也可双击「启动留白.command」。浏览器地址固定为 **http://127.0.0.1:4178**，保持终端运行，按 Ctrl+C 停止。启动只应用尚未执行的迁移，不重置任务；本地身份仅用于回环开发服务器，不进入生产构建。

**本地空间仍是独立数据库。** 其中的数据位于 `.wrangler/state/`，不是缓存，不要删除。迁移项目时应先停服务，保留整个目录。不要将 `npm run local` 暴露到局域网或公网。

本地任务 CLI 保持可用，先读取真实 ID 再修改：

```sh
npm run tasks -- list
npm run tasks -- agenda
node scripts/tasks.mjs create < task.json
node scripts/tasks.mjs update TASK_ID < changes.json
node scripts/tasks.mjs complete TASK_ID
node scripts/tasks.mjs export tasks.json
```

另有 `reopen ID`、`delete ID`。CLI 在写入前握手当前本地账号，使用任务 revision 检查冲突。`tasks export` 只导出未删除任务（包含已完成），不是完整备份。本地收件箱仍可使用 `node scripts/organizer.mjs queue/plan/resume/checkin`；不能用这些本地命令替代远程流程。

## 云端整理与本机配置

远程 CLI 使用 `node scripts/organizer.mjs remote …`，完整协议见 [ORGANIZER.md](ORGANIZER.md)。机器访问需要平台服务凭据、应用机器凭据，以及每个账号的有效授权；平台服务凭据本身不是用户身份。

远程网络优先沿用 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 环境变量，小写同名变量优先。未显式设置 HTTP(S) 代理时，macOS 上会读取已启用的系统 HTTPS 代理，仅采用回环地址与合法端口，不自动采用 SOCKS 或 PAC。设置 `NODE_USE_ENV_PROXY=0` 可关闭这项自动配置；`NO_PROXY=*` 表示全部直连。代理仅应用于本次远程 CLI 进程，不修改系统设置；本地 4178、help、init、prune 不触发代理探测。需要代理时要求 Node 24.14+、25.4+ 或更新主版本，无代理仍兼容 Node 22.13。实现使用 [Node 官方动态代理 API](https://nodejs.org/api/http.html#httpsetglobalproxyfromenvproxyenv)，保留 TLS 验证及禁止携带凭据跟随重定向的限制。

若网络返回 HTML 或无法确认连接，CLI 会报错，最多附带 HTTP 状态和格式合格的 Cloudflare 诊断标识；不会输出页面正文或代理凭据。此时保留云端待办与已有计划，下次重试，不把故障记为「无新增」或「备份成功」。

维护者通过不回显的标准输入向 `remote init` 提供单个 JSON 对象，字段为 `url`、`sitesToken`、`agentToken`、`backupKey`。其中 `url` 必须是实际站点的 HTTPS origin；`backupKey` 是 32 字节随机密钥的 Base64，省略时初始化生成。配置写入权限为 600 的 `.liubai/remote.json`，不会覆盖已有配置。不要把密钥放进命令参数、聊天、日志或仓库；备份密钥需要另行安全保管，丢失后无法解密备份。

```sh
node scripts/organizer.mjs remote help
node scripts/organizer.mjs remote prune
node scripts/organizer.mjs remote queue
node scripts/organizer.mjs remote claim ACCOUNT_KEY
node scripts/organizer.mjs remote resume JOB_ID
node scripts/organizer.mjs remote context JOB_ID
node scripts/organizer.mjs remote plan JOB_ID < plan.json
node scripts/organizer.mjs remote snapshot JOB_ID
node scripts/organizer.mjs remote checkin JOB_ID < result.json
```

CLI 只输出账号标识、计数和文件位置，不输出凭据或原文。每次在线调度先 prune 再 queue；清理只查看受管备份目录和文件时间，不读取快照内容，已撤销账号也会按期限清理。上下文暂存于 `.liubai/jobs/JOB_ID/`；冻结计划保存在 `.liubai/accounts/ACCOUNT_KEY/plans/ENTRY_ID.json`，绑定站点与账号，跨租约、跨 job 重试仍使用同一份计划。context 文件中的 frozenPlans 给出本账号当前输入对应的原计划路径，可直接作为 plan 命令的标准输入。不同账号使用全新 Agent 上下文，根调度只处理不透明标识与计数。快照必须早于 checkin；仅快照确认输入已处理且 checkin 成功后清理相应冻结计划，失败或待处理计划保留。

每小时整理和快照依赖 **Mac 开机、Codex App 运行、网络和凭据可用**。Mac 离线时云端仍可录入，整理工作留在云端；恢复后重新检查队列。不能保证补跑每个错过的小时，也无法补出离线期间每小时的历史快照。克隆仓库或安装 PWA 不会自动创建定时任务。

## 备份、恢复演练与任务迁移

页面「导出完整备份」下载本账号的明文 JSON，包含任务、软删除记录、收件箱、偏好、变更与导入映射；文件含私人内容，应妥善保存。机器小时快照使用 AES-256-GCM 加密，写入 `.liubai/backups/`，校验内容与落盘结果后才更新水位。有业务变化才新增快照，心跳和租约不触发快照。每次在线维护严格清理超过 30 天的受管快照，包括最后一份；过期水位一并移除，下次获授权检查会重新落盘。清理不跟随符号链接，不处理 before-upgrade 原库备份目录；电脑离线期间的到期清理由下次在线执行。

```sh
node scripts/backups.mjs local
node scripts/backups.mjs verify /绝对路径/快照.json.enc
node scripts/backups.mjs rehearse /绝对路径/快照.json.enc
```

`local` 通过本地 API 取得完整快照，不直接读取或改写运行数据库。`rehearse` **只在临时目录创建空 SQLite 做恢复演练**，校验固定表、主键、行数和内容；恢复业务数据及导入映射，排除机器授权与 job 租约。它不是生产恢复命令，也不会原地覆盖云库。生产恢复流程及 Sites 是否提供 D1 Time Travel 控制面仍需另行验证。

一次性本地任务合并采用「备份 → 生成文件 → 云端登录账号预览 → 本人确认」：

```sh
node scripts/import-tasks.mjs preview ACCOUNT_KEY /绝对路径/该账号云端快照.json.enc
```

脚本生成权限为 600 的任务导入文件，绑定目标账号与稳定来源标识。只包含未删除任务（含已完成）；不自动上传本地收件箱、偏好或历史。在云端「空间与数据」导入并查看预览后再确认。后端按实时任务版本冻结预览；若云端任务在确认前变化，重新运行上述命令生成新批次，再选新文件预览，不能继续使用旧批次。相同来源不重复新增，差异进入待确认，不覆盖现有任务。合并后保留本地原库，不建立持续双向同步。

## 开发、发布与后续范围

React 19 / Vinext / Vite；界面在 `app/`、`components/`，API 在 `app/api/`，业务规则在 `lib/`，表结构与追加迁移在 `db/schema.ts`、`drizzle/`。

```sh
npm run typecheck
node --test tests/cli-remote.mjs
npm run build
```

`npm start` 只预览构建后的 Worker，不提供本地自动身份。发布复用既有 Sites 项目和访问范围，使用当前受支持的 Sites 构建、打包与发布流程，必须携带 D1 迁移产物；不能用只上传 Worker 的临时包代替。打包时保留构建输出的 `dist/.openai/drizzle` 及完整 journal；根 `.openai/hosting.json` 用于项目关联，不能代替构建目录里的迁移元数据。发布成功后仍须回读线上表结构和机器队列，不能仅凭部署回执判断整理已可用。若工具或构建链不可用，应保留源码并说明阻塞，不声称已上线。

公开仓库为 [Su-Chen-Love/liubai](https://github.com/Su-Chen-Love/liubai)。`origin/main` 的提交推送只更新源码，不同步任务、不运行整理，也不等于发布站点。`.wrangler/`、`.liubai/`、环境变量、日志、凭据和备份不得提交。

搭档共享、自有密码账号、Dots、云端全天候执行、日历与提醒留待后续验证和设计，当前不承诺这些能力。更多边界见 [ARCHITECTURE.md](ARCHITECTURE.md)。
