# 角色照片与短视频

角色可在聊天中分享自己的生活场景。聊天模型只填写可见场景和动作，服务端固定参考图、构图、风格与时长。每轮最多生成一份影像，普通聊天照常返回文字。聊天里会显示生成标记。

## 千问生活照

取当前角色设定图作为身份参考，保留脸部、发型、年龄和辨识特征，将参考里的插画材质转成真实摄影。输出固定为 768×1024 的竖幅前置手机随拍，手持微倾、轻微偏心，画面保留上半身、正在做的事和周围环境。用场景真实光源、自然明暗过渡和暗部细噪点，保留实际肤质和物件纹理。每次只替换地点、可见物和人物当下姿势。关闭自动扩写，保持模板可控。

同一个模板也生成视频首帧，尺寸改为 576×1024，与 9:16 视频对齐。使用本地部署的 `qwen-image-2.1` 参考图模式。

[Qwen Image 2.1 参考图改写指南](https://github.com/QwenLM/Qwen-Image-2.1/blob/main/prompt_rewrite/prompts/system_prompt_edit.txt) · [阿里云图像编辑指南](https://www.alibabacloud.com/help/en/model-studio/qwen-image-edit-guide)

## H3 Flex 生活短视频

先把千问生成的前置自拍首帧上传到 Pika，通过 H3 Flex 图生视频接口将它传入 `image` 字段。固定 9:16 和 480p，角色像拿着手机给对方发视频，首帧保留上半身和场景。视频是连续单镜头，允许轻微的手腕晃动、自然倾斜、光影和曝光变化，暗部保留细微的手机传感器噪点。角色在半秒内进入动作，Agent 根据动作选 3、4 或 5 秒，保留最短合适节奏。关闭提示词改写，FFmpeg 按所选时长裁切，以处理原生输出向帧网格取整。

[H3 Flex 图生视频合同](https://dev.pika.art/models/pika/pika-h3-flex/image-to-video)

## 本地启动

在免登录、仅监听 `127.0.0.1` 的浏览器工作区，设置 `CHAT_SERVICE_CLAN_TOKEN_FILE` 为本机 Service Clan 的 `.local/access-token` 绝对路径，设置 `CHAT_CHARACTER_MEDIA_DIR` 为专用本地媒体目录。照片需要 Service Clan 中的 `gpu-qwen-image-21`。视频另需 `pika-h3-flex` 和 PATH 中的 FFmpeg。设定图来自应用内已登记的角色素材；SVG 需要同名 PNG 参考图。影像文件保存在媒体目录，浏览器聊天快照只保存引用。若 Node 启用了环境代理，确保 `localhost,127.0.0.1` 绕过代理。
