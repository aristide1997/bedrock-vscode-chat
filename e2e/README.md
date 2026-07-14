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

## Layout

`run.mjs` is a thin orchestrator: it calls `setup()`, runs each stage in order, then
`finalize()` verifies from the on-disk `Bedrock Chat` log. The behavior lives in modules:

```
run.mjs                # orchestrate: setup → stages → verify → exit
lib/
  config.mjs           # env resolution + shared constants
  harness.mjs          # build/resolve VSIX, launch VS Code over CDP, find workbench, teardown
  ui.mjs               # createUI(win): runCommand/pickRow/typePrompt/waitResponse/pickModel/…
  verify.mjs           # readBedrockChatLog + Checks collector (PASS/FAIL/SKIP + exit code)
stages/
  01-auth.mjs          # configure API key + region via the extension UI
  02-models.mjs        # Manage Language Models (list) + focus chat
  03-select-model.mjs  # pick the primary Bedrock model (E2E_MODEL) and assert it's active
  04-text.mjs          # text chat → BEDROCK_E2E_OK
  05-tool.mjs          # tool call → TOOLCALL.txt
  06-image.mjs         # vision (signed-out → skip)
  07-temp-sonnet5.mjs  # Claude 5 temperature regression (see below)
```

Each stage exports `run(ctx)`; `ctx` carries `{ win, ui, key, region, targetModel, workDir,
userDataDir, signedOut, checks, results }`. `ui.pickModel(name)` is shared by stages 03 and 07.

## What it verifies

- VSIX installs into an isolated profile.
- API key is configured through the extension's own `Manage AWS Bedrock Provider` UI.
- The Bedrock model is selectable in chat **without GitHub sign-in** (VS Code 1.122 BYOK).
- **Text** chat returns a real Bedrock response.
- **Tool calls** work (the agent creates a file via its tools).
- **The Bedrock provider actually served the requests** — asserted from the on-disk
  `Bedrock Chat` output-channel log (`Using API key authentication` + streaming), so a
  stray Copilot/built-in model can never make the test pass by accident.
- **Claude 5 temperature regression (#21)** — re-selects **Claude Sonnet 5** (`E2E_TEMP_MODEL`)
  in the same session and sends a plain prompt. Bedrock rejects `temperature` for Claude 4+
  models, so the stage classifies from its own log delta: **PASS** = the request streamed with no
  temperature `ValidationException` (the token echo is corroboration, not required). **SKIP** =
  the Sonnet 5 row is genuinely absent from the Bedrock group in the model picker, or an IAM/SCP
  deny short-circuits before request-body validation (so temperature can't be exercised). **FAIL** =
  a temperature `ValidationException` (the #21 regression), a picker row that exists but cannot be
  selected, or any other unexpected error — the stage fails fast and never turns an unknown error
  into a green skip. For a real PASS, `E2E_REGION` must offer **both** the primary model and
  Sonnet 5, and the key must be **authorized to invoke** Sonnet 5.
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
| `E2E_MODEL` | `Claude Haiku 4.5` | Primary model display name to select. |
| `E2E_TEMP_MODEL` | `Claude Sonnet 5` | Claude 4+ model for the temperature-regression stage; must be available in `E2E_REGION` or the stage skips. |
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
