# Security / 安全说明

## English

This is a local, single-user adapter. The CLI listens only on `127.0.0.1`; one bearer token grants access to all exposed operations in the selected Codex backend. It is not a multi-tenant authorization service. The exported server factory must also be bound to loopback by its host application.

Token files are created with mode `0600`; the token value is never logged. CORS denies browser origins by default. Allow only specific trusted origins. A source label in a message is user-provided text, not proof of identity. Do not embed tokens in shipped browser code, URLs, issues, screenshots or logs. HTTPS and remote deployment are not provided.

Session contents, commands and approval parameters are sensitive. The bridge keeps bounded event/request data in memory and exposes them only through authenticated routes. Existing Codex approval/sandbox configuration remains authoritative; requests are never automatically approved. The bridge is not a sandbox for untrusted applications that have its token.

To rotate credentials, stop the bridge, replace its private token file (or environment override), and restart; update trusted clients. Do not delete Codex's own credentials or socket as part of rotation.

For vulnerabilities, use the repository's private GitHub vulnerability reporting feature if available. If unavailable, open an issue asking for a private contact **without exploit details or secrets**. This initial project has no response-time guarantee.

## 中文

这是本地单用户适配层。CLI 仅监听 `127.0.0.1`，一个 Bearer token 可调用所选后端的全部已暴露能力，不提供多租户授权。嵌入使用导出的 server factory 时，宿主应用也应绑定 loopback。

token 文件以 `0600` 创建，不打印 token 内容。默认拒绝浏览器来源，只应显式允许可信来源。消息中的 source 是调用方声明的文本，不代表身份认证。不要将 token 放进公开浏览器代码、URL、issue、截图或日志。本项目不提供 HTTPS 或远程部署。

会话内容、命令和审批参数属于敏感数据。Bridge 在内存中有界保存事件/请求，仅通过鉴权接口暴露。Codex 现有审批和沙箱配置保持有效，不会自动批准请求。持有 token 的应用应当可信，Bridge 不是它们的沙箱。

轮换凭证时，停止 Bridge，替换其私有 token 文件或环境变量，再启动并更新可信客户端。不要为轮换而删除 Codex 自身凭证或 socket。

漏洞请优先通过仓库的 GitHub 私密漏洞报告功能提交；如果该功能不可用，可开 issue 请求私密联系方式，但**不要附带利用细节或秘密**。项目初期不承诺响应时限。
