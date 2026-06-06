// Playwright-Electron E2E harness for the Bedrock VS Code extension.
// Downloads a pinned VS Code (via @vscode/test-electron — cross-platform, no system
// install needed), installs the VSIX into an isolated profile, exposes a CDP port,
// connects Playwright over CDP, and drives the real workbench UI like a user.
//
// Run:  node e2e/run.mjs        (needs AWS_BEARER_TOKEN_BEDROCK in env or ../.env;
//                                skips cleanly if absent)
// See e2e/README.md for the full list of env vars and the image/vision caveat.

import { chromium } from 'playwright';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..');
const VSIX_OVERRIDE = process.env.E2E_VSIX || null; // null → build a fresh VSIX from source
const SHOTS = join(import.meta.dirname, 'shots');
const CDP_PORT = Number(process.env.E2E_CDP_PORT || 9222);
const REGION = process.env.E2E_REGION || 'eu-central-1';
const TARGET_MODEL = process.env.E2E_MODEL || 'Claude Haiku 4.5';
const VSCODE_VERSION = process.env.E2E_VSCODE_VERSION || '1.122.1'; // pinned for stable chat-UI selectors
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'; // cross-platform command modifier

// AWS Bedrock key: prefer the env var (CI/secrets), fall back to ../.env, else null → skip.
function readKey() {
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) return process.env.AWS_BEARER_TOKEN_BEDROCK.trim();
  const envPath = join(REPO, '.env');
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('AWS_BEARER_TOKEN_BEDROCK='));
    if (line) return line.slice('AWS_BEARER_TOKEN_BEDROCK='.length).trim();
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let PROC = null; // module-scoped so failure teardown can kill it
let COPIED_PROFILE = null; // temp profile copy to clean up on exit

// Default VS Code user-data dir per platform (for the optional signed-in profile copy)
function defaultProfileDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code');
  if (process.platform === 'win32') return join(process.env.APPDATA || '', 'Code');
  return join(homedir(), '.config', 'Code');
}

let EXIT_CODE = 0; // non-zero on any failed assertion → CI-gating
let BUILT_VSIX_DIR = null; // temp dir holding a freshly-built VSIX, cleaned on exit

// Build a fresh VSIX from the current source (default). Cleans the repo's out/ first so
// stale compiled files never get packaged, then `vsce package` (which runs the
// vscode:prepublish compile) into a temp file. Requires the repo's root deps installed.
function buildVsix() {
  console.log('[harness] building VSIX from source (set E2E_VSIX to use a prebuilt one)...');
  rmSync(join(REPO, 'out'), { recursive: true, force: true });
  BUILT_VSIX_DIR = mkdtempSync(join(tmpdir(), 'vsc-build-'));
  const out = join(BUILT_VSIX_DIR, 'extension.vsix');
  execFileSync('npx', ['--yes', '@vscode/vsce', 'package', '-o', out], { cwd: REPO, stdio: 'inherit' });
  return out;
}

// VS Code persists each OutputChannel to disk under <userDataDir>/logs/**/output_logging_*/.
// Reading the "Bedrock Chat" channel file is the deterministic, headless, CI-safe source of
// truth for what the extension actually did (no DOM/screenshots needed).
function readBedrockChatLog(userDataDir) {
  const logsDir = join(userDataDir, 'logs');
  if (!existsSync(logsDir)) return '';
  let rel = [];
  try { rel = readdirSync(logsDir, { recursive: true }).filter((p) => String(p).endsWith('Bedrock Chat.log')); } catch {}
  return rel.map((p) => { try { return readFileSync(join(logsDir, p), 'utf8'); } catch { return ''; } }).join('\n');
}

function killPort(port) {
  try {
    const pids = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const pid of pids) { try { process.kill(Number(pid)); } catch {} }
    if (pids.length) console.log(`[harness] killed stale process(es) on :${port} ->`, pids.join(','));
  } catch { /* nothing listening */ }
}

async function waitForCDP(port, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error('CDP endpoint never came up');
}

let shotN = 0;
async function shot(win, name) {
  shotN += 1;
  const file = join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`);
  await win.screenshot({ path: file });
  console.log('[harness] shot ->', file);
}

// --- VS Code UI helpers (condition-waits, not fixed sleeps) ---
const qiHidden = (win) => win.locator('.quick-input-widget').first()
  .waitFor({ state: 'hidden', timeout: 6000 }).catch(() => {});

async function runCommand(win, text) {
  await win.keyboard.press(`${MOD}+Shift+KeyP`);
  const box = win.locator('.quick-input-widget .quick-input-filter input, .quick-input-box input').first();
  await box.waitFor({ timeout: 10000 });
  await box.fill(`>${text}`);
  // wait for the command list to populate (filtering done) before accepting
  await win.locator('.quick-input-list .monaco-list-row').first().waitFor({ timeout: 6000 }).catch(() => {});
  await win.keyboard.press('Enter');
  await qiHidden(win); // command accepted → palette dismissed
}

async function pickRow(win, label) {
  // operate on an open quick-input list: wait for the matching row, then accept it
  const box = win.locator('.quick-input-widget input').first();
  await box.waitFor({ timeout: 10000 });
  await box.fill(label);
  await win.locator('.quick-input-list .monaco-list-row', { hasText: label }).first()
    .waitFor({ timeout: 6000 }).catch(() => {});
  await win.keyboard.press('Enter');
  await qiHidden(win);
}

async function typeInputBox(win, text) {
  const box = win.locator('.quick-input-widget input').first();
  await box.waitFor({ timeout: 10000 });
  await box.click();
  await win.keyboard.type(text, { delay: 5 });
  await win.keyboard.press('Enter');
  await qiHidden(win);
}

async function main() {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });
  const key = readKey();
  if (!key) {
    console.log('[harness] SKIPPED — no AWS Bedrock credentials. Set AWS_BEARER_TOKEN_BEDROCK in your environment or ../.env to run the test.');
    return;
  }
  console.log('[harness] key loaded (length ' + key.length + ')');

  // Resolve the VSIX: build from source by default (always tests current code), or
  // use a prebuilt one via E2E_VSIX. Build first so failures surface before the download.
  const vsixPath = VSIX_OVERRIDE || buildVsix();
  console.log('[harness] VSIX:', vsixPath);

  // Resolve a VS Code to drive: a system install via E2E_VSCODE_PATH (fast local),
  // otherwise download + pin a known-good version (portable, no system install needed).
  let vscodeExecutablePath = process.env.E2E_VSCODE_PATH;
  if (vscodeExecutablePath) {
    console.log('[harness] using VS Code at', vscodeExecutablePath);
  } else {
    console.log('[harness] resolving VS Code', VSCODE_VERSION, '(downloads to cache on first run)...');
    vscodeExecutablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);
  }
  const [cliPath, ...cliBaseArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

  // Reuse a signed-in profile so the image/vision stage can run (Copilot Chat drops
  // images when there's no Copilot token). Three ways to supply one:
  //   E2E_USER_DATA=<dir>   use this profile dir as-is
  //   E2E_REUSE_PROFILE=1   copy the local VS Code profile (minus caches) to temp
  //   (neither)             fresh profile → signed out → image stage auto-skips
  if (process.env.E2E_REUSE_PROFILE && !process.env.E2E_USER_DATA) {
    const src = process.env.E2E_PROFILE_SRC || defaultProfileDir();
    if (existsSync(src)) {
      COPIED_PROFILE = mkdtempSync(join(tmpdir(), 'vsc-profile-'));
      console.log('[harness] copying signed-in profile (minus caches):', src);
      // rsync handles the profile's special files (sockets/symlinks) that fs.cpSync trips on
      const excludes = ['CachedData', 'CachedExtensions', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache',
        'DawnGraphiteCache', 'Service Worker', 'logs', 'Crashpad', 'blob_storage', 'Local Storage',
        'WebStorage', 'User/History', 'User/workspaceStorage'];
      execFileSync('rsync', ['-a', ...excludes.flatMap(e => ['--exclude', e]), `${src}/`, `${COPIED_PROFILE}/`],
        { stdio: 'ignore' });
    } else {
      console.log('[harness] E2E_REUSE_PROFILE set but no profile at', src, '- image stage will skip');
    }
  }
  const reuseProfile = !!(process.env.E2E_USER_DATA || COPIED_PROFILE);
  const userDataDir = process.env.E2E_USER_DATA || COPIED_PROFILE || mkdtempSync(join(tmpdir(), 'vsc-user-'));
  const extDir = mkdtempSync(join(tmpdir(), 'vsc-ext-'));
  const workDir = mkdtempSync(join(tmpdir(), 'vsc-work-'));
  console.log('[harness] userDataDir =', userDataDir, reuseProfile ? '(reused profile)' : '(fresh)');
  console.log('[harness] workDir     =', workDir);
  // seed the workspace with the vision test image
  copyFileSync(join(import.meta.dirname, 'assets', 'vision.png'), join(workDir, 'vision.png'));

  console.log('[harness] installing VSIX...');
  console.log(execFileSync(cliPath, [
    ...cliBaseArgs,
    '--install-extension', vsixPath,
    '--extensions-dir', extDir,
    '--user-data-dir', userDataDir,
    '--force',
  ], { encoding: 'utf8' }).trim());

  // Write a clean, deterministic, noise-free settings.json. Safe even for a reused
  // profile: the GitHub auth session lives in globalStorage, not settings.json, so
  // overwriting settings keeps us signed in while stripping the user's models,
  // notifications, recommendations, and other interfering state.
  const settingsDir = join(userDataDir, 'User');
  mkdirSync(settingsDir, { recursive: true });
  writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false,
    'workbench.startupEditor': 'none',
    'update.mode': 'none',
    'telemetry.telemetryLevel': 'off',
    'extensions.ignoreRecommendations': true,
    'extensions.autoCheckUpdates': false,
    'extensions.autoUpdate': false,
    'workbench.enableExperiments': false,
    'workbench.tips.enabled': false,
    'workbench.welcomePage.walkthroughs.openOnInstall': false,
    'git.openRepositoryInParentFolders': 'never',
    'chat.commandCenter.enabled': false,
  }, null, 2));

  const cleanEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('VSCODE_') || k.startsWith('ELECTRON_')) continue;
    cleanEnv[k] = v;
  }
  delete cleanEnv.NODE_OPTIONS;
  cleanEnv.AWS_BEARER_TOKEN_BEDROCK = key;

  killPort(CDP_PORT); // ensure no stale harness instance holds the debug port
  console.log('[harness] launching VS Code with CDP...');
  const proc = spawn(vscodeExecutablePath, [
    workDir,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${extDir}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
  ], { env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  PROC = proc;
  proc.stderr.on('data', (d) => {
    const s = d.toString();
    if (!s.startsWith('[')) process.stdout.write(`[vscode:err] ${s}`);
  });

  const ver = await waitForCDP(CDP_PORT);
  console.log('[harness] CDP up:', ver.Browser);

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  let win;
  for (let i = 0; i < 60 && !win; i++) {
    for (const p of ctx.pages()) {
      try { if (await p.locator('.monaco-workbench').count()) { win = p; break; } } catch {}
    }
    if (!win) await sleep(500);
  }
  if (!win) throw new Error('workbench page not found over CDP');
  await win.locator('.monaco-workbench').first().waitFor({ timeout: 60000 });
  console.log('[harness] workbench loaded');
  await sleep(3000);
  await shot(win, 'launched');
  const signedOut = await win.evaluate(() =>
    !!Array.from(document.querySelectorAll('a, .monaco-button, [role=button]'))
      .find(e => /^\s*Sign in\s*$/i.test(e.textContent || '')));
  console.log('[harness] GitHub sign-in state:', signedOut ? 'SIGNED OUT' : 'appears SIGNED IN');
  await clearNotifications(); // clear any startup toasts (recommendations, tips) before interacting

  // ---- STAGE 2: configure auth via the extension's UI ----
  console.log('[harness] STAGE 2: configure API key via bedrock.manage');
  await runCommand(win, 'Manage AWS Bedrock Provider');
  await shot(win, 'manage-menu');
  await pickRow(win, 'Set Authentication Method');
  await shot(win, 'auth-method-menu');
  await pickRow(win, 'API Key');
  await shot(win, 'apikey-inputbox');
  await typeInputBox(win, key);
  await shot(win, 'apikey-saved');

  // set region (eu-central-1: has the Claude Haiku 4.5 inference profile + key is verified there)
  await runCommand(win, 'Manage AWS Bedrock Provider');
  await pickRow(win, 'Set Region');
  await pickRow(win, REGION);
  await shot(win, 'region-saved');

  // dump the resulting settings.json for verification
  const settingsFile = join(userDataDir, 'User', 'settings.json');
  if (existsSync(settingsFile)) {
    const writtenSettings = readFileSync(settingsFile, 'utf8');
    console.log('[harness] bedrock settings now:\n' + writtenSettings.split('\n').filter(l => /bedrock|authMethod|region|apiKey/.test(l)).join('\n').replace(key, '<KEY:' + key.length + 'chars>'));
  }

  // ---- STAGE 3: add a Bedrock model via "Manage Language Models" (no sign-in; VS Code 1.122 BYOK) ----
  console.log('[harness] STAGE 3: Chat: Manage Language Models');
  await runCommand(win, 'Manage Language Models');
  // wait for the provider to list its models (a Bedrock network call) before continuing
  await win.locator('.monaco-list-row', { hasText: 'Claude' }).first().waitFor({ timeout: 20000 }).catch(() => {});
  await shot(win, 'models-listed');

  // Close the Language Models editor and focus the chat input
  await win.keyboard.press(`${MOD}+KeyW`);
  await runCommand(win, 'Chat: Focus on Chat View');
  await win.locator('.interactive-input-editor').first().waitFor({ timeout: 10000 }).catch(() => {});
  await shot(win, 'chat-focused');

  // ---- STAGE 4: select the BEDROCK model in the chat picker (action-widget) ----
  // Signed-in profiles also list Copilot models (GPT-5, a Copilot-hosted "<model> Upgrade",
  // etc.). If selection flakes, the chat silently falls back to the default Copilot model,
  // so we MUST pick the Bedrock row ("Multi-Region"/"Anthropic", not "Upgrade") and assert.
  console.log('[harness] STAGE 4: pick Bedrock model:', TARGET_MODEL);
  const readModelLabel = () => win.evaluate(() => {
    const b = document.querySelector('.chat-input-toolbars [aria-label^="Pick Model"]');
    return b ? (b.getAttribute('aria-label') || '') : '';
  });
  const matchesTarget = (s) => s.toLowerCase().includes(TARGET_MODEL.toLowerCase());
  async function pickModelOnce() {
    const modelBtn = win.locator('.chat-input-toolbars a.model-picker-name, .chat-input-toolbars [aria-label^="Pick Model"]').first();
    await modelBtn.click({ timeout: 5000 });
    // wait for the dropdown to actually render rather than guessing with a fixed sleep
    await win.locator('.action-widget').first().waitFor({ timeout: 5000 }).catch(() => {});
    const filter = win.locator('.action-widget input.action-list-filter-input, .action-widget input').first();
    if (await filter.count() && await filter.isVisible()) {
      await filter.fill(TARGET_MODEL);
      await sleep(700);
      const filtered = await win.evaluate(() =>
        Array.from(document.querySelectorAll('.action-widget .monaco-list-row')).map(r => r.textContent.trim().slice(0, 50)));
      // Deterministic selection by PROVIDER GROUP: the picker groups models under a
      // provider header whose label is the extension's displayName ("AWS Bedrock").
      // Find that header, then the first model row under it matching TARGET_MODEL.
      // This never confuses Copilot's built-in "<model>" with the Bedrock one.
      const pick = await win.evaluate((target) => {
        const rows = Array.from(document.querySelectorAll('.action-widget .monaco-list-row'));
        const texts = rows.map(r => (r.textContent || '').trim());
        const t = target.toLowerCase();
        const hdr = texts.findIndex(x => /^aws bedrock$/i.test(x));
        if (hdr >= 0) {
          for (let i = hdr + 1; i < texts.length; i++) {
            if (texts[i].toLowerCase().includes(t)) return { index: i, via: 'group', text: texts[i] };
          }
        }
        // Fallbacks (e.g. signed-out layout has no group header):
        let i = texts.findIndex(x => x.toLowerCase().includes(t) && /multi-region/i.test(x));
        if (i >= 0) return { index: i, via: 'multi-region', text: texts[i] };
        i = texts.findIndex(x => x.toLowerCase().includes(t) && !/copilot|upgrade/i.test(x));
        return i >= 0 ? { index: i, via: 'non-copilot', text: texts[i] } : { index: -1 };
      }, TARGET_MODEL);
      console.log('[harness]   picker rows:', JSON.stringify(filtered), '-> pick', JSON.stringify(pick));
      if (pick.index >= 0) {
        const row = win.locator('.action-widget .monaco-list-row').nth(pick.index);
        await row.scrollIntoViewIfNeeded().catch(() => {});
        await row.click({ force: true, timeout: 6000 });
      } else {
        console.log('[harness]   no Bedrock row matched');
      }
    }
    await sleep(700);
    if (await win.locator('.action-widget').count()) { await win.keyboard.press('Escape').catch(() => {}); await sleep(200); }
    return readModelLabel();
  }
  let selectedLabel = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    selectedLabel = await pickModelOnce().catch((e) => { console.log('[harness]   pick attempt', attempt, 'note:', e.message); return ''; });
    console.log('[harness] attempt', attempt, 'active model =', JSON.stringify(selectedLabel));
    if (matchesTarget(selectedLabel)) break;
    await sleep(500);
  }
  await shot(win, 'model-selected');
  if (!matchesTarget(selectedLabel)) {
    throw new Error(`Could not select "${TARGET_MODEL}" (active model: "${selectedLabel}"). Aborting so we never run on the wrong model.`);
  }

  // --- chat helpers ---
  // A reused real profile can raise toast notifications (e.g. "install recommended
  // extensions for Docker?") that overlap the chat input. Clear them before typing.
  async function clearNotifications() {
    await runCommand(win, 'Notifications: Clear All Notifications');
    await sleep(200);
  }
  async function typePrompt(text) {
    // Clean interaction: click the editor like a user, then type.
    await win.locator('.interactive-input-editor').first().click();
    await sleep(150);
    await win.keyboard.type(text, { delay: 8 });
    await sleep(250);
    await win.keyboard.press('Enter');
  }
  // Completion = response text stable for 2 consecutive polls (the progress-class
  // signals proved unreliable). Polls every 1s and returns as soon as it settles.
  async function waitResponse({ maxMs = 60000, approve = false, stableNeeded = 2 } = {}) {
    let last = null, stable = 0, resp = { text: '', tools: 0 };
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (approve) {
        const btn = win.locator('.chat-confirmation-widget .monaco-button, .chat-confirmation-widget2 .monaco-button, .chat-tool-confirmation-carousel-container .monaco-button')
          .filter({ hasText: /Continue|Allow|Keep|Accept|^Run/ }).first();
        if (await btn.count()) { try { await btn.click({ timeout: 2000 }); console.log('[harness] approved a tool confirmation'); } catch {} }
      }
      resp = await win.evaluate(() => {
        const rows = document.querySelectorAll('.interactive-item-container.interactive-response');
        const el = rows[rows.length - 1];
        return el ? { text: el.innerText.trim(), tools: el.querySelectorAll('.chat-tool-invocation-part').length } : { text: '', tools: 0 };
      });
      // don't settle while the agent is still streaming/running a tool
      const busy = /\bEvaluating\b|\bReasoning\b|\bThinking\b|view_image|Reviewed image|Using |Running |Generating/.test(resp.text) && resp.text === last;
      if (resp.text && resp.text === last && !busy) { stable++; if (stable >= stableNeeded) break; }
      else stable = 0;
      last = resp.text;
    }
    return resp;
  }

  // ---- STAGE 5: text chat (real Bedrock inference) ----
  console.log('[harness] STAGE 5: text chat');
  await typePrompt('Reply with exactly this token and nothing else: BEDROCK_E2E_OK');
  await shot(win, 'prompt-typed');
  const r5 = await waitResponse({ maxMs: 30000 });
  await shot(win, 'text-response');
  console.log('[harness] TEXT RESULT | ' + JSON.stringify(r5.text.slice(0, 200)));

  // ---- STAGE 6: tool call (agent creates a file) ----
  console.log('[harness] STAGE 6: tool call');
  await typePrompt('Using your file editing tools, create a new file named TOOLCALL.txt in the workspace whose only content is the text TOOLCALL_OK. Do it now.');
  const r6 = await waitResponse({ maxMs: 60000, approve: true });
  await shot(win, 'tool-response');
  const toolFile = join(workDir, 'TOOLCALL.txt');
  const fileCreated = existsSync(toolFile);
  console.log('[harness] TOOL RESULT toolInvocationParts=' + r6.tools +
    ' | fileCreated=' + fileCreated +
    (fileCreated ? ' | content=' + JSON.stringify(readFileSync(toolFile, 'utf8').trim()) : '') +
    ' | workDir=' + JSON.stringify(readdirSync(workDir)));

  // ---- STAGE 7: image / vision (attach via "Add Context..." file picker) ----
  // Only meaningful when signed into GitHub: Copilot Chat strips image attachments
  // for any model when there's no Copilot token (image.tsx:81), so skip when signed out.
  let imageText = null; // null = stage skipped (signed out)
  if (signedOut) {
    console.log('[harness] STAGE 7: image / vision — SKIPPED (not signed into GitHub; Copilot Chat drops images in BYOK mode). Re-run with E2E_REUSE_PROFILE=1 using a signed-in profile.');
  } else try {
    console.log('[harness] STAGE 7: image / vision');
    const addBtn = win.locator('.chat-input-toolbars [aria-label^="Add Context"]').first();
    await addBtn.click({ timeout: 5000 });
    await sleep(800);
    const qi = win.locator('.quick-input-widget input').first();
    if (await qi.count() && await qi.isVisible()) {
      await qi.fill('vision.png');
      await win.locator('.quick-input-list .monaco-list-row', { hasText: 'vision.png' }).first().waitFor({ timeout: 6000 }).catch(() => {});
      await win.keyboard.press('Enter');
      // wait for the attachment chip to register before sending
      await win.locator('.chat-attached-context').first().waitFor({ timeout: 6000 }).catch(() => {});
    }
    await shot(win, 'attached');
    const chips = await win.evaluate(() => Array.from(document.querySelectorAll('.chat-attached-context [role=listitem], .chat-attached-context .monaco-button')).map(c => c.textContent.trim().slice(0, 30)));
    console.log('[harness] attachment chips:', JSON.stringify(chips));
    await typePrompt('What exact text is written in the attached image? Reply with only that text.');
    const r7 = await waitResponse({ maxMs: 75000, approve: true, stableNeeded: 3 });
    await shot(win, 'image-response');
    imageText = r7.text;
    console.log('[harness] IMAGE RESULT | ' + JSON.stringify(r7.text.slice(0, 200)));
  } catch (e) { console.log('[harness] image stage note:', e.message); }

  await shot(win, 'final');

  // ---- Deterministic verification (CI-grade) ----
  // Source of truth = the on-disk "Bedrock Chat" output-channel log + captured response
  // text. No screenshots/DOM scraping in the pass/fail path. Sets EXIT_CODE on failure.
  const log = readBedrockChatLog(userDataDir);
  const served = /Using API key authentication/.test(log) && /Starting streaming request/.test(log);
  // image part reached the Bedrock provider: converter logs it, or it appears in a user message
  const imageInRequest = /Added image block/.test(log) ||
    /Bedrock message \d+ \(user\): \[[^\]]*"image"[^\]]*\]/.test(log);
  const toolContent = fileCreated ? readFileSync(toolFile, 'utf8').trim() : '';

  const checks = [
    ['Bedrock provider served requests (API-key auth + streaming in its log)', served, 'fail'],
    ['active model was the Bedrock Claude Haiku 4.5 (asserted at selection)', matchesTarget(selectedLabel), 'fail'],
    ['text reply contains BEDROCK_E2E_OK', /BEDROCK_E2E_OK/.test(r5.text), 'fail'],
    ['tool call created TOOLCALL.txt = TOOLCALL_OK', fileCreated && toolContent === 'TOOLCALL_OK', 'fail'],
  ];
  if (signedOut) {
    checks.push(['image stage skipped (signed out — expected, Copilot strips images)', true, 'skip']);
  } else {
    checks.push(['image delivered to Bedrock (image part in request log)', imageInRequest, 'fail']);
    checks.push(['image reply contains VISION_OK_42', /VISION_OK_42/.test(imageText || ''), 'fail']);
  }

  console.log('\n[harness] ===== VERIFICATION =====');
  if (!log) console.log('[harness]  WARN  no Bedrock Chat log file found under userDataDir/logs');
  for (const [name, ok, kind] of checks) {
    if (!ok && kind !== 'skip') EXIT_CODE = 1;
    console.log('[harness]  ' + (ok ? 'PASS' : kind === 'skip' ? 'SKIP' : 'FAIL') + '  ' + name);
  }
  console.log('[harness] ===== OVERALL: ' + (EXIT_CODE ? 'FAIL' : 'PASS') + ' =====');

  await browser.close();
  proc.kill();
  console.log('[harness] DONE (stages 1-7)');
}

main().catch((e) => {
  console.error('[harness] FAILED:', e.message || e);
  EXIT_CODE = 1;
}).finally(() => {
  try { if (PROC) PROC.kill('SIGKILL'); } catch {}
  killPort(CDP_PORT); // guarantee the debug port is free for the next run
  // delete the temp profile copy (contains the user's auth token) — node-side, no rm -rf
  if (COPIED_PROFILE) { try { rmSync(COPIED_PROFILE, { recursive: true, force: true }); console.log('[harness] removed copied profile'); } catch {} }
  if (BUILT_VSIX_DIR) { try { rmSync(BUILT_VSIX_DIR, { recursive: true, force: true }); } catch {} }
  process.exit(EXIT_CODE);
});
