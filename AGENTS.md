# 留白项目约定

- 保留中文、低饱和、留白充足的设计。先解决用户实际工作流，再增加设置。
- 本地日常启动为 `npm run local`，固定回环地址 `http://127.0.0.1:4178`。不要把开发服务暴露到局域网；云端身份仍由 Sites 管理。
- 用户授权整理任务时，使用 `node scripts/tasks.mjs`，不要直接改 SQLite、伪造用户身份或写演示数组。先运行 `list` / `agenda` 获取真实状态和 ID；新建用 `create` 加标准输入 JSON，修改用 `update ID` 加变更 JSON，完成用 `complete ID`。完整协议见 README。
- 写入后读取一次验证结果；并发冲突先重新读取并合并，不绕过 revision。只有用户要求删除时才删除任务。
- 本地 `.wrangler/state/` 是用户数据，不是可清理缓存。改 schema 使用追加迁移；不要重放或改写已有迁移。不要清空数据来修复启动问题。
- 本地与云端独立；未实现同步前不要声称两者一致。身份绑定不代表有权读取 ChatGPT 历史或日历。
- 定时整理只有用户明确要求后才使用 Codex 的 automation 工具；先确认已有相关任务，避免重复。页面日期筛选不是提醒系统。
- GitHub 源码更新推送到 `origin/main`，不等于发布网站。公开仓库不携带部署身份。发布前读取 `.liubai/sites-project.json`（若存在）或已关联的 Sites 源码检出，复用已有项目并保留访问范围；不要因公开 manifest 没有 project_id 就创建替代站点。用 Sites 正式构建/打包流程保留 D1 migrations；禁止运行时 DDL 补救。
- 源码改动运行 `npm run typecheck`；涉及接口/持久化时验证相应实际读写与重启。工作笔记、日志、token、数据库、备份不提交。
- 批量输入与定时整理使用 `node scripts/organizer.mjs queue/plan/resume/checkin`，先读 `ORGANIZER.md`。原文与任务变更进入数据库，禁止绕过待确认区直接覆盖或删除。
- 用户画像仅是收件箱内可编辑的明确背景与偏好；不根据任务静默推断人格或敏感特征。
