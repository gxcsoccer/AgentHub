# Security boundaries

HarnessHub is a local service for a single OS user. The CLI binds HTTP to loopback, requires a bearer token, rejects unapproved browser origins and never prints generated tokens. Do not expose the service directly to a network. Anyone with the service token can access configured sessions and explicitly answer exposed Codex approval requests; it is not a per-agent authorization system.

The MCP facade intentionally omits approval, resume and interrupt tools. Its origin name is configured by the owner, but is descriptive metadata, not a cryptographic identity. HTTP credentials are service-wide. Use separately scoped instances or a future policy layer when callers should have different access.

Claude inbox and callback sockets trust the same OS user. Socket ownership/mode and correlation checks prevent accidental cross-session delivery; the callback does not authenticate a kernel peer PID and does not protect against a malicious process running as that user. Messages stay in prompting mode and never impersonate autonomous user approval. The installed CLI version is checked, not each running process version.

Receipts are bounded and optionally persisted; event replay is bounded and persists when SQLite is configured. Disconnects and uncertain writes must not trigger automatic replay. Native transcripts and local smoke reports can contain private data; do not include them in public issues. Report a vulnerability privately to the repository maintainer before publishing reproduction details. No dedicated security inbox is currently configured.

中文：本服务以同一操作系统用户为信任边界。持有服务令牌的调用方可以访问已配置实例，并显式回答暴露的 Codex 审批；它不是按 agent 隔离权限的系统。MCP 不开放审批/恢复/中断。Claude 回调不认证内核 peer PID，不能抵御同一用户下的恶意进程。请勿将服务直接暴露到网络，也不要公开令牌、原生日志或真实测试报告。安全问题请先私下联系仓库维护者。

Durable state stores plaintext message/reply content, payload hashes and local routing metadata. Keep its directory mode 0700 and state/lock files 0600; do not publish or copy a live database. Only one owner can open it. State write failures fail closed. Reusing a Claude callback path requires the saved inode and an inactive endpoint; it does not establish a stronger peer identity. The owner attachment endpoint is available to the same service-wide bearer credential, requires explicit resume-race acknowledgment, and is omitted from MCP. It does not provide agent-specific authorization.

持久状态包含明文消息与回复、载荷哈希和本地路由信息，目录要求 0700，状态/锁文件为 0600；不要公开或复制运行中的数据库。Claude 回调复用不会增强身份认证。显式 attach 使用相同的服务级令牌权限并要求接受 resume 竞态，不构成按 agent 隔离的授权。

Per-caller grants protect instance/session reads, sends, receipt events, explicit attachment, approvals and managed user prompts. In-process library callers are trusted by default. ACP commands run with their owner-configured environment and native permissions; the protocol is not a sandbox. Windows named-pipe auth tokens are secrets, and native Windows delivery remains experimental with no receipt or reply confirmation. See [extensions](docs/EXTENSIONS.md).
