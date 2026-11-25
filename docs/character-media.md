# 角色照片与短视频

角色可在聊天中分享照片与短视频，包括人物、物件、宠物、环境和风景。每轮最多生成一份影像，普通聊天照常返回文字。

- **媒介**：按对方明确指定的照片或视频处理。未指定时，静态画面能交代清楚就选照片，只有动作、过程或声音影响理解时才选视频。
- **入镜**：照片通过 Share Photo 选择摄影机位，视频通过 Share Video 选择视频机位。
- **声音**：视频机位定义角色台词和环境音的处理方式。角色的声音可以来自镜头内，也可以是画外介绍。

## 保持同一情景

Agent 从当前会话已发的照片中选参考：同一房间、同一件物品或同一段布局需要延续时，选图并注明要保留的细节；换了场景或拍摄主体时，由 Agent 重新判断。可以从一张环境照接到角色自拍，再接到同一情景里的短视频。新的视角、动作和构图仍按这一轮的需求决定。

每次可选最多两张对话里的照片。照片随附的场景说明和保留细节供后续聊天选择参考；旧照片通过当时的聊天文字辅助辨认。

## Share Photo

ChatLab 通过本机 Service Clan 的 `gpu-qwen-image-21-app-production` 调用 Croco App 的生产 Qwen 网关（`:5889`）。使用 `qwen-image-2.1` 的 `wanwen-viggle9-1` 契约和固定 9 步的 `viggle9-base-tail-r256` 配方。

`share_photo` 先判断本轮是否需要沿用当前会话的旧照片，再把选中的照片及保留细节交给机位规划。机位规划根据主体选择 [六个摄影机位模板](../config/photo-templates.json)，填入英文主体、动作、穿搭和环境短语。完整角色机位加入设定图，第一人称拍物仅用文字描述允许入镜的局部，风景机位面向环境。明确的全身照采用 `SHOT_3RD_FULL`。

编译器按模板的原样 `camera_prefix`、动态槽位、原样 `realism_suffix` 组装提示词。画幅用 9:16（576×1024）、3:4（864×1152）或 4:3（1152×864）。有参考图走 `i2i`，无参考图走 `t2i`。生产网关只收一张参考图，多张素材时通过 FFmpeg 拼成参考板并注明各区域。模板的 `reference_weight` 值作为配置保留，当前网关契约没有单独的参考权重参数。

提交时设置 `X-Online-Capability: image-generation`，`Idempotency-Key` 沿用同一 `client_job_id`。任务成功后从产物列表取得已就绪的 PNG，再保存到本机聊天媒体目录。

[Service Clan 生产 App 生图网关接入文档](http://127.0.0.1:47391/docs/services/gpu-qwen-image-21-app-production/) · [Qwen Image 2.1 参考图改写指南](https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_edit.txt)

## Share Video

`share_video` 先判断本轮是否需要沿用同一会话的旧照片，然后按 [六套 Pika H3 Flex 视频机位](../config/video-templates.json) 规划主体的单一进行时动作、环境微动及具体发声介质。选中的照片以独立参考图提交。角色全量入镜的机位附设定图，第一人称拍物只允许角色局部入镜，环境空镜忽略台词。

编译器按机位、主体动作、环境与拟音、手机实拍底色组织提示词。模板的固定文本保留原样。Pika H3 Flex 通过主提示词引导环境拟音和运镜，接口没有独立的 `sfx_prompt` 或 `motion_strength` 参数。

输出固定为 9:16、480p，本地保存为 486×864。时长为 3–6 秒。无台词沿用机位的默认时长。有台词按每秒 4.7 个有效字符加 0.5 秒向上取整。绑定 Voice ID 时先用火山 ICL 2.0 合成，再按音频实长加 0.4 秒计算；音频本身超过 6 秒时提示缩短。出镜机位将干声作为 Pika 的音频参考引导口型。画外音对干声做 300 Hz–3.4 kHz 滤波，并把 Pika 底噪降低 18 dB 后混入。未绑定 Voice ID 的台词由 Pika 原生配音。鳄鱼爸爸继续使用预设音色 `S_eH42pcGL1`。

480p 文生视频按 USD 0.01／输出秒估算，参考生视频按 USD 0.03／输出秒估算。最终实付以 Pika 回执为准。本机工作区兼容旧视频工具记录的未结算费用。

[H3 Flex 文生视频](https://dev.pika.art/models/pika/pika-h3-flex/text-to-video) · [H3 Flex 参考视频与价格](https://dev.pika.art/models/pika/pika-h3-flex/reference-to-video/pricing) · [火山 ICL 2.0](https://www.volcengine.com/docs/6561/1598757)

## 本地启动

免登录本机 Demo 支持直接设置 `QWEN_APP_TOKEN_FILE` 和 `CHAT_PIKA_API_KEY_FILE`，并用 `CHAT_CHARACTER_MEDIA_DIR` 指定本机媒体目录。两个凭据文件使用项目外的绝对路径，权限为 `0600` 或 `0400`。这套配置将 Qwen 请求发往固定生产网关，Pika 请求发往官方 API。视频后处理需要 FFmpeg。未配置 Service Clan 时，视频由 Pika 处理原生声音。

导师 Demo 的搜索、推荐与媒体走同一轮工具判断，具体顺序见[导师推荐 Demo](mentor-recommendation-demo.md)。下面介绍单独启用媒体的本机工作区。

在免登录、仅监听 `127.0.0.1` 的浏览器工作区，设置 `CHAT_SERVICE_CLAN_TOKEN_FILE` 为本机 Service Clan 的 `.local/access-token` 绝对路径，设置 `CHAT_CHARACTER_MEDIA_DIR` 为专用本地媒体目录。照片需要 Service Clan 中的 `gpu-qwen-image-21-app-production` 和对应的 `QWEN_APP_API_TOKEN`。视频需要 `pika-h3-flex` 和 PATH 中的 FFmpeg。固定音色的有声视频另需 `volc-icl20-sse`。设定图来自应用内已登记的角色素材，SVG 需要同名 PNG 参考图。影像与照片的场景说明保存在媒体目录，浏览器聊天快照只保存引用。照片需组合多张参考时也使用 FFmpeg。若 Node 启用了环境代理，确保 `localhost,127.0.0.1` 绕过代理。

本机工作区使用同一个 Service Clan 令牌读取 `openrouter-jev-latest`。每次回复请求先把当前会话最近五轮（含本轮）的消息文本、附件类型和可用工具说明交给 Jev 判断。整体调用概率超过 65% 时，按逐工具概率选出最高项。最高项是照片或视频时，脚本从近期对话规划参数并生成附件，期间只展示进度。附件发出后，聊天模型根据场景描述接话，视频额外带动作描述。最高项是普通工具时，聊天模型按原有工具流程处理。判断为 65% 或以下时直接回复。Jev 判断的总超时为 5 秒，判断不可用时继续普通聊天流程，不触发影像生成。Developer 模式的「聊天详情 → 工具判断概率」展示概率、门槛和本轮流程。

本机通过成都 → 新加坡 SSH 隧道访问 Pika。申请上传、上传参考素材、提交视频任务、查询状态和费用、下载成片都走这条隧道。成都 SSH 连接从 Service Clan 的 `server-8-137-116-27` 读取，主机指纹须已录入本机 `known_hosts`。Pika 请求使用端到端 TLS。隧道在后台启动和重连。照片或视频没有送达时，角色直接承接聊天话题，发送状态和技术原因留在 Developer 模式的工具详情中。

设置 `CHAT_JEV_RELAY=chengdu-singapore` 后，Jev 复用同一条隧道，以端到端 TLS 访问 OpenRouter。隧道未就绪或转发报错时，直接进入原回复流程。

生成请求提交时，Developer 模式左侧的「影像生成原始提示词」显示实际发给照片或视频服务的完整 `prompt`，并随本轮调试记录保存。回复模型收到本轮影像的类型、送达状态和可用的描述。视频描述包含场景和动作。未送达时，已有描述代表拍摄计划。未形成有效计划时，描述为空。
