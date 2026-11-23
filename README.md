# 全Agent轻量聊天实验台

`release1.3.0` 用于本地网页试聊。角色、提示词和记忆机制先在这里验证，默认入口为 [localhost:4334](http://localhost:4334/)。

`release1.3.0-telegram` 用于在 Telegram 体验已经验证的聊天能力，入口为 [CrocoDaddy ChatLab Bot](https://t.me/CrocoDaddy_ChatLabBot)。成都网页版已停运，原部署记录见[成都网页版部署归档](docs/deployment.md)。

发布分支默认展示 **苏清月、鳄鱼爸爸、大肥鱼、林晚晴** 四位角色。[苏清月](docs/lin-xiaoman-role-setting.md)沿用林小满的角色 ID，日常默认发一条短消息。鳄鱼爸爸补齐AI学习指导、结果修改与事实核实的多轮接法；日常保持默认1条、需要时2～3条，每条通常5～20字、最多30字。完整角色正文和真实模型试聊见[鳄鱼爸爸提示词](docs/croco-daddy-role-setting.md)、[AI导师试聊记录](docs/croco-ai-mentor-trials.md)。其他历史角色隐藏归档，已有记录保留。

模型明确输出消息数组，一条消息内可以有多个段落、列表或代码块；前端不再根据换行猜测气泡数。计算器采用有界的精确有理数运算，支持大整数、精确小数和整数次幂。后台刷新保留当前会话、草稿与滚动位置，避免无变化的重复重绘。

主聊天使用 DeepSeek 4.1 Flash 1017 经济版，思考关闭；Doubao Lite负责记忆提取，Doubao Mini负责联网搜索。基于 Node.js 24 原生HTTP/SQLite和原生浏览器API，没有第三方Node包依赖。

访客资料、聊天、记忆、私人角色、草稿与用量仍保存在当前浏览器的IndexedDB；新建公共角色保存在独立服务端角色库。更新不重置现有工作区、公共角色或私人修改，不导入开发者的个人资料。Nuwa原文人物包作为归档资料保留，[原文来源和授权](character-packs/nuwa-20261116/README.md)不等于这些人物仍在默认角色列表展示。

[1.3.0 发布说明](docs/releases/v1.3.0.md)记录封版和本地实验分支后续改动。历史版本以已有标签为准。

## 本地启动

需要 Node.js 24 或更新版本。获取维护分支代码后启动：

```sh
git clone --branch release1.3.0 git@github.com:SuperareLabs/chat-lab.git
cd chat-lab
cp .env.example .env
# 编辑 .env，填写自己的 CHAT_ACCESS_PASSWORD 与 ARK_API_KEY
npm start
```

打开 [http://127.0.0.1:4333](http://127.0.0.1:4333)。无需 `npm install`。密码只在服务端环境中配置，不写进前端或仓库。模型 Key 同样只在后端使用；不设置 Key 可查看页面与配置角色，但不能发起真实模型调用。

`config/runtime.env` 只有公开默认配置；`.env` 已被 Git 忽略。也可通过系统环境变量或部署平台提供这些值。默认监听 `0.0.0.0:4333`，局域网可用启动时打印的地址。只允许本机时设置 `CHAT_HOST=127.0.0.1`。

## 页面使用

1. 输入共享进入密码。首次进入会展示可跳过的4步引导；之后可用“使用指南”重开。
2. 左上角选择 Agent，查看形象、完整角色设定与实际提示词。创建角色只填“名称”和“角色设定”，保存后即进入公共库，其他访客可以聊天。创建者可编辑或删除，管理凭证保存在创建者浏览器。原有本机角色不会自动公开，系统角色的本机编辑仍只属于自己。
3. 右上角选择或创建个人资料、选择会话或开启新会话。新浏览器提供22岁的“访客”测试资料，不会带入开发者的测试用户。
4. 中间聊天，左侧查看当前模型上下文与工具，右侧查看用户概括、记忆摘要和详情。输入框下方显示上下文、token和费用估算。
5. 右侧“清空记忆”默认只清当前用户×当前 Agent：包括概括、学习到的画像、活跃/归档/撤回记忆及旧整理上下文。确认后自动打开干净的新会话；基础个人资料、其他作用域和历史聊天保留。
6. 退出只结束进入凭证，本地记录保留；重新输入密码后继续使用。服务重启后需要重新输入密码，本地数据不受影响。
7. 自己创建的角色可在角色图鉴管理并删除。公共角色删除后全员下架；已有聊天和记忆不级联删除。系统角色不能删除，其他人的公共角色只能查看和聊天。

## 本地保存的边界

- 同一浏览器、同一网站地址的多个标签页共享本地工作区，使用事务租约和修订检查防止相互覆盖。不同浏览器或设备各自保存。
- `localhost`、局域网 IP、不同端口和正式域名属于不同网站地址，不会自动迁移记录。清除网站数据会删除本地资料。
- 这是联网模型服务：处理请求时，当前工作区快照会临时传到后台；聊天、联网和记忆整理会将必要内容交给对应模型提供商。应用不在服务器磁盘保存访客资料，也不提供跨设备同步。
- 15分钟空闲整理在页面打开时按到期时间执行；关页后不会继续在服务器驻留，下次打开会补处理。每次请求最多整理一条记忆任务，其余逐条补齐。
- 网络硬中断时保留本机草稿和已收到内容，提示手动恢复，不自动重复付费发送。另一个标签页的未完成操作必须先完成或显式恢复。
- 当前工作区快照传输上限16 MiB；这是请求限制，保留现有每用户×角色500条活跃记忆、按提及时间归档的规则。归档内容仍可检索。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| `CHAT_ACCESS_PASSWORD` | 公开体验入口口令，必须在服务器配置。 |
| `CHAT_STORAGE_MODE` | 默认 `browser`；`server` 为私有旧式 SQLite 模式，不用于这次公共体验部署。 |
| `CHAT_CATALOG_PATH` | 公共角色SQLite，默认 `data/public-catalog.sqlite`；仅保存公共设定、修订与管理凭证哈希，必须与旧聊天数据库分开。测试可设 `:memory:`。 |
| `CHAT_PUBLIC_ORIGIN` | 部署时填写确切外部 Origin，如 `https://chat.example.com`；多个值用逗号隔开，不带路径。 |
| `CHAT_HOST` / `PORT` | 默认 `0.0.0.0` / `4333`。 |
| `ARK_API_KEY` | 方舟 Key；不要提交到 Git。 |
| `ARK_API_KEY_FILE` | 可选仓库外凭据文件绝对路径，当前用户所有且权限0600或0400。 |
| `ARK_BASE_URL` | 默认方舟 API 地址；其他平台需核对协议兼容。 |
| `ARK_MODEL` / `ARK_ENDPOINT` | 当前聊天配置 `deepseek-v4-1-flash-economy-261017`。 |
| `ARK_MEMORY_MODEL` / `ARK_MEMORY_ENDPOINT` | 当前记忆配置 `doubao-seed-2-1-lite-260915`。 |
| `ARK_SEARCH_ENABLED` / `ARK_SEARCH_ENDPOINT` | 默认启用，搜索模型 `doubao-seed-2-0-mini-260428`。 |
| `CHAT_TIMEZONE` | 默认 `Asia/Shanghai`。 |
| `CHAT_CONTEXT_BRIEF` | 默认0，复用同次提取维护的概括；1为旧派生概括兼容模式。 |
| `CHAT_DB_PATH` / `CHAT_ALLOW_DATA_RESET` | 仅旧服务器模式使用；公开模式不打开这个数据库文件。 |

目前是共享门禁，不是独立账户系统。进入凭证使用 HttpOnly / SameSite Cookie，HTTPS外部Origin下设置Secure；退出撤销凭证。服务器重启不保留进入凭证。登录失败按连接地址限流；同机反向代理下该限流可能覆盖所有新访客。

## 部署准备

当前线上使用单个 `chat-lab.service`，Node.js 24.22.3 监听 `0.0.0.0:9988`，配置 `CHAT_PUBLIC_ORIGIN=http://8.137.116.27:9988`。公共角色库固定在 `/var/lib/chat-lab/public-catalog.sqlite`，口令和API Key只在服务器外部环境文件中保存。实际目录、systemd配置、备份与更新步骤见[部署说明](docs/deployment.md)。

公网部署须配置精确的 `CHAT_PUBLIC_ORIGIN`；HTTPS反向代理保留正确 `Host`。不信任浏览器随意提交的 `X-Forwarded-*` 来放宽跨站校验。代理需支持流式SSE并关闭缓冲，完整示例和验证项见[公开体验架构](docs/browser-local-demo.md)。公共角色库放在代码发布目录外，部署新版本时保留该数据库，详见[公共角色库](docs/public-role-library.md)。

发布只打包源码、公开默认角色与静态资源。不要打包整个开发工作目录、`.env`、`data/`、`verification/` 或未跟踪的私人音频。默认角色配置位于 `config/default-agents.json`，不包含个人资料、对话、记忆和私人参考音频。

## 原有机制

角色仍为 `name + definition`，平台提供共用工具与记忆规则。工具为 `recall_memory`、`get_memory_detail`、`search_web`、`calculate`。记忆提取保持正常一次模型调用，校验失败最多定向重整一次；提及、去重、更正、撤回、概括和归档沿用框架6。公开模式只改变持久化归属，未更换共用规则或记忆提取提示词，记忆语义不变。

大肥鱼、陈放、阿墨、唐梨的日常接话统一为：默认1条，必要时2～3条，每条最多30字；明确要求详细解释、步骤或比较时再展开。未自行改动的默认角色会在进入页面时受控升级，私人编辑和自建角色保持原样，不清记忆。周屿补齐头像。

旧私有实验台的 SQLite 和历史资料不会自动导入公开模式，也不会被删除。需要查看旧记录时，在仅本机可达的地址显式启用 `CHAT_STORAGE_MODE=server` 并指定旧数据库；不要把这个模式直接作为公共体验部署。

## 文档与测试

- [角色照片、短视频和本地配置](docs/character-media.md)

- [1.3.0 封版说明](docs/releases/v1.3.0.md)
- [历史1.2.0封版说明](docs/releases/v1.2.0.md)
- [公开体验架构与部署准备](docs/browser-local-demo.md)
- [当前线上部署与更新说明](docs/deployment.md)
- [公共角色库与创建者管理](docs/public-role-library.md)
- [原聊天、工具与记忆架构](docs/architecture.md)
- [角色提示词编写方向](docs/character-prompt-direction.md)
- [已知限制](docs/known-limitations.md)
- [美术素材说明](docs/ASSETS.md)
- [上一封版1.1.2](docs/releases/v1.1.2.md)

```sh
npm test
```

测试使用合成资料、内存工作区和模拟模型，不需要Key，也不付费。测试覆盖鉴权不可绕过、跨工作区隔离、实际聊天/记忆保存恢复、清空不复活、错误恢复、跨标签修订防护；真实浏览器另做界面验收。测试通过不代表模型语义或真人感已稳定。

项目尚未指定代码许可证；资源授权范围与源码公开状态分别管理。
