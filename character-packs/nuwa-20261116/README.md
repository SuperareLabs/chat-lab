# Nuwa 原文人物对话包

当前运行版本 `nuwa-original-v3`，适配版本 `source-preserving-v3`，入口为 [ChatLab 本地4334](http://localhost:4334/)。乔布斯、费曼、芒格、张一鸣重新接入 Nuwa 原文，新增孙宇晨。五份 SKILL.md 均全文保留，包括 YAML、表达 DNA、经历、性格矛盾、接话示例与工作流；没有删减原文字句。

| 人物 | 实际运行提示词 | 原文与运行版对照 |
|---|---|---|
| 乔布斯 | [完整正文](roles/steve-jobs.md) | [新增行 diff](changes/steve-jobs.diff) |
| 费曼 | [完整正文](roles/feynman.md) | [新增行 diff](changes/feynman.diff) |
| 芒格 | [完整正文](roles/munger.md) | [新增行 diff](changes/munger.diff) |
| 张一鸣 | [完整正文](roles/zhang-yiming.md) | [新增行 diff](changes/zhang-yiming.diff) |
| 孙宇晨（新增角色） | [完整正文](roles/sun-yuchen.md) | [新增行 diff](changes/sun-yuchen.diff) |

## 原文与必要适配

来源：[alchaincyf/nuwa-skill](https://github.com/alchaincyf/nuwa-skill)，固定提交 `73b6f2d048c4b06aafd45fc16026c01b7277fd78`。作者 Huashu（花叔），[MIT 授权原文](LICENSE)。[来源清单](source-manifest.json)记录43份原文件及各自 Git blob、SHA-256；包括五份 SKILL.md 及其公开案例、表达与研究资料，共749,452字节。每份原文件均与上游 Git 文件哈希核对。

每份运行设定只有前置的“【ChatLab 架构适配段｜本地新增，非 Nuwa 原文】”以及原文起止标记为新增。详细内容见[必要适配与改动清单](ADAPTATION.md)，[保留检查报告](preservation-report.json)记录五位原文完整存在、删除字符数均为0。正文区是连续原文，没有用摘要代替；附带资料按需读取。

适配解释选择角色即激活、WebSearch 到 search_web 的映射与单轮限制、references/ 的只读工具、公共研究与私人记忆的区别、既有事实诚实和身份边界。首次身份说明和退出行为依原文恢复。孙宇晨的自信与夸张按原作保留，不能因此编造数据、私人关系或保证结果。

新增 `read_character_reference` 仅能读取当前角色清单中的公开资料，支持索引、章节和分页；拒绝其他角色和任意本机路径。封存题、验证答卷、FIDELITY.md、旧研究及演示聊天不进入运行资料。没有执行上游脚本或安装依赖。

框架的输出防复制校验只豁免经哈希验证、实际包含在本轮输入中的公开 Nuwa 原文，避免公开原话和首次身份说明被误拦截。共用规则、适配段、私人增补仍受既有保护。

上一版自行补写的生活、关系、情绪及对话示例已移出运行正文。旧稿及种子保存在本地 `verification/source-preserving-v3-before/`，便于回滚；不会声称这些自写内容来自 Nuwa。

## 更新与数据

先维护原文件、来源清单或独立适配段，再执行：

```sh
node scripts/sync-nuwa-originals.mjs
```

原 `sync-nuwa-personas.mjs` 命令现为上述构建器的别名，不能再写回压缩版。`roles/`、`changes/`、保留报告、`characters.json` 与默认种子由构建器生成，不直接编辑生成正文。

四个旧角色ID保持不变；孙宇晨使用 `nuwa-sun-yuchen`。未手动改写的默认人物原位升级；私人修改保留。既有聊天和记忆不重置，其他角色保留；本地另新增林晚晴后，共15位。历史模型输入仍反映当时版本。

本地免密码，仅监听127.0.0.1；4333原服务不动。主聊天仍是 `deepseek-v4-1-flash-economy-261017`，聊天思考关闭，记忆模型不变。

已有工作区的记忆跨会话重复提及校验同步修复：保留原创建会话与最新提及锚点，只验证用户及角色一致；不删除或改写已有记忆，跨角色来源仍拒绝。

## 验证边界

工程测试核对完整保留、原文引用、资料读取、角色隔离与既有框架行为；真实试聊与浏览器检查保存在本地 `verification/`。接入成功和原文保留不等于人物还原度已通过长期盲评，也没有在本地复现上游保真成绩。
