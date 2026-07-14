// STAGE: image / vision. Only meaningful when signed into GitHub — Copilot Chat strips image
// attachments for any model when there's no Copilot token (image.tsx:81), so skip when signed out.

export async function run(ctx) {
  const { win, ui, signedOut } = ctx;
  ctx.results.imageText = null; // null = stage skipped

  if (signedOut) {
    console.log('[harness] STAGE 06: image / vision — SKIPPED (not signed into GitHub; Copilot Chat drops images in BYOK mode). Re-run with E2E_REUSE_PROFILE=1 using a signed-in profile.');
    return;
  }

  try {
    console.log('[harness] STAGE 06: image / vision');
    const addBtn = win.locator('.chat-input-toolbars [aria-label^="Add Context"]').first();
    await addBtn.click({ timeout: 5000 });
    // wait for the Add-Context quick pick to open rather than a blind sleep
    await win.locator('.quick-input-widget input').first().waitFor({ timeout: 5000 }).catch(() => {});
    await ui.pickRow('vision.png');
    // wait for the attachment chip to register before sending
    await win.locator('.chat-attached-context').first().waitFor({ timeout: 6000 }).catch(() => {});
    await ui.shot('attached');
    const chips = await win.evaluate(() => Array.from(document.querySelectorAll('.chat-attached-context [role=listitem], .chat-attached-context .monaco-button')).map(c => c.textContent.trim().slice(0, 30)));
    console.log('[harness] attachment chips:', JSON.stringify(chips));
    await ui.typePrompt('What exact text is written in the attached image? Reply with only that text.');
    const r = await ui.waitResponse({ maxMs: 75000, approve: true, stableNeeded: 3 });
    await ui.shot('image-response');
    ctx.results.imageText = r.text;
    console.log('[harness] IMAGE RESULT | ' + JSON.stringify(r.text.slice(0, 200)));
  } catch (e) { console.log('[harness] image stage note:', e.message); }
}
