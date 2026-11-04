# Contributing

[简体中文](CONTRIBUTING.zh-CN.md)

Use Node 22.13 or newer. Run `npm ci`, then `npm run check`. The check includes `test:coverage`, with minimum aggregate coverage of 90% lines, 80% branches and 85% functions for compiled HarnessHub code, plus the separate original bridge suite. Coverage is a regression guard, not evidence of live compatibility. After editing the API schema, run `npm run schema`; the contract test detects stale generated output. Run `npm run format` before submitting changes.

Write a failing behavioral test for a new transport contract or bug before implementing the fix. Prefer checks for idempotency, permissions, identity, delivery uncertainty and cleanup over tests that merely restate implementation. Adapter capabilities must reflect the actual instance/session. Unsupported operations must fail explicitly; never substitute user input, silently resume a session, or approve a tool to simulate compatibility.

Native protocol changes require an opt-in isolated smoke run and updated verification documentation. Only new allowlisted sessions may be mutated. Do not use working sessions as test fixtures. Keep reports, tokens and private transcripts outside version control. Unit tests and CI must work without credentials or a live harness.

`vendor/codex-bridge` is an unmodified snapshot identified in `NOTICE`. Keep new integration code under `src/`; update the snapshot only as an explicit dependency change with provenance and regression checks. Keep English and Chinese user-facing documentation aligned. A PR should state the concrete behavior, relevant test results and remaining limitations.
