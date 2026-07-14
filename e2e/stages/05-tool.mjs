// STAGE: tool call — the agent creates a file via its file-editing tools. File-editing tools are
// only offered in Agent mode, so assert Agent mode first (fail fast) before prompting.

import { join } from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { snapshotBedrockChatLog } from '../lib/verify.mjs';

export async function run(ctx) {
  const { win, ui, workDir, userDataDir } = ctx;
  console.log('[harness] STAGE 05: tool call');

  // The mode picker (.chat-mode-picker-item) renders the CURRENT mode as a codicon (vscode 1.122
  // chatModes.ts: Agent=codicon-agent, Ask=codicon-question, Edit=codicon-edit). NB: the button's
  // aria-label is the static action tooltip and does NOT reflect the current mode — key off the icon.
  const modeState = await win.evaluate(() => {
    const btn = document.querySelector('.chat-mode-picker-item a.action-label');
    if (!btn) return { found: false };
    const icon = btn.querySelector('span.codicon');
    return {
      found: true,
      iconCls: icon ? String(icon.className) : '(no codicon)',
      isAgent: !!icon && /\bcodicon-agent\b/.test(String(icon.className)),
    };
  });
  if (!modeState.found) {
    throw new Error('STAGE 05: chat mode picker (.chat-mode-picker-item) not found — cannot confirm Agent mode; aborting before tool stage.');
  }
  if (!modeState.isAgent) {
    throw new Error(`STAGE 05: chat is NOT in Agent mode (mode icon="${modeState.iconCls}", expected codicon-agent). File-editing tools are only offered to the model in Agent mode; aborting so the tool stage never runs in a mode that cannot succeed.`);
  }
  console.log('[harness] Agent mode confirmed (icon=' + modeState.iconCls + ')');

  const logSnapshot = snapshotBedrockChatLog(userDataDir);
  await ui.typePrompt('Using your file editing tools, create a new file named TOOLCALL.txt in the workspace whose only content is the text TOOLCALL_OK. Do it now.');
  const r = await ui.waitResponse({ maxMs: 60000, approve: true });
  await ui.shot('tool-response');

  const toolFile = join(workDir, 'TOOLCALL.txt');
  const fileCreated = existsSync(toolFile);
  const toolContent = fileCreated ? readFileSync(toolFile, 'utf8').trim() : '';
  ctx.results.tool = { tools: r.tools, fileCreated, toolContent, logSnapshot };
  console.log('[harness] TOOL RESULT toolInvocationParts=' + r.tools +
    ' | fileCreated=' + fileCreated +
    (fileCreated ? ' | content=' + JSON.stringify(toolContent) : '') +
    ' | workDir=' + JSON.stringify(readdirSync(workDir)));
}
