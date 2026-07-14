// STAGE: register a Bedrock model via "Chat: Manage Language Models" (no GitHub sign-in needed —
// VS Code 1.122 BYOK), which forces the provider to list its models (a real Bedrock call), then
// focus the chat view ready for prompting.

export async function run(ctx) {
  const { win, ui } = ctx;
  console.log('[harness] STAGE 02: Chat: Manage Language Models');

  await ui.runCommand('Manage Language Models');
  // wait for the provider to list its models (a Bedrock network call) before continuing
  await win.locator('.monaco-list-row', { hasText: 'Claude' }).first().waitFor({ timeout: 20000 }).catch(() => {});
  await ui.shot('models-listed');

  // Close the Language Models editor and focus the chat input
  await ui.closeEditor();
  await ui.runCommand('Chat: Focus on Chat View');
  await win.locator('.interactive-input-editor').first().waitFor({ timeout: 10000 }).catch(() => {});
  await ui.shot('chat-focused');
}
