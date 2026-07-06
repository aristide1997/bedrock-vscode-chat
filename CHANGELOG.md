# Changelog

All notable changes to the AWS Bedrock Provider for GitHub Copilot Chat extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
