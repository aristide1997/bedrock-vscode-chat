# Changelog

All notable changes to the AWS Bedrock Provider for GitHub Copilot Chat extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Fixed

- **Every request was capped at one output token unless Copilot supplied its own limit.** `maxOutputTokens` defaults to `0`, documented as "use the model's maximum", but the request builder selected it with `?? modelCeiling` — and `??` does not treat `0` as absent. The documented default therefore won the precedence chain and produced `maxTokens: 1`. On a default install this reintroduced the truncation behaviour of #25 in a more extreme form, and it made extended thinking fail outright with `` `max_tokens` must be greater than `thinking.budget_tokens` ``, because no reasoning budget can fit below Anthropic's 1024-token floor. The `0` sentinel is now converted to `undefined` in `ConfigurationService` so it cannot leak into a `??` chain again, and resolution happens in one tested function.
- **Extended thinking could be sent with an output limit too small to hold its own budget.** The thinking budget was only ever clamped *downward* to fit `maxTokens`, which is impossible below the 1024-token floor, so a small limit produced an invalid pair rather than a smaller budget. The budget is now fitted under whatever limit was settled on while always clearing Anthropic's floor and leaving a usable answer allowance, and a limit that cannot house any budget at all drops thinking for that turn rather than sending a request Bedrock would reject.
- **The adaptive thinking API needed the opposite fix, and still failed after the first one.** On Claude 4.6+ the request carries only `output_config.effort` and the service derives the budget from it, so there is no budget field to shrink — a `max_tokens` smaller than the derived budget cannot be reconciled by trimming anything. Copilot supplies its own small `max_tokens` for utility calls (chat titles, summaries), so with `thinking.effort` set to `high` an ordinary session still produced `` `max_tokens` must be greater than `thinking.budget_tokens` `` on Claude Opus 5 even with `maxOutputTokens` at `0`. The effort level itself is now reduced to the highest one whose budget fits, never above what was requested, and thinking is dropped only when even `low` cannot fit. Reductions are logged, shown in the diagnostics report, and previewed in the effort quick pick.
- **Output-limit and reasoning-budget conflicts now fail before the request, with the remedy.** An explicit limit too small for the chosen effort is reported up front naming the setting and the fix, rather than reaching Bedrock and coming back as a message about wire fields that match no setting in this extension. Recognized Bedrock validation errors are translated the same way as a safety net, and both offer **Open Setting** and **Change Thinking Effort** actions. An explicit limit is never silently overridden — thinking is dropped for that turn instead, and the reason is logged.
- **The tool-call truncation message told users to raise `maxOutputTokens` even when it was already at the model maximum.** It now names the correct remedy for whichever input actually set the limit.

- **`Invalid JSON for tool call`, which stopped agent turns mid-task** (#25). This was several independent defects, not one:
  - **Output-token ceiling defaulted to 4096.** Copilot does not send `max_tokens`, so every response was capped at 4096 output tokens no matter what the model allowed. A whole-file edit call exceeds that easily, Bedrock stops mid-string with `stopReason: max_tokens`, and the half-written JSON never parses. Requests now default to the model's own ceiling, and the per-model fallback is version-aware instead of a flat 4096.
  - **Stream state was shared across concurrent requests.** One tool-argument buffer lived on the request handler and was reset at the start of every stream, so a second concurrent request wiped the arguments the first was still accumulating. That is what produced the reported error with an empty `snippet`. Buffers are now created per response.
  - **Zero-parameter tool calls were treated as failures.** A tool whose schema declares no parameters emits no argument deltas at all; the empty buffer is now emitted as `{}`.
  - **The same failure was logged twice.** Force-emitting is now terminal, so `contentBlockStop` followed by `messageStop` reports once.
  - **Legitimate repeat tool calls were dropped.** Deduplication keyed on the arguments, so a model asking to read the same file twice in one turn lost the second call. It now keys on `toolUseId`.
  - **Object-valued argument deltas became `[object Object]`.** Bedrock documents `delta.toolUse.input` as a string, but some model families return a parsed object; those are now serialized.
  - **Failures were silent.** A dropped tool call now raises a visible error naming the tool, and says which setting to raise when the output cap was the cause. Truncated arguments are deliberately never repaired, because applying half of a file-edit call would corrupt the file.
- **Text was discarded when it shared a message with tool results** (#25). Both are now sent.
- **Mid-stream Bedrock faults ended turns quietly.** Bedrock reports throttling, validation and internal errors as stream *events* rather than throwing; those are now surfaced. Conversely, a single malformed event no longer abandons the rest of the response.
- **Mismatched `tool_use` / `tool_result` pairs caused opaque 400s.** Orphan and duplicate tool results are dropped, and unanswered tool calls get a synthetic error result, so the model learns its tool did not run instead of the request failing with no detail.
- **Cancelling a request left the HTTP connection open.** Cancellation is now bridged to the AWS SDK through an abort signal.
- **Context-window display read near-empty during tool-heavy sessions** (#22). The token estimator counted only text parts; it now counts tool calls, tool results, images and binary content, with per-message overhead.

### Added

- **Token usage, context size and latency reporting** (#22). Bedrock returns all of it on the stream's `metadata` event, which the provider previously ignored. Each turn now logs input/output/total tokens, cache reads and writes, context-window percentage, latency, stop reason and tool-call count to the **Bedrock Chat** output channel, with running session totals, plus warnings when the context passes 90% full or when caching produced no activity. Note the ceiling on this: the finalized provider API gives a provider no channel for feeding usage into Copilot's own Agent debug log.
- **Prompt caching** (#19), on by default and toggleable via `promptCaching.enabled`. Checkpoints are placed on tool schemas, the system prompt and the trailing pair of user messages, so each turn reads back the checkpoint the previous turn wrote. Capped at Anthropic's four, gated on a fail-closed model capability check, and skipped entirely below the minimum cacheable prompt size.
- **Extended thinking**, off by default, with `thinking.enabled`, `thinking.effort` (`low`/`medium`/`high`/`xhigh`), `thinking.budgetTokens` and `thinking.display` (`native`/`text`/`hidden`). The right API is chosen per model: the adaptive effort API for Claude 4.6 and newer, the token-budget API for 3.7 through 4.5, and nothing for older models. Enabling it suppresses `temperature` and `topP` and relaxes a forced tool choice, as Anthropic requires. Signed reasoning is replayed verbatim on the follow-up tool-result turn, keyed by tool-use ID so concurrent requests cannot cross-contaminate. Native rendering is feature-detected at runtime rather than declared as a proposed API, since the Marketplace rejects builds that declare one.
- **Two ways to change reasoning effort without opening settings.** A status bar item (`Bedrock: think high`) opens a quick pick for the global default, writing the same settings the settings editor shows rather than keeping a second copy of the state. And with `thinking.showEffortVariants` on, each reasoning-capable model appears in the chat model picker once per effort level — because VS Code remembers the model per conversation, that makes effort per-conversation, which no provider API otherwise allows. A variant picked in the chat window wins; everything else falls back to the status bar default. Variants are off by default, since they multiply the length of the picker, and models with no reasoning mode are never expanded. Effort levels are encoded into the model ID and decoded before use, so the wire request, capability detection and inference-profile routing all still see the real Bedrock ID; an unrecognized suffix degrades to the base model rather than failing the request.
- **A `· think off` entry in the model picker**, the only way to disable reasoning for a single conversation. Every effort variant necessarily turns reasoning *on*, and the plain entry inherits the global default, so before this the picker could raise reasoning but never suppress it — turning it off for one chat meant changing the global setting and remembering to change it back. Listed first, ahead of the effort levels, mirroring the status bar quick pick and putting the cheapest choice closest to hand. Shown only while `thinking.enabled` is on, because with the default already off the plain entry does the same thing and offering both would imply a distinction that does not exist; the model list refreshes when that setting changes so the row appears and disappears immediately. `off` is deliberately not a member of the effort list — it is the absence of a level rather than a level of its own, and admitting it there would put it in every budget table and settings enum that iterates over efforts.
- **Native token counting** via Bedrock's `CountTokens` API, on by default and toggleable via `nativeTokenCounting`, replacing the character heuristic for the pre-flight context check. A model that permanently rejects the call is remembered, so it is not re-probed every turn; transient faults such as throttling are not held against it.
- **`maxOutputTokens` setting** to cap output tokens per response. `0` means the model's maximum.
- **Manual model declarations** (#23) for environments where model listing is blocked by a Service Control Policy but invocation is allowed.
- **`AWS Bedrock: Show Effective Configuration`**, a command that opens a paste-ready Markdown report of the *resolved* configuration: region, whether authentication actually resolved, the token-limit and reasoning settings, and a per-model table of context window, output ceiling, where that ceiling came from, the max tokens a request would really send, and the reasoning budget. Diagnosing the one-token regression required cross-referencing three log sections and knowing that `0` was a sentinel; this puts the interacting values in one place. Deliberately carries no credentials, so it is always safe to attach to a bug report.
- **The effort quick pick now says whether each level will actually work**, showing its reasoning budget and the output tokens available, marking levels that will be cut short with a warning and levels that cannot run at all with an error. Picking an unusable level is refused with an explanation rather than silently written to settings and failing on the next request. It reuses the same resolution function the request builder does, so its advice cannot drift from what gets sent. A shortcut to the output-limit setting appears only when that setting is what constrains the choice.
- **The status bar item reports the resolved numbers and flags conflicts**, with a warning or error glyph and background when the current effort does not fit the output limit. Its tooltip shows the reasoning budget, the effective output limit and whether that limit came from settings or the model. A setting that cannot work is now visible without hovering.
- **A one-time warning for token limits that are valid but unusable** — an output limit below 1024, a limit too small for the chosen effort, or a reasoning budget that leaves no room to answer. JSON Schema cannot express "`0` or at least 1024", so this is validated at activation and whenever one of those settings changes. Shown once per distinct value: repeating it every session would be noise, but changing the setting to a *different* bad value is a new mistake worth hearing about.
- **Configuration errors now offer the actions that fix them.** Authentication, region and model-access failures previously arrived as bare text, leaving the user to guess which of a dozen settings to search; they now offer **Configure Authentication**, **Show Effective Configuration**, **Show Logs** or the relevant setting, from one shared classifier so every error site behaves consistently.

### Changed

- Connection handling: longer streaming timeouts, keep-alive connection pooling shared per client kind, and the AWS SDK's adaptive retry mode. SDK-level retries were chosen over a hand-rolled retry around the stream, which can duplicate already-emitted output.
- `claude-v2` and `claude-instant` are no longer treated as having a thinking API. Neither carries a parseable version, so the "unrecognized ID, assume current" rule would have sent them a reasoning config that predates them by years and that Bedrock rejects. The two names are closed-ended, so recognizing them costs nothing in future-proofing.
- Cross-region routing prefixes `global.` and `apac.` are now stripped during capability detection. A `global.`-prefixed Claude 4 ID previously fell through to the default profile and sent `temperature`, which Bedrock rejects.
- The per-message request dump in the output channel is now one summary line per direction. A long agent session sends over a hundred messages per turn, and the old dump buried everything worth reading.
- The output-token limit is now logged as its whole resolution chain — which input won, the model ceiling, the reasoning floor and the resulting budget — instead of only the final number. The one-token regression above was invisible for exactly that reason: the log showed the outcome with no indication of which input produced it. A limit set below the model's ceiling, or one raised to accommodate reasoning, is called out explicitly.
- Settings descriptions for `maxOutputTokens`, `thinking.enabled`, `thinking.effort` and `thinking.budgetTokens` now cross-reference each other, state that reasoning tokens are spent out of the output limit, and lead with what `0` means, since that sentinel is the whole trap.
- **A provider-reported output ceiling is now preferred over the built-in table even when it is larger.** The table is deliberately conservative — 32000 for every Claude 4+ model — because a `maxTokens` the model rejects fails the whole request, whereas one that is too small merely truncates. But Claude Opus 5 actually allows 128000, so a user whose network blocks the metadata lookup silently lost three quarters of their output budget with nothing anywhere saying so. The live figure is now used when available, its provenance is recorded per model, and a summary warning names the models that fell back to a built-in default.

### Internal

- 131 offline unit tests, up from 59, covering the tool-buffer fixes, stream results and error handling, cache-point placement, tool-block reconciliation, thinking configuration and display, effort-variant encoding and precedence, usage tracking, token estimation across every part type, and per-model output ceilings. Every file touched is lint-clean.
- Output-limit resolution is now a single pure function (`resolveMaxTokens`) covered by a property-style sweep over every effort level x thinking API x setting value x model ceiling, asserting that the limit always exceeds the reasoning budget and never falls below Anthropic's floor. Both bugs fixed above were single points in that space that every example-based test happened to miss — notably `0`, the shipped default, which was the one value the existing override tests never used. The `ConfigurationService` sentinel handling is asserted directly as well, since the defect lived in the seam between the service and its caller rather than in either one alone.
- The advisory thresholds, effort-availability assessment, ceiling precedence and diagnostics report are all pure functions with their own tests, including one asserting that the quick pick's advice agrees with what the request builder would actually send for the same inputs — a second copy of the precedence logic is exactly how the settings UI would come to disagree with the wire again — and one asserting the report never contains credentials, since its purpose is to be pasted into public issues.
- A new e2e stage exercises the default install state: `maxOutputTokens` at `0` with extended thinking on at `high` effort, which is the configuration that failed in the field. It asserts on the log's own resolution line rather than on reply text, because a one-token cap still produces *a* reply.
- Running the suite under `xvfb` surfaced two dead branches in the resolution function: a "raise the limit to fit the reasoning budget" case and a minimum-limit floor, neither of which can ever execute. When no explicit limit is given the value is already the model ceiling, so there is nothing left to raise it to, and an explicit limit is honoured rather than overridden. Both were removed along with the result fields that reported them, rather than left as untestable state implying behaviour that does not exist.
- The invariant sweep now varies the caller-supplied `max_tokens` as well as the setting. Omitting that dimension is why the adaptive-API failure above survived the first round of fixes: every test drove the *setting*, while the value Copilot actually sends for utility calls was never exercised. The sweep covers 960 combinations in the live harness and 3,240 in the unit tests, and additionally asserts that the effort level sent on the adaptive API always fits the limit and is never raised above the one requested.
- `scripts/live-feature-test.js`, a live end-to-end harness that drives the compiled modules against real Bedrock and asserts on the responses: cache checkpoints reading back across turns, signed reasoning on both thinking APIs, a multi-kilobyte tool call arriving as parseable JSON, an effort variant decoding back to an invocable model ID, mid-stream fault propagation, and usage captured from the metadata event. Verified 22/22 against Claude Haiku 4.5 and Sonnet 4.6 in `us-west-2`.
- `docs/mockups/` records the four UI options considered for where the effort control should live, and why the status bar plus optional picker variants won. `docs/screenshots/` shows what the built version looks like, and supersedes the mockups where the two disagree.
- Packaging hygiene: `docs/` and the dev-only `scripts/` directory are excluded from the VSIX.

## 0.0.6

### Fixed

- **Temperature sent to Claude 5+ models** (#21): Bedrock rejects the `temperature` inference parameter for Claude 4+ models, and version detection only matched literal Claude 4 IDs. Detection now parses the major version (#24, thanks @Josh-Karp) and fails closed: unrecognized Anthropic model IDs omit temperature instead of failing every request (#26).

### Internal

- Modular Playwright e2e harness (`e2e/lib/` + `e2e/stages/`) with a live Claude Sonnet 5 temperature-regression stage and Bedrock-only model-selection guarantees: provider-group row binding grounded in VS Code 1.122.1 source, per-stage log-delta stream proofs, and session-scoped verification (#26).

## 0.0.5

### Added

- **Application inference profile overrides** (#17): configure specific models to route through AWS Bedrock application inference profiles, with region-based profile resolution. Verified end-to-end against a live application inference profile ARN.

### Fixed

- **Image format mismatch errors** (#20): the actual image format is now detected from the file's magic bytes instead of trusting VS Code's reported MIME type, fixing Bedrock API validation failures when the declared format and image data disagree.

### Internal

- Test and tooling hardening: lint out-of-memory fix, extracted a pure `buildRequestInput()`, expanded offline unit tests (provider routing, temperature configuration, stream cancellation, tool limits, auth), and a hardened Playwright end-to-end harness.

## 0.0.4

- Inference profile handling improvements and packaging hygiene.
- Route the AWS SDK through the configured proxy (#8).
- Omit `temperature` for Claude 4.x models (#9).
- End-to-end test harness (Playwright + VS Code Electron).

## 0.0.3

- Remove proposed thinking API, packaging hygiene, and marketplace listing refresh.
- Compatibility with newer VS Code releases (#4).

## 0.0.2

- Additional authentication methods (AWS profile, access keys) and native image support in chat (#1).

## 0.0.1

- Initial release.
