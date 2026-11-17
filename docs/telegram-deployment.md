# Telegram 私聊测试版

分支 `release1.3.0-telegram`，复用1.3.0人物和记忆框架6。运行在8.219.159.78的单个 `chat-lab-telegram` Docker容器中；不依赖成都网页服务，不开放HTTP端口。Telegram入口为 https://t.me/CrocoDaddy_ChatLabBot 。

## 用户怎么开始

打开机器人，点“开始”，直接发文字。未开通账号会显示自己的数字ID；管理员把确认过的ID加入外部配置后重建Bot容器。不要凭用户名或首个/start自动认领管理权限。

- `/roles`：选择林小满、鳄鱼爸爸、大肥鱼、林晚晴；各自保存历史和记忆。需要成年资料的角色仍要求先填写年龄：`/profile age 22`，请按实际填写。
- `/new`：和当前角色开始新会话，旧会话进入记忆整理；长期记忆保留。
- `/create`：按提示输入角色名字、完整提示词，创建后自动切换；只保存在本人工作区。`/myroles`查看；`/editrole`编辑当前私人角色；`/deleterole`确认停用，保留旧记录。
- 发送语音后先看转写，点确认才发给角色。`/correct 正确内容`改转写，`/cancel`取消；只支持两分钟、8MB以内的Telegram voice。角色始终回复文字。
- `/memory`查看记忆和整理状态；`/retrymemory`手动重试最近失败任务，可能再次计费；`/forget`确认清空本角色记忆，旧历史保留但不自动带回。
- `/stop`停止当前生成；`/resend`重发上一份已保存回答，不再次生成。`/history`查看最近五份会话摘要与最后几句；`/status`、`/usage`查看状态和Token汇总。

“角色消息”与“段落”沿用1.3.0：模型messages数组中的每项发一条Telegram消息；每项内的换行留在同一条。只有超4096字符才作传输分片。人物日常字数条数不改。

## 服务器文件

| 路径 | 用途 |
|---|---|
| `/etc/chat-lab-telegram/bot.env` | root所有、0600；Bot Token、受邀ID、聊天及ASR凭据。不得进入Git或镜像。 |
| `/var/lib/chat-lab-telegram/bot.sqlite` | 收件箱、发送箱、offset和Bot身份。 |
| `/var/lib/chat-lab-telegram/users/<bot_id>/<telegram_user_id>.sqlite` | 每人的完整ChatStore：角色、资料、会话、记忆、用量、任务和命令回执。 |
| `/opt/chat-lab-telegram/releases/` | 可追溯源码、Docker部署文件和验证回执。 |
| `/opt/chat-lab-telegram/current` | 当前部署目录符号链接。 |

配置至少包含TELEGRAM_BOT_TOKEN、TELEGRAM_ALLOWED_USER_IDS、ARK_API_KEY。语音使用TELEGRAM_ASR_API_KEY及TELEGRAM_ASR_RESOURCE_ID。模型、思考关闭及独立记忆模型的公共默认值来自config/runtime.env。白名单最多16人；默认每日200次聊天调用，UTC日期；命令及已完成请求重放不重新调用模型。

```sh
ssh chatlab-telegram
docker ps --filter name=chat-lab-telegram
docker logs --tail 30 chat-lab-telegram
docker stats --no-stream chat-lab-telegram
```

外部配置修改后重新创建容器：

```sh
docker compose -f /opt/chat-lab-telegram/current/deploy/telegram/compose.yaml up -d --force-recreate
```

不要输出完整docker inspect环境变量，也不要把私有配置复制到源码目录。

## 备份、恢复与更新

持久目录必须完整备份，SQLite主文件和WAL属于同一份状态。跨bot.sqlite与用户库的一致性备份先优雅停止本Bot，再归档整个目录，完成后启动。备份保存在独立私有目录，不能当作可重建缓存删除。容器删除不会删除宿主机挂载数据。

更新前保存旧镜像ID、当前源码目录、私有配置备份及一致性数据备份；模型调用中的进程重启按“结果不明”处理，不自动再花钱生成或提取。回滚代码须检查数据版本兼容，禁止靠清库启动旧版本。

本版Docker健康检查依据轮询心跳；只有一个实例使用Bot Token拉取更新。有既存Webhook时启动拒绝接管；不会调用deleteWebhook或丢弃待收消息。

## 已验证与限制

本地338项自动化测试在160MB堆限制下通过，服务器容器20项专项测试通过；包含多用户/角色隔离、权限、私有创建编辑、清空封存、消息段落、重复更新、崩溃间隙、发送不确定和语音确认。独立模拟用户真实测试已完成短句多轮、成功提取记忆、开新会话回忆；测试数据与真人工作区分开。

发送API超时可能已经送达，所以不保证平台端绝对一次；发送结果不明不自动重发，用户可用/resend取回已有答案。尚未实现群聊、跨网页账户绑定、分享、自动合并连发、在线邀请、自动备份调度和持续告警。

服务器已实测：Docker内调用豆包ASR识别“你好，我想用人工智能学画画。”成功；使用实际ChatRuntime调用DeepSeek成功；Telegram真实收件与回复已有成功回执，健康检查healthy。容器初始观测约74MiB内存，320MiB为上限；后续并发及长期运行仍需观察。
