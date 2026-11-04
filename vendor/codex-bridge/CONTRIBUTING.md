# Contributing

[简体中文](CONTRIBUTING.zh-CN.md)

Use Node.js 22+ and `npm ci`. Keep changes focused and include a reproducible description of the behavior being changed.

## Test-driven workflow

1. Write a failing behavioral test for a feature or regression. Verify that it fails for the intended reason.
2. Implement the smallest coherent change. Prefer explicit boundaries and dependency injection to global state.
3. Refactor with tests green. Update English and Chinese documentation together.
4. Run `npm run schema` after changing the API, then `npm run format` and `npm run check`.
5. Review `npm run test:coverage` for meaningful gaps. Coverage percentage does not replace assertions about delivery, errors and side effects.
6. Run `npm pack --dry-run` before proposing packaging changes.

Tests use Node's built-in runner, fake RPC boundaries, real local HTTP/WebSocket peers, and a complete SDK-to-peer integration. Do not require credentials, call a model, or send messages into a developer's live session. Regression tests should verify observable behavior rather than mirror private implementation details.

`npm run smoke:readonly` is optional and requires a running compatible Codex instance. It reads only and prints counts. Set `CODEX_BRIDGE_SOCKET` to choose a socket. Keep this out of ordinary CI.

`npm run smoke:live -- --session <idle-root-thread-UUID>` is a separate opt-in integration probe that **does call the configured model and append a test exchange**. Use it only on a session the user has authorized for testing. It never picks a target automatically. Optional `--report <path>` writes a private JSON report; do not commit reports containing real thread IDs or names.

For full API acceptance without touching work sessions, use `npm run smoke:isolated -- --run`. It creates and owns all test threads, enforces a write-target allowlist, configures stricter permissions only on its fixture threads, and archives/unloads them afterward. The sole approved command is an exact fixed-marker print, verified by a separately unit-tested allowlist. Never weaken that guard to make a failing probe pass; fix an incorrect fixture assumption or the product, preserve failed reports, and verify postconditions. See [verification](docs/VERIFICATION.md).

## Contract and safety requirements

- Maintain the distinction between stored history, loaded threads and subscribed connections.
- Never introduce implicit resume, approval, credential logging or mutation retries.
- Preserve structured upstream errors and signal uncertain deliveries/event gaps honestly.
- Keep buffers bounded and perform validation before RPC calls.
- Runtime routes and checked-in OpenAPI must match; a test enforces this.
- Document compatibility evidence separately from simulated behavior.
- Use strict types; use `unknown` and validate it at external boundaries instead of `any`.

CI checks formatting, strict TypeScript, tests and package contents on Node 22 and 24, on Linux and macOS. A PR should state the trigger, changed behavior, validation and compatibility impact. Do not include tokens or real transcripts. Contributions use the repository's MIT license.

## Releases

There is no automatic publishing workflow. Before a manual release, review the API diff, update the version and bilingual changelog, run all checks, verify the tarball, and validate supported Codex versions. Package installation does not install or launch Codex. Keep release claims limited to environments actually tested.
