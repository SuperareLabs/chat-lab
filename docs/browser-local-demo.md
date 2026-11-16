# 浏览器本地公开体验架构

版本：应用1.2.0，封版分支 `version1.2.0`，标签 `v1.2.0`。源码已固定，公网地址尚未配置。

## 请求与持久化

浏览器保存一个IndexedDB工作区：固定JSON数据快照、界面读取缓存、当前选择、首次引导状态、草稿和各标签页的未完成发送。默认配置提供8个公开角色和22岁的“访客”测试资料。自建角色、资料、历史与记忆仅属于该浏览器。旧版初始访客仅在年龄为空、其余基础字段未改动时更新为22岁；已有明确年龄及自建资料保留，历史与记忆不重置。

服务启动公开模式时不构造全局ChatStore/ChatRuntime，不打开CHAT_DB_PATH。`/api/local`收到认证请求后，严格校验固定表、列、类型、引用、路径及大小，在`:memory:`中导入本次快照，通过原ChatRuntime执行操作；等待后台任务结束，再导出快照并释放运行器。没有服务器用户工作区文件或访客日志。公共角色库单独使用 `CHAT_CATALOG_PATH` 持久保存公开设定与管理凭证哈希，不存访客聊天或记忆；创建、编辑、下架及同步见[公共角色库](public-role-library.md)。

GET由本地views缓存命中，避免每2.6秒发送全工作区；写入、模型调用、按需详情与到期整理才请求后台。当前实现发送完整工作区快照，是后续可以进一步缩小的网络开销；不能描述为所有资料永不离开设备。

## 接口

- `GET /api/auth/session`：进入状态和storageMode，不返回口令。
- `POST /api/auth/login`：`{password}`；服务器校验后发HttpOnly/SameSite Cookie。
- `POST /api/auth/logout`：撤销凭证，浏览器资料保留。
- `POST /api/local`：`{method,path,body?,snapshot?,scope?}`。返回`{status,value,snapshot,views,nextDeadline,invalidates?}`。
- 聊天同样走`/api/local`，保持原SSE消息事件，最后增加workspace事件。客户端只有保存最终快照后才将本次当作完成。
- 内部业务路径只接受白名单；公开模式不会回落到旧`/api/state`、`/api/memory`等全局接口。没登录时这些API全部401，登录后旧入口404。

`scope`只是界面缓存偏好，不能覆盖业务body/query。冲突在读写前拒绝；不能把B范围的数据缓存到A地址，清空也不能删错范围。

## 并发与失败

服务同时最多4个工作区请求。每请求最多处理1条记忆任务，优先当前范围，否则全工作区最早queued；保留正常提取及原有一次修正，其余queued由浏览器deadline逐条补处理。未配置记忆模型、失败或中止不自动形成付费重试循环。

同源标签页用IndexedDB事务租约、心跳和revision CAS，旧响应不能覆盖新记录。当前浏览器操作排队；请求捕获发起时的scope。消息发送前保存草稿/outbox，流中保存已收到内容；断网没有最终workspace时提供恢复流程，绝不自动重发。首次bootstrap尚未保存就中断，也能在加载数据前进入恢复卡。

## 清空记忆

默认只处理当前用户与角色。删除学习画像、概括、记忆状态、提及和旧整理输入，封存相关旧session/job/context；历史消息和基础资料仍在，其他范围保留。界面确认后打开新会话，避免继续使用旧上下文。再次空闲、重试旧任务或其他标签页旧响应都不能把已清记忆写回。

## 入口与部署

口令从CHAT_ACCESS_PASSWORD读取，没有默认生产口令，也不写入前端。进入凭证是服务器RAM中的随机opaque token索引，退出与过期会失效，服务器重启需重新输入口令；它不承载用户工作区数据。

先按README从version1.2.0分支获取代码，在服务器自己的`.env`或环境中填写口令与模型Key。仓库只保留占位示例，真实值不随源码发布。反代部署建议Node只监听`CHAT_HOST=127.0.0.1`，由HTTPS代理对外提供入口。

公网域名须明确配置CHAT_PUBLIC_ORIGIN。HTTPS反代应保留外部Host，不靠任意X-Forwarded-Host或Proto推断信任。示例（将域名替换成实际值）：

```nginx
location / {
  client_max_body_size 17m;
  proxy_pass http://127.0.0.1:4333;
  proxy_set_header Host $host;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_request_buffering off;
  proxy_read_timeout 300s;
}
```

还需在代理的HTTPS站点配置证书；本例只是location内容。17m用于容纳16 MiB快照及请求封装。`proxy_request_buffering off`关闭代理请求体缓冲；`proxy_buffering off`关闭SSE响应缓冲。代理/CDN的请求日志、缓存和临时文件策略需另外核对，不能把应用自身不落盘理解为所有代理都不会留存。Shared gate不提供独立账户、跨设备同步或逐账户配额。登录失败按连接IP限流，同机代理可能使限流影响所有新登录，应在正式部署时一起核对。

公开模式不依赖原本data/chat.sqlite，发布也不得复制它。不要把开发目录中未跟踪的private voice资源一并打包。共享角色库由config/default-agents.json版本管理，个人编辑保存在本地快照。

## 默认角色的小版本更新

公开默认角色带定义hash。已有本地快照只有在角色ID、名称和原始定义都符合已知默认版本时才升级；自行改过的文本和自建角色不会被覆盖。升级只变角色定义/修订号及catalog标记，不改历史消息、画像、记忆或用量。首次进入强制检查一次，后续普通GET仍用本地缓存。周屿头像兼容旧快照的默认空头像，已有自定义图片优先保留。

## 验证依据

自动测试使用mock provider，不调用真实模型。覆盖密码/会话/退出、Host与Origin、无持久DB、双快照隔离、SSE最终保存、15分钟整理、单任务限额、归档回忆、清空和晚到响应、首次恢复与草稿。浏览器实测覆盖入口、四步引导、8角色、新建资料/角色、模拟聊天/记忆、刷新恢复、清记忆取消/确认、退出重入、多标签和不同origin独立存储。窄窗口仅有CSS适配，尚未单独完成人工尺寸验收。

实现参考：[Node crypto](https://nodejs.org/api/crypto.html)、[MDN Cookie属性](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie)、[MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)、[Nginx请求体缓冲](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_request_buffering)、[Nginx请求大小](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size)。文档描述的是应用自身的数据存储；模型提供商的处理政策单独适用。
