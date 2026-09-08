# AWS Bedrock Provider for GitHub Copilot Chat

Integrates AWS Bedrock foundation models into GitHub Copilot Chat for VS Code.

![Demo](assets/demo.gif)

## Quick Start

1. Install the extension
2. Open Settings (Cmd/Ctrl + ,) and search for "Bedrock"
3. Configure authentication method and AWS region
4. Select a Bedrock model from the model dropdown in GitHub Copilot Chat

## Authentication Methods

Four authentication methods supported:

### 1. AWS Bedrock API Key (Recommended for Quick Start)
Generate a long-term or short-term API key from the [AWS Console](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html):

- **Long-term keys**: Valid for 1-365 days, easy to generate from AWS Console
- **Short-term keys**: Valid for up to 12 hours, generated via Console or Python package
- Format: `bedrock-api-key-[BASE64]`

Set in Settings → Language Model Chat Provider: Bedrock → API Key

### 2. AWS Profile
Use credentials from `~/.aws/credentials` (supports SSO):

```ini
[default]
aws_access_key_id = YOUR_ACCESS_KEY
aws_secret_access_key = YOUR_SECRET_KEY
```

Set in Settings → Language Model Chat Provider: Bedrock → Profile

### 3. AWS Access Keys
Direct AWS access key ID and secret (supports session tokens):

Set in Settings → Language Model Chat Provider: Bedrock → Access Key ID and Secret Access Key

### 4. Default Credential Provider Chain
Uses AWS SDK's default credential resolution (environment variables, EC2 instance metadata, etc.)

Select "default" in Settings → Language Model Chat Provider: Bedrock → Auth Method

## Features

- Multi-turn conversations
- Streaming responses
- Tool/function calling for compatible models
- Vision/image input for compatible models (Claude, Amazon Nova, Pixtral) — see [Limitations](#limitations)
- Support across AWS regions
- Cross-region inference profiles for optimized model access and routing
- [Extended thinking](#extended-thinking-reasoning) with a configurable effort level or token budget, settable [from the status bar or per conversation](#choosing-an-effort-level)
- [Prompt caching](#prompt-caching) to cut the cost and latency of long sessions
- [Token usage and context-size reporting](#token-usage-and-context-size) in the output channel

## Available Models

The extension exposes every Bedrock foundation model with streaming support — they appear
automatically in the chat model dropdown for your region. A snapshot of what's currently
available includes:

- **Anthropic Claude** — Opus 4.8 / 4.7 / 4.6 / 4.5, Sonnet 4.6 / 4.5 / 4, Haiku 4.5 (all vision-capable)
- **Amazon Nova** — Nova 2 Lite, Nova Pro, Nova Lite, Nova Micro
- **Meta Llama** — Llama 3.2
- **Mistral AI** — Devstral 2, Pixtral Large
- **OpenAI** — gpt-oss-120b / 20b
- **Qwen** — Qwen3 235B, Qwen3-Coder, Qwen3 32B
- And more (MiniMax, NVIDIA Nemotron, GLM, …)

## Configuration

### VS Code Settings

Configure the extension through VS Code settings (Cmd/Ctrl + , then search for "Bedrock"):

- **Region**: AWS region for Bedrock services (default: `us-east-1`)
- **Auth Method**: Choose from `api-key`, `profile`, `access-keys`, or `default`
- **API Key**: Your AWS Bedrock API Key (when using api-key method)
- **Profile**: AWS profile name (when using profile method)
- **Access Key ID / Secret Access Key**: AWS credentials (when using access-keys method)
- **Session Token**: AWS Session Token for temporary credentials (optional, used with access-keys method)
- **Inference Profile Overrides**: Map model IDs to [application inference profile](https://docs.aws.amazon.com/bedrock/latest/userguide/application-inference-profiles.html) ARNs or IDs. Use this to route specific models through your own application inference profiles instead of the default system profiles.
- **Manual Models**: Explicitly declare the models to expose. Primarily for environments where model **listing** is blocked (e.g. a Service Control Policy denies `bedrock:ListFoundationModels`) but **invocation** is allowed. See [Manual Models](#manual-models-for-restricted-environments) below.
- **Max Output Tokens**: Cap on output tokens per response. `0` (the default) uses the model's own maximum. Only lower this if you want shorter answers — a low cap truncates large tool calls mid-JSON. See [Truncated tool calls](#truncated-tool-calls).
- **Prompt Caching: Enabled**: Insert Bedrock prompt-cache checkpoints into requests. Default `true`. See [Prompt caching](#prompt-caching).
- **Thinking: Enabled**: Request extended thinking from models that support it. Default `false`.
- **Thinking: Effort**: `low`, `medium` (default), `high`, or `xhigh`. This is the global default; see [Choosing an effort level](#choosing-an-effort-level).
- **Thinking: Show Effort Variants In Model Picker**: List each reasoning model once per effort level in the chat model picker, so effort can be set per conversation. Default `false`.
- **Thinking: Budget Tokens**: Explicit reasoning budget for models on the older budget-based API. `0` (the default) derives it from the effort level.
- **Thinking: Display**: `native` (default), `text`, or `hidden`. See [Extended thinking](#extended-thinking-reasoning).
- **Native Token Counting**: Ask Bedrock to count input tokens before sending, instead of estimating from character counts. Default `true`. Accurate, but costs one extra API round trip per turn.

#### Setting up Inference Profile Overrides

Application inference profiles let you define custom throughput, routing, and tagging for Bedrock invocations. To route a model through your own profile:

1. [Create an application inference profile](https://docs.aws.amazon.com/bedrock/latest/userguide/application-inference-profiles-create.html) in the AWS Console.
2. Open VS Code Settings (`Ctrl/Cmd + ,`), search for **Bedrock**, and locate **Inference Profile Overrides**.
3. Click **Edit in settings.json** and add a mapping:

```json
"languageModelChatProvider.bedrock.inferenceProfileOverrides": {
    "anthropic.claude-opus-4-8-20250514": "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc123",
    "anthropic.claude-sonnet-4-6": "arn:aws:bedrock:ap-southeast-2:123456789012:application-inference-profile/def456"
}
```

You can use either the full ARN or just the profile ID (e.g., `"abc123"`) — both are accepted.

**Note**: When an override is set, the model still appears under its bare ID in the model picker and capability detection still works against the base model. The override substitution happens only at invocation time.

#### Manual Models (for restricted environments)

Some AWS accounts allow you to **invoke** Bedrock models (`bedrock:Converse` / `bedrock:InvokeModel`) but **deny listing** them (`bedrock:ListFoundationModels`, `bedrock:ListInferenceProfiles`) — commonly via an AWS Organizations **Service Control Policy (SCP)**. Because the model picker is normally built from the listing APIs, the dropdown ends up empty and you see an error like:

```
Failed to fetch Bedrock models: ... not authorized to perform:
bedrock:ListFoundationModels with an explicit deny in a service control policy
```

The **Manual Models** setting works around this by letting you declare the models directly. Behavior:

- If model auto-discovery **fails** and `manualModels` is non-empty, the extension **falls back** to your declared list instead of erroring.
- If discovery **succeeds**, manual entries are **merged** with discovered models (matched by bare model ID; discovered metadata is not overwritten).
- A manual model's `inferenceProfile` behaves like an entry in `inferenceProfileOverrides`, so cross-region invocation works even when `ListInferenceProfiles` is denied.

Example — expose two Claude models by their cross-region (`global.`) profiles:

```json
"languageModelChatProvider.bedrock.manualModels": [
    {
        "id": "anthropic.claude-opus-4-8",
        "name": "Claude Opus 4.8",
        "inferenceProfile": "global.anthropic.claude-opus-4-8",
        "vision": true
    },
    {
        "id": "anthropic.claude-sonnet-5",
        "name": "Claude Sonnet 5",
        "inferenceProfile": "global.anthropic.claude-sonnet-5"
    }
]
```

Fields: `id` (required, bare model ID); `name` (display name, defaults to `id`); `inferenceProfile` (profile ID/ARN to invoke instead of the bare ID — most cross-region models need this); `vision` (accepts image input, default `false`); `maxInputTokens` / `maxOutputTokens` (optional overrides, useful when OpenRouter metadata is unreachable on a locked-down network).

> **Tip:** verify a model ID is invocable before adding it, e.g.
> `aws bedrock-runtime converse --model-id "global.anthropic.claude-opus-4-8" --messages '[{"role":"user","content":[{"text":"hi"}]}]' --inference-config '{"maxTokens":10}'`

### Extended thinking (reasoning)

Turn on **Thinking: Enabled** to have reasoning-capable Claude models think before they answer. The extension picks the right API for the model automatically:

- **Claude 4.6 and newer** get the adaptive API: they choose their own budget from the **Thinking: Effort** level you set.
- **Claude 3.7 through 4.5** get the older budget API. The budget comes from the effort level, or from **Thinking: Budget Tokens** if you set it, and is always clamped to leave room for the visible answer.
- **Older models** ignore the setting entirely rather than failing the request.

Enabling thinking also suppresses `temperature` and `topP`, and relaxes a forced tool choice to `auto`, because Anthropic rejects those alongside reasoning.

**Thinking: Display** controls what you see:

| Value | Behavior |
| --- | --- |
| `native` | Uses VS Code's thinking UI when the API is available, otherwise shows nothing. |
| `text` | Always renders reasoning inline, inside a collapsed `<details>` block. |
| `hidden` | Captures reasoning for the model's own use but shows none of it. |

The `native` option depends on a VS Code API that is still proposed, and a Marketplace build cannot declare proposed APIs. The extension therefore detects it at runtime: on VS Code Insiders you get the real thinking UI, and on a stable build `native` shows nothing. Choose `text` if you want to read the reasoning on a stable build.

Reasoning is signed by Bedrock and must be replayed verbatim on the follow-up turn that carries tool results, so the extension stores each turn's reasoning against the tool calls it produced and sends it back when those results arrive.

#### Choosing an effort level

Effort can be changed without opening settings, in two places:

**The status bar**, bottom right, reads `Bedrock: think high` (or `think off`).

![The status bar item](docs/screenshots/03-status-bar.png)

Click it for a quick pick of `off` / `low` / `medium` / `high` / `xhigh`, with the current level ticked:

![The thinking effort quick pick](docs/screenshots/05-effort-quick-pick.png)

It writes the same **Thinking: Enabled** and **Thinking: Effort** settings the settings editor shows, so the two can never disagree. This is a **global default** — it applies to every conversation. Hide the item as you would any other: right-click the status bar and untick *Bedrock Thinking Effort*.

**The chat model picker**, once **Thinking: Show Effort Variants In Model Picker** is on — the last entry in that quick pick toggles it, so you never need to open settings. Each reasoning-capable model then appears once plainly and once per level:

![Effort variants in the chat model picker](docs/screenshots/04-model-picker.png)

Because VS Code remembers the chosen model per conversation, picking a variant makes effort **per-conversation**: a `think xhigh` chat and a `think low` chat can run side by side. The plain entry has no suffix and inherits the status bar default.

Precedence is simply: **a variant picked in the chat window wins; anything else falls back to the status bar default**, which can itself be off. The output channel records which applied, as `thinkingEffort` and `thinkingSource` on each turn.

Models with no reasoning mode are never expanded — padding the list with entries that would be ignored on the wire is worse than not offering them. Below, Claude 3 Haiku and DeepSeek V3.2 stay single rows while the Claude 4.5+ models each gain four:

| Variants off (the default) | Variants on |
| --- | --- |
| ![Model list with variants off](docs/screenshots/01-language-models-variants-off.png) | ![Model list with variants on](docs/screenshots/02-language-models-variants-on.png) |

#### Curating which variants you see

The variants are off by default because they multiply the length of a list people already know. Turning them on or off refreshes the picker immediately — no reload needed, and with them off the behaviour is exactly the status bar plus settings.

If you want the per-conversation control but not all four levels, you do not have to accept the full list. Variants are ordinary models, so VS Code's own per-model visibility toggles apply: open **Manage Language Models** (the gear in the model picker, or *Chat: Manage Language Models*) and use the eye icons to hide the levels you never reach for. The second screenshot above is doing exactly that — `low` and `medium` are hidden, so the picker offers only `high` and `xhigh`.

[docs/mockups/](docs/mockups/) records the alternatives that were considered and why this combination won.

### Prompt caching

[Bedrock prompt caching](https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html) lets you pay a reduced rate for the parts of a request the model has already seen. It is on by default for models that support it, and does nothing for models that do not.

Checkpoints are placed where they compound across a session:

- **Tool schemas and the system prompt**, which are byte-identical on every turn of an agent session and are usually the largest fixed cost.
- **The last two user messages.** Marking only the newest message would write a cache entry that the next request, whose prefix has already grown past it, could never read. Marking the previous one as well means each turn reads back the checkpoint the turn before it wrote.

Anthropic allows four checkpoints, which is exactly what the above uses. Caching is skipped entirely when the prompt is below the model's minimum cacheable size, since a refused checkpoint is billed as an ordinary write and never read back.

Cache reads and writes are reported per turn in the output channel. If you see checkpoints requested but no cache activity, the conversation is still too short to cache.

### Token usage and context size

Every turn writes a summary to the **Bedrock Chat** output channel (View → Output → Bedrock Chat), taken from Bedrock's own accounting rather than estimated:

```
[Usage] Turn complete { model: ..., stopReason: 'end_turn', inputTokens: 48213,
  outputTokens: 912, cacheReadInputTokens: 46080, cacheWriteInputTokens: 0,
  contextWindow: '48213/200000 (24.1%)', latencyMs: 3184, toolCalls: 2, cachePoints: 4 }
[Usage] Session totals { turns: 12, inputTokens: 501233, outputTokens: 8104, ... }
```

You also get a warning when the context window passes 90% full, and when caching was requested but Bedrock reported no cache activity.

Copilot's own context-window indicator is driven by the provider's token-count callback, which now counts tool calls, tool results and images instead of text alone, and prefers Bedrock's real tokenizer over a character estimate. See [Limitations](#limitations) for what still cannot be surfaced there.

### Commands

- **Configure AWS Bedrock**: Quick access to Bedrock settings
- **AWS Bedrock: Select Thinking Effort**: The status bar quick pick, also reachable from the command palette
- **Change Bedrock Model**: Information about model selection
- **Manage AWS Bedrock Provider**: Legacy configuration command (deprecated)

### Model Selection

Model selection is integrated into VS Code's chat interface:
1. Open GitHub Copilot Chat
2. Click the model dropdown at the top of the chat panel
3. Select any available Bedrock model

All models with streaming support in your region will appear in the dropdown.

## Development

Common scripts:

- Build: `npm run compile`
- Watch: `npm run watch`
- Test: `npm test`
- Package: `npm run vscode:prepublish`

```bash
git clone https://github.com/aristide1997/bedrock-vscode-chat
cd bedrock-vscode-chat
npm install
npm run compile
```

Press F5 to launch an Extension Development Host.

### Live feature test

`npm test` is fully offline. To verify the streaming, caching, thinking and usage
features against real Bedrock, run:

```bash
export AWS_BEARER_TOKEN_BEDROCK=...   # or AWS_PROFILE
export AWS_REGION=us-west-2
node scripts/live-feature-test.js
```

It loads the extension's own compiled modules and drives them end to end, asserting
on Bedrock's actual responses: cache checkpoints reading back across turns, signed
reasoning on both the adaptive and budget thinking APIs, a multi-kilobyte tool call
arriving as parseable JSON, an effort variant chosen in the model picker decoding
back to an invocable model ID, and usage/latency captured from the metadata event.
It prints the tokens it spent. Roughly 8 API calls per run.

`ONLY=<substring>` restricts it to matching tests. `EXT_DIR=<path>` points it at an
installed extension directory instead of the repo build, to verify the artifact VS Code
actually loaded. `STUB_THINKING_API=1` simulates the Insiders-only thinking API.

Two behaviors are environment-dependent rather than defects: `bedrock:CountTokens`
requires that IAM action (the extension falls back to estimation and remembers the
rejection), and a cache checkpoint reports a read instead of a write when a prior run
already populated it.

## Troubleshooting

### Truncated tool calls

If the agent stops mid-task and the output channel shows `Invalid JSON for tool call`, the model's tool arguments were cut off before they formed valid JSON. The extension now reports this as a visible error naming the tool, instead of stopping silently. It deliberately does not try to repair the arguments: half of a file-edit call would apply a truncated replacement string and corrupt the file.

The usual cause is the output-token ceiling. Check `stopReason` in the output channel:

- **`max_tokens`** — the response hit its output limit. Raise **Max Output Tokens**, or ask for a smaller change. Note that the old flat 4096-token default is gone; modern Claude models now default to their real ceiling, which fixes most of these.
- **anything else** — the model genuinely emitted malformed JSON. Retry the request. The partial arguments are logged so you can see what it was attempting.

### Empty snippet in the error

An `Invalid JSON for tool call` error with an empty snippet used to mean two chat requests were running at once and one wiped the other's half-accumulated arguments. Stream state is now per-request, so this should no longer occur. If you see it again, please open an issue with the output channel contents.

## Limitations

- **Image/vision input requires being signed in to GitHub Copilot Chat.** When signed out (using Bedrock purely as a bring-your-own-key provider), VS Code's chat agent strips image attachments before they reach *any* model provider — so vision-capable Bedrock models will only receive the text. This is a VS Code Copilot Chat gate, not a limitation of this extension. Text and tool calling work either way.
- **Usage details cannot be written into Copilot's own request log.** The finalized language-model provider API gives a provider no channel for feeding token counts, latency or cache statistics back into Copilot's Agent debug log. Everything the extension measures goes to the **Bedrock Chat** output channel instead. Copilot's context-window indicator is driven by the provider's token-count callback, which the extension supplies as accurately as it can.
- **Native thinking display requires VS Code Insiders.** The thinking-part API is still proposed, and a Marketplace build cannot declare proposed APIs. Use **Thinking: Display** = `text` on a stable build.
- Some models don't support streaming with tool calls simultaneously
- Rate limits apply based on your AWS account settings

## Resources

- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [AWS Bedrock API Keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [GitHub Repository](https://github.com/aristide1997/bedrock-vscode-chat)

## License

MIT License
