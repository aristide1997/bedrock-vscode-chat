// E2E orchestrator for the Bedrock VS Code extension. Sets up a real VS Code driven over CDP
// (see lib/harness.mjs), runs each stage in order (see stages/), then verifies everything from
// the on-disk "Bedrock Chat" output-channel log. This file only wires things together — the
// behavior lives in lib/ and stages/.
//
// Run:  node e2e/run.mjs   (needs AWS_BEARER_TOKEN_BEDROCK in env or ../.env; skips cleanly if
//                           absent). See e2e/README.md for the full env-var list and caveats.

import { setup, teardown } from './lib/harness.mjs';
import { bedrockChatLogDelta, classifyTemperatureStage } from './lib/verify.mjs';
import * as auth from './stages/01-auth.mjs';
import * as models from './stages/02-models.mjs';
import * as selectModel from './stages/03-select-model.mjs';
import * as text from './stages/04-text.mjs';
import * as tool from './stages/05-tool.mjs';
import * as image from './stages/06-image.mjs';
import * as sonnet5 from './stages/07-temp-sonnet5.mjs';

const STAGES = [auth, models, selectModel, text, tool, image, sonnet5];

// Deterministic, CI-grade verification. Source of truth = the on-disk "Bedrock Chat" log +
// captured per-stage results. No screenshots/DOM scraping in the pass/fail path.
function finalize(ctx) {
  const { checks, results, targetModel, signedOut, userDataDir, sessionLogStart } = ctx;
  const log = bedrockChatLogDelta(userDataDir, sessionLogStart);

  const served = /Using API key authentication/.test(log) && /Starting streaming request/.test(log);
  // image part reached the Bedrock provider: converter logs it, or it appears in a user message
  const imageInRequest = /Added image block/.test(log) ||
    /Bedrock message \d+ \(user\): \[[^\]]*"image"[^\]]*\]/.test(log);
  const tool_ = results.tool || {};
  const stageStreamed = (snap) => !!snap && /Finished processing stream/.test(bedrockChatLogDelta(userDataDir, snap));

  checks.add('Bedrock provider served requests (API-key auth + streaming in this session\'s log)', served);
  checks.add(`active model was the Bedrock ${targetModel} (asserted at selection)`, results.modelMatched === true);
  checks.add('text reply contains BEDROCK_E2E_OK', /BEDROCK_E2E_OK/.test(results.text?.text || ''));
  checks.add('text request served by Bedrock (stream completed in its log delta)', stageStreamed(results.text?.logSnapshot));
  checks.add('tool call created TOOLCALL.txt = TOOLCALL_OK', tool_.fileCreated && tool_.toolContent === 'TOOLCALL_OK');
  checks.add('tool request served by Bedrock (stream completed in its log delta)', stageStreamed(tool_.logSnapshot));

  if (signedOut) {
    checks.skip('image stage skipped (signed out — expected, Copilot strips images)');
  } else {
    checks.add('image delivered to Bedrock (image part in request log)', imageInRequest);
    checks.add('image reply contains VISION_OK_42', /VISION_OK_42/.test(results.imageText || ''));
  }

  // Sonnet 5 temperature regression (#21). PASS on a real stream; SKIP only when temperature
  // can't be exercised (no Bedrock row in the picker, or an auth/SCP deny that short-circuits
  // before request-body validation); FAIL on the temperature ValidationException or anything else.
  const s5 = results.sonnet5;
  const s5Name = 'Claude Sonnet 5 accepted request (streamed, no temperature ValidationException)';
  if (!s5 || s5.skipped) {
    checks.skip('Claude 5 temperature stage skipped (no Bedrock Sonnet 5 row in the model picker)');
  } else {
    const { verdict, reason } = classifyTemperatureStage({
      replyText: s5.replyText,
      delta: bedrockChatLogDelta(userDataDir, s5.logSnapshot),
      token: sonnet5.TOKEN,
    });
    if (verdict === 'pass') checks.add(`${s5Name} — ${reason}`, true);
    else if (verdict === 'skip') checks.skip(`Claude 5 temperature stage skipped (${reason})`);
    else checks.add(`${s5Name} — ${reason}`, false);
  }

  return checks.report({ log });
}

let exitCode = 0;
try {
  const ctx = await setup();
  if (!ctx) {
    // no credentials → skip cleanly (exit 0)
  } else {
    for (const stage of STAGES) {
      await stage.run(ctx);
    }
    await ctx.ui.shot('final');
    exitCode = finalize(ctx);
    console.log('[harness] DONE (stages 01-07)');
  }
} catch (e) {
  console.error('[harness] FAILED:', e.message || e);
  exitCode = 1;
} finally {
  await teardown();
  process.exit(exitCode);
}
