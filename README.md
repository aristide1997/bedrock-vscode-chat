# AWS Bedrock Provider for GitHub Copilot Chat

Integrates AWS Bedrock foundation models into GitHub Copilot Chat for VS Code.

![Demo](assets/demo.gif)

## Quick Start

1. Install the extension
2. Run `Manage AWS Bedrock Provider` from Command Palette
3. Configure authentication (API key, AWS profile, or access keys)
4. Set your AWS region (default: `us-east-1`)
5. Select a Bedrock model in GitHub Copilot Chat

## Authentication

Three methods supported:

- **API Key**: Generate from [AWS Console](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
- **AWS Profile**: Use credentials from `~/.aws/credentials` (supports SSO)
- **Access Keys**: Direct AWS access key ID and secret (supports session tokens)

## Why AWS Bedrock

Direct AWS integration without third-party proxies:

- Uses your existing AWS infrastructure and compliance setup
- Native support for AWS IAM and security policies
- Access to all Bedrock foundation models through a single API
- Region selection for data residency requirements
- Pay-as-you-go pricing through your AWS account

## Available Models

The extension exposes all Bedrock foundation models with streaming capabilities:

- Claude Sonnet 4.5
- Claude Sonnet 4 / 3.7
- Llama 3.1/3.2
- Mistral Large
- And more...

Supports:
- Multi-turn conversations
- Streaming responses
- Tool/function calling for compatible models

## Configuration

### Commands

- **Manage AWS Bedrock Provider**: Configure authentication method and region

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
