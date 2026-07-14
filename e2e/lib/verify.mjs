// Verification helpers: read the extension's on-disk output-channel log (the deterministic,
// headless source of truth for what the extension actually did) and collect pass/fail checks.

import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';

// VS Code persists each OutputChannel to disk under <userDataDir>/logs/**/output_logging_*/.
// Reading the "Bedrock Chat" channel file is the deterministic, CI-safe source of truth for what
// the extension actually did (no DOM/screenshots needed). A reused profile (E2E_USER_DATA) can
// hold one such file per past session, so everything works per-file: readdir order never matters.
function readBedrockChatLogFiles(userDataDir) {
  const logsDir = join(userDataDir, 'logs');
  const files = {};
  if (!existsSync(logsDir)) return files;
  let rel = [];
  try { rel = readdirSync(logsDir, { recursive: true }).filter((p) => String(p).endsWith('Bedrock Chat.log')); } catch {}
  for (const p of rel) {
    try { files[String(p)] = readFileSync(join(logsDir, p), 'utf8'); } catch { files[String(p)] = ''; }
  }
  return files;
}

export function readBedrockChatLog(userDataDir) {
  return Object.values(readBedrockChatLogFiles(userDataDir)).join('\n');
}

// Snapshot per-file lengths, so a later delta contains exactly what each file appended since —
// immune to enumeration order and to new log files appearing between the two reads.
export function snapshotBedrockChatLog(userDataDir) {
  const lengths = {};
  for (const [p, content] of Object.entries(readBedrockChatLogFiles(userDataDir))) lengths[p] = content.length;
  return lengths;
}

export function bedrockChatLogDelta(userDataDir, snapshot) {
  return Object.entries(readBedrockChatLogFiles(userDataDir))
    .map(([p, content]) => content.slice(snapshot[p] || 0))
    .join('\n');
}

// Classify the Claude 5 temperature-regression stage from its own log delta + reply text.
//  - 'fail'  → a temperature ValidationException came back (the #21 bug is present)
//  - 'pass'  → the request streamed (Bedrock accepted it, so temperature was suppressed);
//              the token echo is corroboration, not a requirement — models may paraphrase
//  - 'skip'  → an auth/SCP deny short-circuits before request-body validation, so
//              temperature cannot be exercised at all
//  - 'fail'  → anything else (an unexpected error — surface it, never guess green)
// tempError is checked FIRST so the bug always fails even if other markers are also present.
export function classifyTemperatureStage({ replyText = '', delta = '', token } = {}) {
  const tempError = /temperature/i.test(delta) && /ValidationException|deprecated/i.test(delta);
  if (tempError) return { verdict: 'fail', reason: 'temperature ValidationException (the #21 bug)' };

  if (/Finished processing stream/.test(delta)) {
    const replyOk = !!token && replyText.includes(token);
    return { verdict: 'pass', reason: replyOk ? 'streamed, token echoed' : 'streamed (reply did not echo the token verbatim)' };
  }

  const accessError = /AccessDenied|not authorized|explicit deny/i.test(delta);
  if (accessError) return { verdict: 'skip', reason: 'key not authorized to invoke this model' };

  return { verdict: 'fail', reason: 'request never streamed and its log delta shows no recognized cause — inspect the run output' };
}

// Collects named checks and renders the final PASS/FAIL/SKIP report. kind 'skip' never fails
// the run; any other failed check sets a non-zero exit code (CI-gating).
export class Checks {
  constructor() { this.items = []; }
  add(name, ok) { this.items.push([name, !!ok, 'fail']); }
  skip(name) { this.items.push([name, false, 'skip']); }
  report({ log } = {}) {
    let exitCode = 0;
    console.log('\n[harness] ===== VERIFICATION =====');
    if (!log) console.log('[harness]  WARN  no Bedrock Chat log file found under userDataDir/logs');
    for (const [name, ok, kind] of this.items) {
      if (!ok && kind !== 'skip') exitCode = 1;
      console.log('[harness]  ' + (ok ? 'PASS' : kind === 'skip' ? 'SKIP' : 'FAIL') + '  ' + name);
    }
    console.log('[harness] ===== OVERALL: ' + (exitCode ? 'FAIL' : 'PASS') + ' =====');
    return exitCode;
  }
}
