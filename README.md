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
- Vision/image input for compatible models (Claude models)
- Extended thinking for compatible models (shows model's reasoning process)
- Support for all AWS regions
- Cross-region inference profiles for optimized model access and routing

## Available Models

The extension exposes all Bedrock foundation models with streaming capabilities across all AWS regions:

- Claude Sonnet 4.5
- Claude Sonnet 4 / 3.7 (supports extended thinking)
- Llama 3.1/3.2
- Mistral Large
- And more...

**Extended Thinking**: Claude 3.7 Sonnet and Claude 4 models support extended thinking mode, which shows the model's internal reasoning process before providing answers. When enabled, temperature is automatically set to 1.0 for optimal results.

## Configuration

### VS Code Settings

Configure the extension through VS Code settings (Cmd/Ctrl + , then search for "Bedrock"):

- **Region**: AWS region for Bedrock services (default: `us-east-1`)
- **Auth Method**: Choose from `api-key`, `profile`, `access-keys`, or `default`
- **API Key**: Your AWS Bedrock API Key (when using api-key method)
- **Profile**: AWS profile name (when using profile method)
- **Access Key ID / Secret Access Key**: AWS credentials (when using access-keys method)
- **Session Token**: AWS Session Token for temporary credentials (optional, used with access-keys method)
- **Enable Extended Thinking**: Enable extended thinking mode for compatible Claude models (default: disabled)
- **Thinking Budget Tokens**: Maximum tokens allocated for the thinking process (1024-32768, default: 1024)

### Commands

- **Configure AWS Bedrock**: Quick access to Bedrock settings
- **Change Bedrock Model**: Information about model selection
- **Manage AWS Bedrock Provider**: Legacy configuration command (deprecated)

### Model Selection

Model selection is integrated into VS Code's chat interface:
1. Open GitHub Copilot Chat
2. Click the model dropdown at the top of the chat panel
3. Select any available Bedrock model

All models with streaming support across all AWS regions will appear in the dropdown.

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

- Some models don't support streaming with tool calls simultaneously
- Rate limits apply based on your AWS account settings

## Resources

- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [AWS Bedrock API Keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [GitHub Repository](https://github.com/aristide1997/bedrock-vscode-chat)

## License

MIT License
