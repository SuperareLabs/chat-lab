# 沈知衡本地试聊版

基于 ChatLab `version1.2.0` 维护分支的 `be57725`，独立分支 `codex/shen-zhiheng-local-1.2.0`。不是线上更新，也没有改写 `v1.2.0` 标签。

本机入口：`http://localhost:4334`，只监听 `127.0.0.1`，按用户要求免登录，打开即可聊天。4333 原实验台继续运行。新入口使用独立公共角色库，聊天、个人资料和记忆仍按 1.2.0 浏览器模式保存在该地址的 IndexedDB，不导入原入口的数据。

沈知衡现为六项提示词版本 `cold-persona-plain-v4`，详见[实际全文](shen-zhiheng-role-setting.md)和[旧版试聊记录](shen-zhiheng-iteration-review.md)：32岁，旧建筑修复项目负责人，克制慢热、有主见；默认关系为认识不深的平等成年人，沿用平台既有成年用户限制。新浏览器默认22岁访客、首次选中沈知衡。其余8个默认角色保留。另已加入[五位 Nuwa 原文人物](../character-packs/nuwa-20261116/README.md)，另新增成年知性女性[林晚晴](lin-wanqing-role-setting.md)，可以自然暧昧；当前共15位。

## 角色来源与修改

- `docs/shen-zhiheng-role-setting.md`：完整创作原文。思考偏向、说话节奏、接话方式、关系差异、矛盾、纠正和示例已写进自然语言定义。
- `config/shen-zhiheng.soul.v1.json`：兼容现有 SOUL 加载器的角色配置。
- `config/default-agents.json`：浏览器模式实际导入的默认角色，定义与 SOUL 一致。
- `public/assets/shen-zhiheng-avatar.svg`：文字头像，不是生成的人物肖像。

角色只通过现有 `name + definition` 入口参与模型输入。展示卡不补充隐藏人设；沈知衡继续使用原工具与记忆机制；五位 Nuwa 人物新增限定角色的公开资料读取工具及公开原文引用适配，详见人物包改动清单。入口默认选择沈知衡，各角色的既有独立会话仍保留。

源码版两份Markdown为正文源，执行 `node scripts/sync-local-personas.mjs` 同步两位的SOUL与默认种子。原 `node scripts/sync-shen-persona.mjs` 命令仍只同步沈知衡，可加一个交付Markdown路径保存其审阅副本。

后续可直接从角色图鉴编辑本浏览器的设定。若修改源码版，请同步角色原文、SOUL 配置及浏览器默认种子；已有用户手动编辑的定义不应被覆盖。

## 启动与资源保留

无需安装依赖。Node.js 24，沿用外部已配置的模型环境文件；不将模型 Key 或进入口令复制进源码。

重启时使用仓库根目录的 `scripts/start-shen-local.sh`，传入已有外部模型环境文件路径；脚本将入口固定为本机免登录，并关闭 DeepSeek 1017 经济版聊天思考。运行位置、PID、日志与核验回执位于被 Git 忽略的 `verification/`。

```sh
./scripts/start-shen-local.sh /绝对路径/模型环境文件.env
```

浏览器的工作区与本机 `data/public-catalog.sqlite` 是本轮试聊的持久资料，继续试用时保留。`verification/local-server.log` 是服务日志；工程测试日志可重建。停止时先核对 `verification/local-run.json` 中的 PID、工作目录和4334监听，再只向本实例发送 SIGTERM。不会停止4333，也不自动删除浏览器资料或角色库。

## 验证范围

API 核验记录在 `verification/local-api-smoke.json`：登录、默认22岁访客、沈知衡可见、完整提示词包含新角色且未混入林小满设定、文字头像可访问。工程检查和浏览器实际试聊的结果分别保存在 `verification/`；这些是接入验证，不代表人物自然度已经通过长期盲评。
