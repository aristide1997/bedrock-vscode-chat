// STAGE: configure API-key auth + region through the extension's own "Manage AWS Bedrock
// Provider" UI (never by hand-editing settings), then dump the resulting bedrock settings.

import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

export async function run(ctx) {
  const { ui, key, region, userDataDir } = ctx;
  console.log('[harness] STAGE 01: configure API key + region via bedrock.manage');

  await ui.runCommand('Manage AWS Bedrock Provider');
  await ui.shot('manage-menu');
  await ui.pickRow('Set Authentication Method');
  await ui.shot('auth-method-menu');
  await ui.pickRow('API Key');
  await ui.shot('apikey-inputbox');
  await ui.typeInputBox(key);
  await ui.shot('apikey-saved');

  // set region (default eu-central-1: has the Claude Haiku 4.5 inference profile + verified key)
  await ui.runCommand('Manage AWS Bedrock Provider');
  await ui.pickRow('Set Region');
  await ui.pickRow(region);
  await ui.shot('region-saved');

  // dump the resulting settings.json for verification (key scrubbed)
  const settingsFile = join(userDataDir, 'User', 'settings.json');
  if (existsSync(settingsFile)) {
    const writtenSettings = readFileSync(settingsFile, 'utf8');
    console.log('[harness] bedrock settings now:\n' + writtenSettings.split('\n')
      .filter(l => /bedrock|authMethod|region|apiKey/.test(l)).join('\n')
      .replace(key, '<KEY:' + key.length + 'chars>'));
  }
}
