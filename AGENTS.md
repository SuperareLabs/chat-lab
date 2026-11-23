# ChatLab 开发与发布流程

在 `release1.3.0` 做本地 Web 试聊，验证通过的共享功能再进入 `release1.3.0-telegram`，供 Telegram 在线试用。`version1.0.0` 是历史公开基线。当前以两条维护分支为集成目标，不创建 `main` 或 `dev`。分支分工见 [1.3.0 发布说明](docs/releases/v1.3.0.md)。

## 1. 开发分支

先运行 `git fetch origin`，再按改动范围创建 `feature/<主题>` 或 `fix/<主题>`。

| 改动范围 | 开分支基线 | 合回目标 |
| --- | --- | --- |
| 角色、提示词、聊天核心、工具、记忆机制 | `origin/release1.3.0` | `release1.3.0` |
| Web 界面、浏览器工作区、Web 门禁和公共角色库 | `origin/release1.3.0` | `release1.3.0` |
| Telegram 菜单、语音、管理页和 Bot 部署 | `origin/release1.3.0-telegram` | `release1.3.0-telegram` |

一个功能涉及共享核心和渠道适配时，将两部分提交拆开，方便单独验证、同步和回退。

## 2. 验收与同步

1. 用 Node.js 24 运行 `npm test`。在合入前记录候选提交、测试结果和人工验收场景。模拟模型测试无需模型 Key。
2. Web 改动在浏览器走一次受影响的完整流程。角色、提示词、消息格式、工具或记忆行为有变化时，用合成资料做针对性试聊。涉及持久化或迁移时，用旧版本工作区样本验证升级后仍能读取既有会话和记忆。
3. 共享功能在 Web 验收并合入 `release1.3.0` 后，从最新的 `origin/release1.3.0-telegram` 创建同步分支。逐个选取已验证的共享提交，例如用 `git cherry-pick -x <共享提交SHA>`，然后补齐 Telegram 适配。整条 Web 分支及 Web 专属改动留在 Web 线。
4. 同步后的 Telegram 候选版本重新跑 `npm test`，并参照改动范围验证 Bot 收发、消息格式、会话与记忆隔离等实际入口。通过后合回 `release1.3.0-telegram`。纯 Telegram 改动直接在该渠道验收。每条维护线的验收结果分别记录。

## 3. 封版与部署

1. 确认要发布的渠道、版本号和通过验收的完整提交 SHA。在该 SHA 上打新的 annotated tag，Web 沿用 `vX.Y.Z`，Telegram 沿用 `vX.Y.Z-telegram`。已发布标签保持固定。发布说明记录变更、验收结果及数据兼容性，需要公开说明时从对应标签建 GitHub Release。
2. 从封版 SHA 的已提交源码归档或构建，记录源码 SHA 及归档 SHA256 或镜像 ID。运行时凭据、私人工作区、数据库和验收产物留在发布包外。Git 标签和 GitHub Release 仅记录封版，实际部署另行执行并记录。
3. 当前 Web 线用于本地实验。Telegram 部署前记录现用镜像 ID、源码目录和配置，并按部署手册优雅停止 Bot，完整备份持久目录中的 SQLite 和 WAL。按已验收提交构建并切换容器，确保同一 Bot Token 只有一个轮询实例。部署后检查容器心跳、日志和实际收发，再记录上线 SHA 和镜像 ID。

## 4. 回滚

- **Web**：从上一已验收提交启动本地代码。先确认旧代码能读现有工作区和公共角色库，保留原 Origin、数据库路径和快照。数据格式有分歧时，保留现状并修复兼容性。
- **Telegram**：先确认上一镜像支持现有数据版本，再切回已记录的旧镜像及对应部署配置，保留持久数据目录。若确需恢复数据，先停 Bot 并备份故障现场，再按手册恢复完整的一致性备份。恢复后检查心跳、消息收发和已有会话。用新提交和新标签记录后续修复。

运维细节见 [Telegram 部署手册](https://github.com/SuperareLabs/chat-lab/blob/release1.3.0-telegram/docs/telegram-deployment.md#备份恢复与更新)。成都 Web 运维步骤属于历史记录，见 [成都 Web 部署归档](docs/deployment.md)。
