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

### Commands

- **Configure AWS Bedrock**: Quick access to Bedrock settings
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

## Limitations

- **Image/vision input requires being signed in to GitHub Copilot Chat.** When signed out (using Bedrock purely as a bring-your-own-key provider), VS Code's chat agent strips image attachments before they reach *any* model provider — so vision-capable Bedrock models will only receive the text. This is a VS Code Copilot Chat gate, not a limitation of this extension. Text and tool calling work either way.
- Some models don't support streaming with tool calls simultaneously
- Rate limits apply based on your AWS account settings

## Resources

- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [AWS Bedrock API Keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [GitHub Repository](https://github.com/aristide1997/bedrock-vscode-chat)

## License

MIT License
