# DeepSeek Jev

English | [简体中文](README.zh-CN.md)

**Modular Jev-powered judgment plugins for DeepSeek Harness.**

Connect [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) to Jev for skill and file selection, task supervision, shared-finding corrections, and single-operation approval assistance. Keep your main agent and native tools; enable only the judgments you want from one settings page.

This is an independent community project, not an official DeepSeek or Jev release. It is an early-stage plugin tested with **DSH 0.1.7-rc.2**; its APIs and model judgments are not a correctness guarantee.

## What is included?

The following features are in `main`. **Every feature is independently disabled by default.** Installing the package does not enable them.

| Feature | What it does |
| --- | --- |
| Skill selection | Ranks skill names and summaries before catalog publication. The main agent still loads the original skill. |
| File ranking | Ranks the original `glob` path results without another filesystem scan or file-content read. |
| Drift reminders | Checks progress between model steps and can deliver one nonblocking reminder. |
| Completion checks | Reviews the visible final answer against recorded evidence and can request at most one supplemental attempt. |
| Goal supervision | Checks native goal completion and pauses after a configurable run of rounds without progress. |
| Instruction guidance | Reads current user instructions and applicable agent rules, then supplies a nonblocking reminder when needed. |
| Interjection routing | Routes a running user's correction to the next step; queues other messages for a later turn. |
| Shared-finding corrections | Compares reports and messages already shared, then sends corrections to affected recipients. |
| Workspace approval | In `workspace-write`, can answer eligible native single-operation escalation requests; non-affirmative answers return to human approval. |

All features share a connection, profile-scoped settings, decision records, and operation receipts. Most agent-facing features target live Web root sessions; correcting a child agent does not enable every feature inside that child.

**Feature branches are not all included in `main`.** Tool-output filtering is on `codex/jev-tool-output-admission`. Native web execution is on `codex/jev-native-web-execution` and is **paused; ordinary-site effectiveness has not passed acceptance**. Historical split branches preserve earlier work. See [branch status](docs/branches.md) before switching branches; this table always describes `main`.

## Requirements

- Node.js **24.11 or later** is recommended; the publication build is checked on Node 24.14.1.
- pnpm **11.7.0** available on `PATH`.
- DeepSeek Harness CLI **0.1.7-rc.2**. The plugin pins the corresponding DSH peers and Cordis **4.0.4**; newer versions are not automatically supported.
- A configured main-model provider in DSH, plus your own Jev-compatible System One endpoint and credentials.

If needed, install the tools:

```sh
npm install --global pnpm@11.7.0 @deepseek-ai/dsh@0.1.7-rc.2
```

## Install from source

The source repository is public; **`@dsh-jev/plugin` is not being published to npm as part of this release**. Build the package from this repository and install its tarball using DSH's plugin manager.

```sh
git clone https://github.com/luobosibing2/deepseek-jev.git
cd deepseek-jev
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
mkdir -p dist
pnpm --filter @dsh-jev/plugin pack --pack-destination "$PWD/dist"
```

Use a **new, unused profile name** for a first trial; the example uses `jev`. Initialize it from the Web template before adding the plugin:

```sh
dsh --profile jev --from-default-profile web --dump-default-config > /dev/null
dsh plugin --profile jev add ./dist/dsh-jev-plugin-0.1.0.tgz
dsh --profile jev
```

The first command creates the Web profile without launching it. Adding a plugin to a brand-new profile without this step initializes only the base configuration, not the Web application. The plugin's bundle patch is applied by the official installer; no manual host-source changes are needed.

Open the authenticated Web address printed by DSH. Configure your main model through DSH, then open the plugin's **Jev** page.

## Configure Jev

1. Set the full System One endpoint, for example `https://api.typesafe.ai/v1/systemone`.
2. Set the model, for example `jev-latest`.
3. Choose a DSH credential reference, save the connection, and save your API key using the page's credential control. Do not put a key in source files or a repository URL.
4. Review the timeout, then enable only the features you need.
5. Inspect **Decision records** for input, answers, attempts, and actual adoption or execution receipts.

The main agent's provider and the Jev judgment connection are separate. A credential marked “configured” is not a successful connectivity test. Connection tests and enabled judgments make requests to your provider.

Selection defaults are 5 skill summaries, at most 40 glob matches eligible for ranking, and 12 displayed ranked paths. A larger glob skips Jev rather than silently judging only the first 40. Supervision defaults are a drift check every 6 completed model steps and a pause after 3 native goal rounds without progress. These values can be changed without enabling the features.

## Behavior and limitations

- **Reminders are advisory.** Drift and instruction guidance do not block or cancel tools, and do not force the main model to comply.
- **Completion is evidence review.** It does not run independent verification. A real test accepted an unsupported “no new files” claim; do not use it as a proof of completion.
- **Approvals remain single-operation.** Workspace approval neither changes the session's sandbox mode nor overrides fixed host checks. `approve` can supply `allowed-once`; `unauthorized` or `unknown` returns to the original human approval flow. Technical failures retain manual Retry/Cancel.
- **Shared corrections have a limited scope.** They process already-shared reports and messages, not every agent's private exploration. Automatic delivery targets the live root agent and its active, continuable direct children. Duplicate corrections can still arise when the same finding appears in different report forms.
- **Judgment success is not action success.** The ledger distinguishes an answer, its adoption, permission issuance, and execution results.
- **Validation is scoped.** Deterministic tests establish integration. Limited real-service examples do not establish general semantic accuracy. See [validation notes](docs/validation.md).

Enabled features send the relevant task context or operation data to the configured judgment endpoint. Exact judgment inputs and answers are stored in the profile's local plugin records; model-visible effects use normal DSH session records. Keep runtime records and credentials private. Public source history excludes personal QA screenshots and raw session captures.

## Updating or removing the plugin

For an existing profile, rebuild and pack, then install the new tarball with `dsh plugin --profile jev add <new-tarball-path>` and restart that profile. Do not rerun `--from-default-profile` on an existing profile. Use a new tarball filename for a changed build of the same package version and check the installed contents when validating an update.

Disable individual features in the Jev page. For package removal, consult `dsh plugin --help` for the CLI version you have installed. Removing or switching the package can remove branch-specific features; keep a profile backup before replacing an experimental branch build.

## Development

```sh
pnpm run typecheck
pnpm run build
pnpm exec vitest run packages/jev/tests/host.test.ts packages/jev/tests/wire.test.ts
```

Run the focused tests for the feature you change. Do not enable real-provider experiments or use someone else's credentials without explicit authorization. Development fixtures and tests are excluded from the installable tarball.

- [Package reference and consumer API](packages/jev/README.md)
- [Workspace-approval integration tests](packages/jev/tests/workspace-approval.test.ts)
- [Workspace-approval QA cases](packages/jev/tests/workspace-approval-qa.md)
- [Branch status](docs/branches.md)
- [Validation notes](docs/validation.md)

## License and acknowledgements

MIT; see [LICENSE](LICENSE). Package-level third-party licenses are included in [THIRD_PARTY_NOTICES.md](packages/jev/THIRD_PARTY_NOTICES.md).

The feature research was inspired by [Mu](https://github.com/qybaihe/mu). This project implements DSH plugins against public extension points; it does not ship a modified DeepSeek Harness, Mu, or Cua runtime. DeepSeek Harness, its Typert tooling, and Zod retain their respective notices.
