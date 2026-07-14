// VS Code workbench UI driver. `createUI(win)` binds every helper to one Playwright page and
// returns the high-level actions the stages compose (condition-waits, not fixed sleeps).

import { join } from 'node:path';
import { SHOTS, MOD, sleep } from './config.mjs';

export function createUI(win) {
  let shotN = 0;
  async function shot(name) {
    shotN += 1;
    const file = join(SHOTS, `${String(shotN).padStart(2, '0')}-${name}.png`);
    await win.screenshot({ path: file });
    console.log('[harness] shot ->', file);
  }

  const qiHidden = () => win.locator('.quick-input-widget').first()
    .waitFor({ state: 'hidden', timeout: 6000 }).catch(() => {});

  async function runCommand(text) {
    await win.keyboard.press(`${MOD}+Shift+KeyP`);
    const box = win.locator('.quick-input-widget .quick-input-filter input, .quick-input-box input').first();
    await box.waitFor({ timeout: 10000 });
    await box.fill(`>${text}`);
    // wait for the command list to populate (filtering done) before accepting
    await win.locator('.quick-input-list .monaco-list-row').first().waitFor({ timeout: 6000 }).catch(() => {});
    await win.keyboard.press('Enter');
    await qiHidden(); // command accepted → palette dismissed
  }

  async function pickRow(label) {
    // operate on an open quick-input list: wait for the matching row, then accept it
    const box = win.locator('.quick-input-widget input').first();
    await box.waitFor({ timeout: 10000 });
    await box.fill(label);
    await win.locator('.quick-input-list .monaco-list-row', { hasText: label }).first()
      .waitFor({ timeout: 6000 }).catch(() => {});
    await win.keyboard.press('Enter');
    await qiHidden();
  }

  async function typeInputBox(text) {
    const box = win.locator('.quick-input-widget input').first();
    await box.waitFor({ timeout: 10000 });
    await box.click();
    await win.keyboard.type(text, { delay: 5 });
    await win.keyboard.press('Enter');
    await qiHidden();
  }

  // A reused real profile can raise toast notifications (e.g. "install recommended extensions
  // for Docker?") that overlap the chat input. Clear them before typing.
  async function clearNotifications() {
    await runCommand('Notifications: Clear All Notifications');
    await sleep(200);
  }

  async function closeEditor() {
    await win.keyboard.press(`${MOD}+KeyW`);
  }

  async function typePrompt(text) {
    // Clean interaction: click the editor like a user, then type.
    await win.locator('.interactive-input-editor').first().click();
    await sleep(150);
    await win.keyboard.type(text, { delay: 8 });
    await sleep(250);
    await win.keyboard.press('Enter');
  }

  // Completion = response text stable for `stableNeeded` consecutive polls (the progress-class
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
      const busy = /\bEvaluating\b|\bReasoning\b|\bThinking\b|\bConsidering\b|\bWorking\b|view_image|Reviewed image|Using |Running |Generating/.test(resp.text) && resp.text === last;
      if (resp.text && resp.text === last && !busy) { stable++; if (stable >= stableNeeded) break; }
      else stable = 0;
      last = resp.text;
    }
    return resp;
  }

  const readModelLabel = () => win.evaluate(() => {
    const b = document.querySelector('.chat-input-toolbars [aria-label^="Pick Model"]');
    return b ? (b.getAttribute('aria-label') || '') : '';
  });

  // Select a Bedrock model in the chat picker (action-widget) deterministically.
  // Signed-in profiles also list Copilot models (GPT-5, a Copilot-hosted "<model> Upgrade", etc.).
  // If selection flakes, the chat silently falls back to the default Copilot model, so we MUST
  // pick the Bedrock row (grouped under the "AWS Bedrock" provider header, not "Upgrade") and
  // assert. Returns { selectedLabel, matched, rowFound }, where matched is true only when a
  // Bedrock-bound row was actually clicked AND the active-model label matches the target (a
  // reused profile could already have a same-named Copilot model active). Parameterized by
  // modelName so both the primary model stage and the Sonnet 5 temperature stage reuse the exact
  // same logic.
  async function pickModel(modelName, { attempts = 3 } = {}) {
    const matchesTarget = (s) => s.toLowerCase().includes(modelName.toLowerCase());
    let rowFound = false; // set inside pickModelOnce right after the evaluate so a later throw can't lose it
    let bedrockClicked = false;
    async function pickModelOnce() {
      let attemptRowFound = false;
      // a previous attempt that threw mid-click can leave the dropdown open; dismiss it first
      if (await win.locator('.action-widget').count()) { await win.keyboard.press('Escape').catch(() => {}); await sleep(200); }
      await clearNotifications();
      const modelBtn = win.locator('.chat-input-toolbars a.model-picker-name, .chat-input-toolbars [aria-label^="Pick Model"]').first();
      await modelBtn.click({ timeout: 5000 });
      // wait for the dropdown to actually render rather than guessing with a fixed sleep
      await win.locator('.action-widget').first().waitFor({ timeout: 5000 }).catch(() => {});
      const filter = win.locator('.action-widget input.action-list-filter-input, .action-widget input').first();
      if (await filter.count() && await filter.isVisible()) {
        await filter.fill(modelName);
        // wait for the filtered list to actually contain the target row instead of a blind sleep
        await win.locator('.action-widget .monaco-list-row').filter({ hasText: modelName }).first()
          .waitFor({ timeout: 4000 }).catch(() => {});
        // Deterministic selection by PROVIDER GROUP. In VS Code's chat model picker
        // (verified against 1.122.1): action rows are `.monaco-list-row.action` carrying the
        // label in `span.title`, the extension detail in `span.description`, and — for
        // promoted/pinned rows — the provider group name in `span.action-item-badge`. Provider
        // headers are `.monaco-list-row.separator` rows; group membership is positional (rows
        // after a labeled separator belong to it until the next separator). While filtering,
        // headers of groups with no matches are hidden, so a last-labeled-separator tracker is
        // sound. The "AWS Bedrock" header is only emitted when ≥2 provider groups coexist; when
        // Bedrock is the only provider (signed-out CI) rows render bare with no labeled separator.
        // A signed-out picker still shows a disabled Copilot "Upgrade" upsell row bearing the same
        // title as the real model (class `option-disabled`), so disabled rows are never selectable.
        const snapshot = () => win.evaluate((target) => {
          const rows = Array.from(document.querySelectorAll('.action-widget .monaco-list-row'));
          const t = target.toLowerCase();
          const info = rows.map((row) => {
            const isSeparator = row.classList.contains('separator');
            return {
              isSeparator,
              disabled: row.classList.contains('option-disabled'),
              sepLabel: isSeparator ? (row.textContent || '').trim() : '',
              title: (row.querySelector('span.title')?.textContent || '').trim(),
              badge: (row.querySelector('span.action-item-badge')?.textContent || '').trim(),
              fullText: (row.textContent || '').toLowerCase(),
            };
          });
          // tracked group per row = last non-empty separator label seen while walking in order
          const groups = [];
          let group = null;
          for (const r of info) {
            if (r.isSeparator && r.sepLabel) group = r.sepLabel;
            groups.push(group);
          }
          const isBedrock = (s) => s.toLowerCase() === 'aws bedrock';
          const hasLabeledSeparator = info.some(r => r.isSeparator && r.sepLabel);
          let pick = { index: -1 };
          for (let i = 0; i < info.length && pick.index < 0; i++) {
            const r = info[i];
            if (r.isSeparator || !r.title.toLowerCase().includes(t)) continue;
            if (r.disabled) continue;
            if (groups[i] && isBedrock(groups[i])) pick = { index: i, via: 'group', text: r.title };
          }
          for (let i = 0; i < info.length && pick.index < 0; i++) {
            const r = info[i];
            if (r.isSeparator || !r.title.toLowerCase().includes(t)) continue;
            if (r.disabled) continue;
            if (isBedrock(r.badge)) pick = { index: i, via: 'badge', text: r.title };
          }
          // sole-provider only when NO labeled separator exists: a bare title match would
          // otherwise risk hitting another provider's model in a multi-group layout.
          if (pick.index < 0 && !hasLabeledSeparator) {
            for (let i = 0; i < info.length && pick.index < 0; i++) {
              const r = info[i];
              if (r.isSeparator || !r.title.toLowerCase().includes(t)) continue;
              if (r.disabled) continue;
              if (r.badge && !isBedrock(r.badge)) continue; // promoted row from another provider
              pick = { index: i, via: 'sole-provider', text: r.title };
            }
          }
          // Playwright's hasText matches on full textContent substring and does not skip
          // separator rows, so the re-resolving locator's row set is every row whose full
          // text includes the target. occurrence = position of the picked row within that set.
          let occurrence = -1;
          if (pick.index >= 0) {
            occurrence = 0;
            for (let i = 0; i < pick.index; i++) {
              if (info[i].fullText.includes(t)) occurrence++;
            }
          }
          const debug = info.map((r, i) => ({
            sep: r.sepLabel.slice(0, 40),
            group: (groups[i] || '').slice(0, 40),
            title: r.title.slice(0, 40),
            badge: r.badge.slice(0, 40),
            dis: r.disabled ? 1 : 0,
          }));
          return { pick, occurrence, debug };
        }, modelName);
        let result = await snapshot();
        let stabilized = false;
        for (let i = 1; i < 16; i++) {
          await sleep(250);
          const next = await snapshot();
          if (JSON.stringify(next.debug) === JSON.stringify(result.debug)) { result = next; stabilized = true; break; }
          result = next;
        }
        if (!stabilized) console.log('[harness]   picker list did not stabilize; proceeding with last snapshot');
        const pick = result.pick;
        attemptRowFound = pick.index >= 0;
        if (attemptRowFound) rowFound = true; // survive a later click exception in this attempt
        console.log('[harness]   picker rows:', JSON.stringify(result.debug), '-> pick', JSON.stringify(pick));
        if (pick.index >= 0) {
          const row = win.locator('.action-widget .monaco-list-row', { hasText: modelName }).nth(result.occurrence);
          await row.scrollIntoViewIfNeeded().catch(() => {});
          // force: VS Code's context view installs a transient `context-view-pointerBlock` shield
          // over fresh dropdowns; identity is already guaranteed by the locator resolution above.
          await row.click({ force: true, timeout: 6000 });
          bedrockClicked = true;
        } else {
          console.log('[harness]   no Bedrock row matched');
        }
      }
      await sleep(700);
      if (await win.locator('.action-widget').count()) { await win.keyboard.press('Escape').catch(() => {}); await sleep(200); }
      return { label: await readModelLabel(), rowFound: attemptRowFound };
    }
    let selectedLabel = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const res = await pickModelOnce().catch((e) => { console.log('[harness]   pick attempt', attempt, 'note:', e.message); return { label: '', rowFound: false }; });
      selectedLabel = res.label;
      rowFound = rowFound || res.rowFound;
      console.log('[harness] attempt', attempt, 'active model =', JSON.stringify(selectedLabel));
      if (bedrockClicked && matchesTarget(selectedLabel)) break;
      await sleep(500);
    }
    return { selectedLabel, matched: bedrockClicked && matchesTarget(selectedLabel), rowFound };
  }

  return { shot, runCommand, pickRow, typeInputBox, clearNotifications, closeEditor, typePrompt, waitResponse, pickModel };
}
