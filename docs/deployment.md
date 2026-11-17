# 当前线上部署与更新

1.3.0发布日期：2026-11-17（Asia/Shanghai）。源码分支 `release1.3.0`，固定标签 `v1.3.0`；使用已提交源码归档发布。当前提交、包哈希和上一版本路径写入服务器 `/opt/chat-lab/deployment/`，与本地忽略目录的发布回执核对。

## 实际运行位置

| 项目 | 当前配置 |
| --- | --- |
| 入口 | http://8.137.116.27:9988/ ，当前为HTTP直接访问 |
| 服务 | `chat-lab.service`，单Node进程，开机启动、异常重启 |
| 运行用户 | `chat-lab` |
| Node | 独立Node.js 24.22.3，不替换系统Node20 |
| 代码 | `/opt/chat-lab/current` → `releases/1.3.0-提交短号`；旧的 `1.2.0-1bd1cf7` 保留 |
| 运行时 | `/opt/chat-lab/runtime/node-v24.22.3-linux-x64/bin/node` |
| 外部环境文件 | `/etc/chat-lab/service.env`，root所有，0600 |
| 公共角色库 | `/var/lib/chat-lab/public-catalog.sqlite`，服务用户所有，0600 |
| 数据目录 | `/var/lib/chat-lab`，服务用户所有，0700 |
| 部署记录 | `/opt/chat-lab/deployment/`，保留发布包、校验及回滚记录 |

服务器仅持久保存公共角色设定、修订、管理凭证哈希和删除墓碑。访客资料、聊天、记忆、私人角色、草稿与创建者凭证原文保存在各浏览器；请求期间临时进入服务端内存，不复制旧私有聊天数据库。

## 服务端配置

以下为实际非敏感配置；进入口令和 `ARK_API_KEY` 另在外部环境文件中设置，不能放入Git或静态前端：

```dotenv
CHAT_STORAGE_MODE=browser
CHAT_HOST=0.0.0.0
PORT=9988
CHAT_PUBLIC_ORIGIN=http://8.137.116.27:9988
CHAT_CATALOG_PATH=/var/lib/chat-lab/public-catalog.sqlite
CHAT_TIMEZONE=Asia/Shanghai
CHAT_CONTEXT_BRIEF=0
CHAT_ALLOW_DATA_RESET=0
```

`config/runtime.env`继续提供公开模型默认值：DeepSeek负责聊天，Doubao Lite负责记忆提取，Doubao Mini负责联网搜索。实际配置以服务器环境覆盖为准；密钥不随发布包提供。更新代码时保持 `CHAT_CATALOG_PATH` 的现有值，改指向一个空数据库会造成公共角色暂时不显示。

当前systemd服务的关键配置如下：

```ini
[Unit]
Description=Chat Lab browser-local public demo
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=chat-lab
Group=chat-lab
WorkingDirectory=/opt/chat-lab/current
EnvironmentFile=/etc/chat-lab/service.env
ExecStart=/opt/chat-lab/runtime/node-v24.22.3-linux-x64/bin/node --env-file-if-exists=config/runtime.env server.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=900
KillSignal=SIGTERM
UMask=0077
StateDirectory=chat-lab
StateDirectoryMode=0700
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
SyslogIdentifier=chat-lab

[Install]
WantedBy=multi-user.target
```

`StateDirectory`允许独立公共角色库在只读代码目录之外写入。`AF_NETLINK`用于Linux网卡枚举，缺失时会影响启动；它不新增对外业务端口。单进程用于保持RAM门禁凭证一致。SIGTERM会等待在途聊天与记忆任务完成，停止超时保留900秒。

## 更新代码

1. 在构建机获取 `release1.3.0` 的 `v1.3.0` 固定代码。工作区有修改时先保存，不覆盖私人文件；用 `git archive` 生成只含已提交源码的发布包，记录提交和SHA256。不要打包 `.env`、`data/`、`verification/`、私人音频或旧聊天SQLite。
2. 更新前对公共角色库做一致性备份，保留现有服务文件、外部环境配置和旧release。公开角色库属于运行数据，不能在发布时清空或重新初始化。
3. 解压至独立新目录，例如 `/opt/chat-lab/releases/1.3.0-提交短号`。保持代码root所有、服务用户只读，使用独立Node24验证语法和模拟模型测试。
4. 原子切换 `current` 软链接，再执行 `systemctl restart chat-lab.service`。只有修改过服务文件时才需要先 `systemd-analyze verify` 和 `systemctl daemon-reload`。
5. 核对状态和接口。服务重启会使旧进入凭证失效，需要重新输入口令；浏览器工作区及创建者管理凭证仍保留。

1.3.0本地已通过318项自动测试、消息数组与AI导师真实模型试聊；发布时另在服务器执行自动测试和门禁/角色/版本核验。具体回执保留在部署记录，不把历史验证次数当成这次线上检查结果。

## 公共角色库备份与回滚

当前运行时可用SQLite `VACUUM INTO`生成一致备份，避免运行期间只复制主文件遗漏WAL。下面以服务用户执行，不读取或输出管理凭证：

```sh
runuser -u chat-lab -- /opt/chat-lab/runtime/node-v24.22.3-linux-x64/bin/node --input-type=module <<'JS'
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
const folder = '/var/lib/chat-lab/backups';
mkdirSync(folder, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = `${folder}/public-catalog-${stamp}.sqlite`;
const db = new DatabaseSync('/var/lib/chat-lab/public-catalog.sqlite');
db.exec('PRAGMA busy_timeout=5000');
db.prepare('VACUUM INTO ?').run(destination);
db.close();
chmodSync(destination, 0o600);
console.log(destination);
JS
```

回滚代码时把 `current` 切回保留的旧release并平滑重启；保持公共角色库及其墓碑不变。若回滚到不支持公共库的早期代码，公共角色会暂时不可见，恢复新版后继续使用保留的数据。数据库恢复必须先停服务、保留现状备份，确认恢复点后处理主文件及WAL/SHM，不能把运行中的旧WAL直接套到恢复文件上。浏览器本地聊天与记忆不包含在服务器备份中。

## 验证与访问地址

```sh
systemctl is-active chat-lab.service
systemctl is-enabled chat-lab.service
journalctl -u chat-lab.service -n 30 --no-pager
curl -i http://8.137.116.27:9988/api/auth/session
curl -i http://8.137.116.27:9988/api/catalog
```

首页及进入状态应返回200；未登录公共角色库应返回401。用页面输入服务器口令后，角色库应正常读取，创建表单明确提示公开，系统角色没有删除按钮。默认展示林小满、鳄鱼爸爸、大肥鱼和林晚晴，默认访客22岁，原有用户与记忆保留。以上检查无需调用模型。

当前没有配置HTTPS域名。以后迁移域名或协议时同步修改精确 `CHAT_PUBLIC_ORIGIN` 和代理Host；不同Origin的IndexedDB及管理凭证不会自动迁移。HTTPS反代的SSE与请求大小配置见[浏览器本地架构](browser-local-demo.md)。
