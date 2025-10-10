# AWS Bedrock Provider for GitHub Copilot Chat

Integrates AWS Bedrock foundation models into GitHub Copilot Chat for VS Code.

![Demo](assets/demo.gif)

## Quick Start

1. Install the extension from the VS Code Marketplace
2. Generate a Bedrock API key following the [AWS Bedrock API Keys documentation](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
3. Open VS Code Command Palette (`Cmd+Shift+P` or `Ctrl+Shift+P`)
4. Run `Manage AWS Bedrock Provider`
5. Select "Set API Key" and paste your Bedrock API key
6. Select "Set Region" and choose your AWS region (default: `us-east-1`)
7. Open GitHub Copilot Chat and select any Bedrock model from the model picker

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

- **Manage AWS Bedrock Provider**: Configure API key and region

### Supported Regions

- US East (N. Virginia, Ohio)
- US West (Oregon)
- Asia Pacific (Mumbai, Tokyo, Seoul, Singapore, Sydney)
- Canada (Central)
- Europe (Frankfurt, Ireland, London, Paris)
- South America (São Paulo)

## Architecture

- `src/extension.ts`: Extension activation, command registration, region/key management
- `src/provider.ts`: Main provider implementing VS Code's LanguageModelChatProvider
- `src/utils.ts`: Message/tool conversion utilities
- `src/types.ts`: TypeScript definitions for Bedrock API types

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
- API keys are short-lived (12 hours for console-generated keys)
- Rate limits apply based on your AWS account settings

## Resources

- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)
- [AWS Bedrock API Keys](https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html)
- [VS Code Chat Provider API](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider)
- [GitHub Repository](https://github.com/aristide1997/bedrock-vscode-chat)

## License

MIT License
