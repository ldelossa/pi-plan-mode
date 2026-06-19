/**
 * Phase transitions — enter/exit plan mode, start execution, switch models.
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { PlanModeState } from './state.js';
import type { ThinkingLevel } from './types.js';
import { PLAN_TOOLS, EXEC_TOOLS } from './constants.js';
import { loadPlanModeConfig, type ModelPreset } from './config.js';
import { updateUI } from './ui.js';

export async function switchModel(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  preset: ModelPreset,
): Promise<boolean> {
  const model = ctx.modelRegistry.find(preset.provider, preset.id);
  if (!model) {
    ctx.ui.notify(`Model ${preset.provider}/${preset.id} not found`, 'error');
    return false;
  }
  const ok = await pi.setModel(model);
  if (!ok) {
    ctx.ui.notify(`No API key for ${preset.provider}/${preset.id}`, 'error');
    return false;
  }
  return true;
}

export async function enterPlanMode(
  state: PlanModeState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<boolean> {
  const previousThinking = pi.getThinkingLevel() as ThinkingLevel;
  const previousModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  const config = loadPlanModeConfig(ctx.cwd, ctx.isProjectTrusted());

  if (!(await switchModel(pi, ctx, config.plan.model))) {
    ctx.ui.notify('Plan mode not entered. Choose a valid plan model with /plan models.', 'error');
    return false;
  }

  state.planEnabled = true;
  state.executing = false;
  state.planDir = undefined;
  state.plan = undefined;
  state.previousThinking = previousThinking;
  state.previousModel = previousModel;
  pi.setActiveTools(PLAN_TOOLS);
  pi.setThinkingLevel(config.plan.thinking);
  ctx.ui.notify(
    `Plan mode ON — ${config.plan.model.provider}/${config.plan.model.id}:${config.plan.thinking}`,
    'info',
  );
  updateUI(state, ctx);
  state.persist(pi);
  return true;
}

export async function exitPlanMode(
  state: PlanModeState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const { previousModel, previousThinking } = state;
  state.exitPreservingPlan();
  pi.setActiveTools(EXEC_TOOLS);
  if (previousModel) {
    await switchModel(pi, ctx, previousModel);
  }
  if (previousThinking) {
    pi.setThinkingLevel(previousThinking);
  }
  ctx.ui.notify('Plan mode OFF — original model restored', 'info');
  updateUI(state, ctx);
  state.persist(pi);
}

export async function startExecution(
  state: PlanModeState,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<boolean> {
  const wasPlanEnabled = state.planEnabled;
  const config = loadPlanModeConfig(ctx.cwd, ctx.isProjectTrusted());

  if (!(await switchModel(pi, ctx, config.execute.model))) {
    state.planEnabled = wasPlanEnabled;
    state.executing = false;
    updateUI(state, ctx);
    state.persist(pi);
    ctx.ui.notify('Execution not started. Choose a valid execute model with /plan models.', 'error');
    return false;
  }

  state.planEnabled = false;
  state.executing = true;
  state.executionStartIdx = ctx.sessionManager.getEntries().length;
  pi.setActiveTools(EXEC_TOOLS);
  pi.setThinkingLevel(config.execute.thinking);
  ctx.ui.notify(
    `Executing plan — ${config.execute.model.provider}/${config.execute.model.id}:${config.execute.thinking}`,
    'info',
  );
  updateUI(state, ctx);
  state.persist(pi);
  return true;
}
