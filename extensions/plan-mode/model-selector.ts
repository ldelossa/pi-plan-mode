/**
 * Interactive model preset picker for plan-mode phase configuration.
 */

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DynamicBorder } from '@earendil-works/pi-coding-agent';
import { Container, type SelectItem, SelectList, Text } from '@earendil-works/pi-tui';
import type { ThinkingLevel } from './types.js';
import {
  formatPhaseModelConfig,
  getEnvOverrideKeys,
  loadPlanModeConfig,
  saveGlobalPhaseModelConfig,
  type ConfigPhase,
  type ModelPreset,
  type PhaseModelConfig,
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

export interface ConfigureModelsResult {
  planChanged: boolean;
  executeChanged: boolean;
}

export async function configurePlanModeModels(ctx: ExtensionContext): Promise<ConfigureModelsResult> {
  const result: ConfigureModelsResult = { planChanged: false, executeChanged: false };

  while (true) {
    const config = loadPlanModeConfig(ctx.cwd, ctx.isProjectTrusted());
    const envKeys = getEnvOverrideKeys();
    const title = envKeys.length > 0 ? `Plan mode models (env override: ${envKeys.join(', ')})` : 'Plan mode models';
    const choice = await ctx.ui.select(title, [
      `Plan model — ${formatPhaseModelConfig(config.plan)}`,
      `Execute model — ${formatPhaseModelConfig(config.execute)}`,
      'Done',
    ]);

    if (!choice || choice === 'Done') return result;

    if (choice.startsWith('Plan model')) {
      const selected = await choosePhaseModelConfig(ctx, 'Select plan model', config.plan);
      if (!selected) continue;
      persistSelectedPhase(ctx, 'plan', selected);
      result.planChanged = true;
      continue;
    }

    if (choice.startsWith('Execute model')) {
      const selected = await choosePhaseModelConfig(ctx, 'Select execute model', config.execute);
      if (!selected) continue;
      persistSelectedPhase(ctx, 'execute', selected);
      result.executeChanged = true;
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
  if (choice === defaultLabel) {
    if (isModelUsable(ctx, config.execute.model)) return config.execute;
    ctx.ui.notify(
      `Configured execute model ${config.execute.model.provider}/${config.execute.model.id} is unavailable. Choose another model.`,
      'warning',
    );
  }
  return choosePhaseModelConfig(ctx, 'Select execute model', config.execute);
}

function persistSelectedPhase(ctx: ExtensionContext, phase: ConfigPhase, selected: PhaseModelConfig): void {
  saveGlobalPhaseModelConfig(phase, selected);
  const envKeys = getEnvOverrideKeys(phase);
  const phaseLabel = phase === 'plan' ? 'Plan' : 'Execute';
  const suffix = envKeys.length > 0 ? ` Saved, but current value is still overridden by: ${envKeys.join(', ')}` : '';
  ctx.ui.notify(`${phaseLabel} model set to ${formatPhaseModelConfig(selected)}.${suffix}`, 'info');
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

  const modelToValue = new Map<string, ModelPreset>();
  const items: SelectItem[] = models.map((model) => {
    const value = modelKey(model);
    modelToValue.set(value, { provider: model.provider, id: model.id });
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

  const selected = await selectWithFilter(ctx, title, items);
  if (!selected) return undefined;
  return modelToValue.get(selected);
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
  const selected = await selectWithFilter(ctx, title, items);
  return selected as ThinkingLevel | undefined;
}

function matchesFilter(item: SelectItem, filter: string): boolean {
  const lower = filter.toLowerCase();
  return item.value.toLowerCase().includes(lower) || item.label.toLowerCase().includes(lower);
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

function isModelUsable(ctx: ExtensionContext, preset: ModelPreset): boolean {
  const model = ctx.modelRegistry.find(preset.provider, preset.id);
  return Boolean(model && ctx.modelRegistry.hasConfiguredAuth(model));
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

async function selectWithFilter(
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
    let filterText = '';
    let currentList: SelectList | null = null;

    function buildContainer(): Container {
      const filtered = filterText ? items.filter((item) => matchesFilter(item, filterText)) : items;
      const displayItems = filtered.length > 0 ? filtered : items;
      const maxVisible = Math.min(displayItems.length, 14);

      currentList = new SelectList(displayItems, maxVisible, {
        selectedPrefix: (text) => theme.fg('accent', text),
        selectedText: (text) => theme.fg('accent', text),
        description: (text) => theme.fg('muted', text),
        scrollInfo: (text) => theme.fg('dim', text),
        noMatch: (text) => theme.fg('warning', text),
      });
      currentList.onSelect = (item) => done(item.value as string);
      currentList.onCancel = () => done(null);

      const container = new Container();
      container.addChild(new DynamicBorder((text: string) => theme.fg('accent', text)));
      container.addChild(new Text(theme.fg('accent', theme.bold(title)), 1, 0));
      container.addChild(new Text(theme.fg('dim', filterText ? `  filter: ${filterText}` : '  '), 1, 0));
      container.addChild(currentList);
      container.addChild(new Text(theme.fg('dim', 'type to filter • ↑↓ navigate • enter select • esc cancel'), 1, 0));
      container.addChild(new DynamicBorder((text: string) => theme.fg('accent', text)));
      return container;
    }

    let container = buildContainer();

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        const isNav = data.includes('\x1b') || data === '\r' || data === '\n' || data === '\x7f' || data === '\b';
        if (isNav) {
          if (data === '\x7f' || data === '\b') {
            if (filterText.length > 0) {
              filterText = filterText.slice(0, -1);
              container = buildContainer();
            }
          } else if (currentList) {
            currentList.handleInput(data);
          }
          tui.requestRender();
          return;
        }

        if (data.length === 1 && data >= ' ') {
          filterText += data;
        } else if (data.length > 1) {
          const printable = [...data].filter((c) => c >= ' ').join('');
          if (printable) filterText += printable;
        }
        container = buildContainer();
        tui.requestRender();
      },
    };
  });

  return result ?? undefined;
}
