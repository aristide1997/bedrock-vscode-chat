// STAGE: select the primary Bedrock model in the chat picker and hard-assert it is active, so the
// run can never silently proceed on a fallback Copilot model. Stashes the label for verification.

export async function run(ctx) {
  const { ui, targetModel } = ctx;
  console.log('[harness] STAGE 03: pick Bedrock model:', targetModel);

  const { selectedLabel, matched } = await ui.pickModel(targetModel);
  ctx.results.selectedLabel = selectedLabel;
  ctx.results.modelMatched = matched;
  await ui.shot('model-selected');

  if (!matched) {
    throw new Error(`Could not select "${targetModel}" (active model: "${selectedLabel}"). Aborting so we never run on the wrong model.`);
  }
}
