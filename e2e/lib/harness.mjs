// Harness lifecycle: build/resolve the VSIX, download+launch a pinned VS Code over CDP, connect
// Playwright, find the workbench, and tear it all down. setup() returns a ready-to-drive `ctx`
// (or null when there are no credentials → the run skips cleanly with exit 0).

import { chromium } from 'playwright';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { REPO, SHOTS, ASSETS, CDP_PORT, REGION, TARGET_MODEL, VSCODE_VERSION, VSIX_OVERRIDE, sleep } from './config.mjs';
import { createUI } from './ui.mjs';
import { Checks, snapshotBedrockChatLog } from './verify.mjs';

// Teardown state, module-scoped so a failure mid-setup still cleans up.
let PROC = null;
let BROWSER = null;
let COPIED_PROFILE = null; // temp profile copy (holds the user's auth token) to delete on exit
let BUILT_VSIX_DIR = null; // temp dir holding a freshly-built VSIX

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

// Default VS Code user-data dir per platform (for the optional signed-in profile copy)
function defaultProfileDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Code');
  if (process.platform === 'win32') return join(process.env.APPDATA || '', 'Code');
  return join(homedir(), '.config', 'Code');
}

// Build a fresh VSIX from the current source (default). Cleans the repo's out/ first so stale
// compiled files never get packaged, then `vsce package` (which runs the vscode:prepublish
// compile) into a temp file. Requires the repo's root deps installed.
function buildVsix() {
  console.log('[harness] building VSIX from source (set E2E_VSIX to use a prebuilt one)...');
  rmSync(join(REPO, 'out'), { recursive: true, force: true });
  BUILT_VSIX_DIR = mkdtempSync(join(tmpdir(), 'vsc-build-'));
  const out = join(BUILT_VSIX_DIR, 'extension.vsix');
  execFileSync('npx', ['--yes', '@vscode/vsce', 'package', '-o', out], { cwd: REPO, stdio: 'inherit' });
  return out;
}

function portPids(port) {
  try {
    return execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  } catch { return []; /* nothing listening */ }
}

function killPort(port) {
  const pids = portPids(port);
  for (const pid of pids) { try { process.kill(Number(pid)); } catch {} }
  if (pids.length) console.log(`[harness] killed stale process(es) on :${port} ->`, pids.join(','));
}

// Killing is async at the OS level; relaunching while the old instance still holds the debug port
// causes CDP to attach to a dying workbench ("page not found"). Wait for release.
async function waitForPortFree(port, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (portPids(port).length === 0) return;
    await sleep(150);
  }
  console.log(`[harness] WARN: port :${port} still held after ${timeoutMs}ms; launching anyway`);
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

// Build/launch VS Code and return a ready ctx, or null if there are no credentials (skip).
export async function setup() {
  rmSync(SHOTS, { recursive: true, force: true });
  mkdirSync(SHOTS, { recursive: true });

  const key = readKey();
  if (!key) {
    console.log('[harness] SKIPPED — no AWS Bedrock credentials. Set AWS_BEARER_TOKEN_BEDROCK in your environment or ../.env to run the test.');
    return null;
  }
  console.log('[harness] key loaded (length ' + key.length + ')');

  // Resolve the VSIX: build from source by default (always tests current code), or use a prebuilt
  // one via E2E_VSIX. Build first so failures surface before the download.
  const vsixPath = VSIX_OVERRIDE || buildVsix();
  console.log('[harness] VSIX:', vsixPath);

  // Resolve a VS Code to drive: a system install via E2E_VSCODE_PATH (fast local), otherwise
  // download + pin a known-good version (portable, no system install needed).
  let vscodeExecutablePath = process.env.E2E_VSCODE_PATH;
  if (vscodeExecutablePath) {
    console.log('[harness] using VS Code at', vscodeExecutablePath);
  } else {
    console.log('[harness] resolving VS Code', VSCODE_VERSION, '(downloads to cache on first run)...');
    vscodeExecutablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);
  }
  const [cliPath, ...cliBaseArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodeExecutablePath);

  // Reuse a signed-in profile so the image/vision stage can run (Copilot Chat drops images when
  // there's no Copilot token). Three ways to supply one:
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
  copyFileSync(join(ASSETS, 'vision.png'), join(workDir, 'vision.png'));

  console.log('[harness] installing VSIX...');
  console.log(execFileSync(cliPath, [
    ...cliBaseArgs,
    '--install-extension', vsixPath,
    '--extensions-dir', extDir,
    '--user-data-dir', userDataDir,
    '--force',
  ], { encoding: 'utf8' }).trim());

  // Write a clean, deterministic, noise-free settings.json. Safe even for a reused profile: the
  // GitHub auth session lives in globalStorage, not settings.json, so overwriting settings keeps
  // us signed in while stripping the user's models, notifications, recommendations, and other state.
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
  await waitForPortFree(CDP_PORT); // and wait for the OS to actually release it before relaunching
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
  BROWSER = browser;
  // Discover the workbench page. Re-read contexts()/pages() EACH iteration — they populate
  // asynchronously after connect, and VS Code opens several pages (splash, etc.) before the
  // workbench renders; capturing contexts()[0] once races against an empty/partial list.
  let win, ctxCount = 0, pageCount = 0;
  const findDeadline = Date.now() + 90000;
  while (!win && Date.now() < findDeadline) {
    const ctxs = browser.contexts();
    ctxCount = ctxs.length;
    const pages = ctxs.flatMap(c => c.pages());
    pageCount = pages.length;
    for (const p of pages) {
      try { if (await p.locator('.monaco-workbench').count()) { win = p; break; } } catch { /* page may be closing */ }
    }
    if (!win) await sleep(500);
  }
  if (!win) {
    throw new Error(
      `workbench page not found over CDP after 90s (saw ${ctxCount} context(s), ${pageCount} page(s)). ` +
      `Likely a slow start or a stale instance on :${CDP_PORT} — check \`lsof -ti tcp:${CDP_PORT}\`.`
    );
  }
  await win.locator('.monaco-workbench').first().waitFor({ timeout: 60000 });
  console.log('[harness] workbench loaded');
  await win.locator('.chat-input-toolbars, .monaco-workbench .part.editor').first().waitFor({ timeout: 10000 }).catch(() => {});

  const ui = createUI(win);
  await ui.shot('launched');
  const signedOut = await win.evaluate(() =>
    !!Array.from(document.querySelectorAll('a, .monaco-button, [role=button]'))
      .find(e => /^\s*Sign in\s*$/i.test(e.textContent || '')));
  console.log('[harness] GitHub sign-in state:', signedOut ? 'SIGNED OUT' : 'appears SIGNED IN');
  await ui.clearNotifications(); // clear any startup toasts (recommendations, tips) before interacting

  const sessionLogStart = snapshotBedrockChatLog(userDataDir);
  return {
    win, ui, key,
    region: REGION,
    targetModel: TARGET_MODEL,
    userDataDir, workDir,
    signedOut,
    sessionLogStart,
    checks: new Checks(),
    results: {},
  };
}

// Idempotent cleanup: close Playwright, kill VS Code, free the debug port, delete the temp profile
// copy (contains the user's auth token) and any freshly built VSIX. Safe to call from a finally.
export async function teardown() {
  try { if (BROWSER) await BROWSER.close(); } catch {}
  try { if (PROC) PROC.kill('SIGKILL'); } catch {}
  killPort(CDP_PORT); // guarantee the debug port is free for the next run
  if (COPIED_PROFILE) { try { rmSync(COPIED_PROFILE, { recursive: true, force: true }); console.log('[harness] removed copied profile'); } catch {} }
  if (BUILT_VSIX_DIR) { try { rmSync(BUILT_VSIX_DIR, { recursive: true, force: true }); } catch {} }
}
