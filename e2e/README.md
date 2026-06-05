# End-to-end test harness

Drives a **real VS Code** (downloaded and pinned via `@vscode/test-electron`) with a
`.vsix` **built fresh from the current source**, and exercises the extension the way a
user would — installing the API key through the UI, picking the Bedrock model, and
sending chat / tool-call / image prompts. Pass/fail is asserted from the extension's own
log + the chat responses; screenshots are written only for debugging.

This is **not** a CI gate. It needs real AWS Bedrock credentials (and, for the image
stage, a GitHub sign-in), so run it manually/locally. With no credentials it **skips
cleanly** (exit 0).

## Run it

```bash
npm install            # repo root — needed to compile + package the VSIX
cd e2e && npm install  # harness deps (playwright, @vscode/test-electron)
# key via env (preferred) …
AWS_BEARER_TOKEN_BEDROCK=bedrock-api-key-... node run.mjs
# … or put AWS_BEARER_TOKEN_BEDROCK=... in the repo-root ../.env
```

By default it **builds the VSIX from the current source** (clean `out/` + `vsce package`),
so it always tests your working tree — that's why the repo-root `npm install` is required.
Pass `E2E_VSIX=/path/to.vsix` to skip the build and test a prebuilt artifact instead.

First run also downloads VS Code (~230 MB) into the `@vscode/test-electron` cache. No
system VS Code install is required (any OS). Exit code: `0` = pass or skipped, `1` = failure.

## What it verifies

- VSIX installs into an isolated profile.
- API key is configured through the extension's own `Manage AWS Bedrock Provider` UI.
- The Bedrock model is selectable in chat **without GitHub sign-in** (VS Code 1.122 BYOK).
- **Text** chat returns a real Bedrock response.
- **Tool calls** work (the agent creates a file via its tools).
- **The Bedrock provider actually served the requests** — asserted from the on-disk
  `Bedrock Chat` output-channel log (`Using API key authentication` + streaming), so a
  stray Copilot/built-in model can never make the test pass by accident.
- **Image / vision** — see the caveat below.

## The image / vision caveat

Image attachments only reach a model when a **GitHub Copilot token is present** — VS Code's
chat agent strips images for *every* provider when signed out (its own gate, not this
extension's bug). So the image stage:

- **runs** when a signed-in profile is supplied, and asserts the image reached Bedrock
  (image part in the request log) and was read correctly;
- **skips** (still green) otherwise.

To run it, point the harness at a profile that is already signed into GitHub:

```bash
# copy your local VS Code profile (auth comes along; your real profile is untouched)
E2E_REUSE_PROFILE=1 node run.mjs
# …or use a specific profile dir as-is
E2E_USER_DATA=/path/to/profile node run.mjs
```

## Environment variables

| Var | Default | Purpose |
|-----|---------|---------|
| `AWS_BEARER_TOKEN_BEDROCK` | — | Bedrock API key. From env or repo-root `../.env`. Absent → skip. |
| `E2E_VSIX` | _(build from source)_ | Path to a prebuilt VSIX; skips the source build. |
| `E2E_REGION` | `eu-central-1` | AWS region (must offer the model's inference profile). |
| `E2E_MODEL` | `Claude Haiku 4.5` | Model display name to select. |
| `E2E_VSCODE_VERSION` | `1.122.1` | Pinned VS Code version to download. |
| `E2E_VSCODE_PATH` | — | Use a system VS Code executable instead of downloading (faster locally). |
| `E2E_REUSE_PROFILE` | — | `1` = copy the local VS Code profile (for a signed-in image run). |
| `E2E_USER_DATA` | — | Use this profile dir as-is. |
| `E2E_PROFILE_SRC` | OS default | Source profile dir for `E2E_REUSE_PROFILE`. |
| `E2E_CDP_PORT` | `9222` | CDP debug port (change for parallel runs). |

## Notes

- Screenshots land in `e2e/shots/` (git-ignored) — for debugging and for updating
  selectors when the VS Code chat UI changes.
- The harness scrubs the AWS key from logs and deletes any copied profile on exit.
- Selectors target VS Code **1.122**'s chat UI; bump `E2E_VSCODE_VERSION` and re-check
  the picker/editor selectors if you move to a newer VS Code.
