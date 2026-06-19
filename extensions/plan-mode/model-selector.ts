/**
 * Interactive model preset picker for plan-mode phase configuration.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { Container, type SelectItem, SelectList, Text } from '@earendil-works/pi-tui';
import type { ThinkingLevel } from './types.js';
import {
  formatPhaseModelConfig,
  loadPlanModeConfig,
  saveGlobalPlanModeConfig,
  type ModelPreset,
  type PhaseModelConfig,
  type PlanModeConfig,
} from './config.js';

const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

type ModelLike = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  thinkingLevelMap?: Partial<Record<(typeof THINKING_LEVELS)[number], string | null>>;
};

export async function configurePlanModeModels(ctx: ExtensionContext): Promise<void> {
  while (true) {
    const config = loadPlanModeConfig(ctx.cwd, ctx.isProjectTrusted());
    const choice = await ctx.ui.select('Plan mode models', [
      `Plan model — ${formatPhaseModelConfig(config.plan)}`,
      `Execute model — ${formatPhaseModelConfig(config.execute)}`,
      'Done',
    ]);

    if (!choice || choice === 'Done') return;

    if (choice.startsWith('Plan model')) {
      const selected = await choosePhaseModelConfig(ctx, 'Select plan model', config.plan);
      if (!selected) continue;
      saveMergedConfig({ ...config, plan: selected });
      ctx.ui.notify(`Plan model set to ${formatPhaseModelConfig(selected)}`, 'info');
      continue;
    }

    if (choice.startsWith('Execute model')) {
      const selected = await choosePhaseModelConfig(ctx, 'Select execute model', config.execute);
      if (!selected) continue;
      saveMergedConfig({ ...config, execute: selected });
      ctx.ui.notify(`Execute model set to ${formatPhaseModelConfig(selected)}`, 'info');
    }
  }
}

export async function choosePhaseModelConfig(
  ctx: ExtensionContext,
  title: string,
  current: PhaseModelConfig,
): Promise<PhaseModelConfig | undefined> {
  const model = await chooseModel(ctx, title, current.model);
  if (!model) return undefined;

  const modelInfo = findModelInfo(ctx, model);
  const thinking = await chooseThinkingLevel(ctx, `Thinking for ${model.provider}/${model.id}`, modelInfo, current.thinking);
  if (!thinking) return undefined;

  return { model, thinking };
}

export async function chooseExecutionConfigForHandoff(
  ctx: ExtensionContext,
): Promise<PhaseModelConfig | undefined> {
  const config = loadPlanModeConfig(ctx.cwd, ctx.isProjectTrusted());
  const defaultLabel = `Use configured default — ${formatPhaseModelConfig(config.execute)}`;
  const choice = await ctx.ui.select('Execute with:', [defaultLabel, 'Choose another model…', 'Cancel']);
  if (!choice || choice === 'Cancel') return undefined;
  if (choice === defaultLabel) return config.execute;
  return choosePhaseModelConfig(ctx, 'Select execute model', config.execute);
}

function saveMergedConfig(config: PlanModeConfig): void {
  // Persist the effective config globally. Project-local config and environment
  // variables can still override it at runtime if the user wants per-project or
  // shell-specific behavior.
  saveGlobalPlanModeConfig(config);
}

async function chooseModel(
  ctx: ExtensionContext,
  title: string,
  current: ModelPreset,
): Promise<ModelPreset | undefined> {
  const models = availableModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify('No models are available. Run /login or configure ~/.pi/agent/models.json.', 'error');
    return undefined;
  }

  const items: SelectItem[] = models.map((model) => {
    const value = modelKey(model);
    const active = model.provider === current.provider && model.id === current.id;
    const providerName = ctx.modelRegistry.getProviderDisplayName(model.provider) ?? model.provider;
    const details = [
      model.name && model.name !== model.id ? model.name : undefined,
      providerName !== model.provider ? providerName : undefined,
      model.reasoning ? 'reasoning' : undefined,
      model.input?.includes('image') ? 'vision' : undefined,
      model.contextWindow ? `${formatNumber(model.contextWindow)} ctx` : undefined,
      model.maxTokens ? `${formatNumber(model.maxTokens)} max` : undefined,
    ].filter(Boolean);
    return {
      value,
      label: active ? `${value} (current)` : value,
      description: details.join(' • '),
    };
  });

  const selected = await selectWithModal(ctx, title, items);
  if (!selected) return undefined;
  const [provider, ...idParts] = selected.split('/');
  return { provider, id: idParts.join('/') };
}

async function chooseThinkingLevel(
  ctx: ExtensionContext,
  title: string,
  model: ModelLike | undefined,
  current: ThinkingLevel,
): Promise<ThinkingLevel | undefined> {
  const supported = supportedThinkingLevels(model);
  const items: SelectItem[] = supported.map((level) => ({
    value: level,
    label: level === current ? `${level} (current)` : level,
    description: thinkingDescription(level),
  }));
  const selected = await selectWithModal(ctx, title, items);
  return selected as ThinkingLevel | undefined;
}

function availableModels(ctx: ExtensionContext): ModelLike[] {
  ctx.modelRegistry.refresh();
  const available = ctx.modelRegistry.getAvailable() as ModelLike[];
  const models = available.length > 0 ? available : (ctx.modelRegistry.getAll() as ModelLike[]);
  return [...models].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

function findModelInfo(ctx: ExtensionContext, preset: ModelPreset): ModelLike | undefined {
  return ctx.modelRegistry.find(preset.provider, preset.id) as ModelLike | undefined;
}

function supportedThinkingLevels(model: ModelLike | undefined): ThinkingLevel[] {
  if (!model?.reasoning) return ['off' as ThinkingLevel];
  return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null) as ThinkingLevel[];
}

function thinkingDescription(level: string): string {
  switch (level) {
    case 'off':
      return 'Disable reasoning controls for this phase';
    case 'minimal':
      return 'Smallest reasoning budget';
    case 'low':
      return 'Fast, low-cost reasoning';
    case 'medium':
      return 'Balanced planning depth';
    case 'high':
      return 'Deeper reasoning for complex work';
    case 'xhigh':
      return 'Maximum supported reasoning';
    default:
      return '';
  }
}

function modelKey(model: ModelLike): string {
  return `${model.provider}/${model.id}`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact' }).format(value);
}

async function selectWithModal(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
): Promise<string | undefined> {
  if (!ctx.hasUI) {
    const labels = items.map((item) => item.label);
    const selected = await ctx.ui.select(title, labels);
    return items.find((item) => item.label === selected)?.value as string | undefined;
  }

  const result = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((text: string) => theme.fg('accent', text)));
    container.addChild(new Text(theme.fg('accent', theme.bold(title)), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 14), {
      selectedPrefix: (text) => theme.fg('accent', text),
      selectedText: (text) => theme.fg('accent', text),
      description: (text) => theme.fg('muted', text),
      scrollInfo: (text) => theme.fg('dim', text),
      noMatch: (text) => theme.fg('warning', text),
    });
    selectList.onSelect = (item) => done(item.value as string);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);
    container.addChild(new Text(theme.fg('dim', 'type to filter • ↑↓ navigate • enter select • esc cancel'), 1, 0));
    container.addChild(new DynamicBorder((text: string) => theme.fg('accent', text)));

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return result ?? undefined;
}
