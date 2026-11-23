# 角色照片与短视频

角色可在聊天中分享自己的生活场景。Agent 先选媒介，再决定谁入镜。每轮最多生成一份影像，普通聊天照常返回文字。

- **媒介**：按对方明确指定的照片或视频处理。未指定时，静态画面能交代清楚就选照片，只有动作、过程或声音影响理解时才选视频。
- **入镜**：如果对方想看角色本人、她的表情或她亲自展示的动作，选择角色入镜。当对方想看的只是一个地方、物件或结果，使用后摄视角对准拍摄主体。两种构图都可搭配照片或短视频。
- **声音**：短视频可单独指定角色的原话与环境音。角色的声音可以来自镜头内，也可以是画外介绍。

## 千问生活照

ChatLab 通过本机 Service Clan 的 `gpu-qwen-image-21-app-production` 调用 Croco App 的生产 Qwen 网关（`:5889`）。使用 `qwen-image-2.1` 的 `wanwen-viggle9-1` 契约和固定 9 步的 `viggle9-base-tail-r256` 配方。

角色入镜用 576×1024（竖屏 9:16）。先上传一张设定图作为身份参考，再用 `i2i` 提交。只拍主体用 768×1024（竖屏 3:4），从后摄视角构图，使用 `t2i`。两条路径都保留真实环境光、暗部细噪点和轻微手持感。

提交时设置 `X-Online-Capability: image-generation`，`Idempotency-Key` 沿用同一 `client_job_id`。任务成功后从产物列表取得已就绪的 PNG，再保存到本机聊天媒体目录。

[Service Clan 生产 App 生图网关接入文档](http://127.0.0.1:47391/docs/services/gpu-qwen-image-21-app-production/) · [Qwen Image 2.1 参考图改写指南](https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_edit.txt)

## H3 Flex 生活短视频

视频固定 9:16 和 480p，保留自然手持晃动、光影和曝光变化。角色入镜时，直接把设定图作为 H3 Flex `reference-to-video` 的图片参考，只拍主体时直接走 `text-to-video`，使用后摄单镜头。

工具分别填写场景、动作、可选原话和环境音。角色可以在镜头前说一句，背景是现场底噪和物件声。苏清月走 Pika 原生配音，时长按每秒 4.7 字估算，标点和空格不计，和动作所需时长取较长者向上取整，范围 3–5 秒。鳄鱼爸爸有台词时，由 Service Clan 的火山 ICL 2.0 用绑定音色先合成，再量出实际音频时长，与动作所需时长取较长者。将音频和设定图一起交给 Pika 作参考，超过 5 秒的台词在提交 Pika 前提示缩短。H3 Flex 用音频参考引导口型、节奏和音色，最终音轨由 Pika 生成。FFmpeg 只转码和裁切输出，保留生成的对白和环境声。

创建或编辑角色时，可以填入已经注册的 ICL 2.0 音色 ID。留空时使用 Pika 原生配音，绑定音色后有台词才合成语音。角色入镜需要设定图。只拍主体时，如果有固定音色的画外介绍，保留 Pika 环境音并在本地混入合成的台词。鳄鱼爸爸预设为 `S_eH42pcGL1`。

Pika 480p 参考图生视频按 USD 0.03／输出秒估算，主体文生视频按 USD 0.01／输出秒估算。工具和会话费用明细按美元单列估价及回执中的实付。账单暂未结算时保留任务 ID 和估价。这个价格覆盖 Pika，固定音色 TTS 另按供应商账单计。

[H3 Flex 参考视频接口](https://dev.pika.art/models/pika/pika-h3-flex/reference-to-video) · [Pika 价格](https://dev.pika.art/models/pika/pika-h3-flex/reference-to-video/pricing) · [火山 ICL 2.0 接口](https://docs.volcengine.com/docs/doubao-voice/http-chunked-sse-unidirectional-streaming-v3?lang=zh)

## 本地启动

在免登录、仅监听 `127.0.0.1` 的浏览器工作区，设置 `CHAT_SERVICE_CLAN_TOKEN_FILE` 为本机 Service Clan 的 `.local/access-token` 绝对路径，设置 `CHAT_CHARACTER_MEDIA_DIR` 为专用本地媒体目录。照片需要 Service Clan 中的 `gpu-qwen-image-21-app-production` 和对应的 `QWEN_APP_API_TOKEN`。视频需要 `pika-h3-flex` 和 PATH 中的 FFmpeg。固定音色的有声视频另需 `volc-icl20-sse`。设定图来自应用内已登记的角色素材，SVG 需要同名 PNG 参考图。影像文件保存在媒体目录，浏览器聊天快照只保存引用。若 Node 启用了环境代理，确保 `localhost,127.0.0.1` 绕过代理。
