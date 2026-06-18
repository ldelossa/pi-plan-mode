/**
 * User-configurable model presets for plan/execute phases.
 *
 * Config precedence, lowest to highest:
 *   1. Built-in defaults
 *   2. ~/.pi/agent/pi-plan-mode.json
 *   3. <cwd>/.pi/pi-plan-mode.json
 *   4. Environment variables
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ThinkingLevel } from './types.js';

export interface ModelPreset {
  provider: string;
  id: string;
}

export interface PhaseModelConfig {
  model: ModelPreset;
  thinking: ThinkingLevel;
}

export interface PlanModeConfig {
  plan: PhaseModelConfig;
  execute: PhaseModelConfig;
}

export const DEFAULT_PLAN_MODE_CONFIG: PlanModeConfig = {
  plan: {
    model: { provider: 'anthropic', id: 'claude-opus-4-6' },
    thinking: 'medium' as ThinkingLevel,
  },
  execute: {
    model: { provider: 'openai', id: 'gpt-5.5' },
    thinking: 'low' as ThinkingLevel,
  },
};

export const GLOBAL_CONFIG_PATH = join(homedir(), '.pi', 'agent', 'pi-plan-mode.json');
export const PROJECT_CONFIG_RELATIVE_PATH = join('.pi', 'pi-plan-mode.json');

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

type PartialConfig = Partial<{
  plan: Partial<PhaseModelConfig> & { provider?: string; id?: string; model?: Partial<ModelPreset> };
  execute: Partial<PhaseModelConfig> & { provider?: string; id?: string; model?: Partial<ModelPreset> };
  exec: Partial<PhaseModelConfig> & { provider?: string; id?: string; model?: Partial<ModelPreset> };
}>;

export function loadPlanModeConfig(cwd?: string): PlanModeConfig {
  let config = cloneConfig(DEFAULT_PLAN_MODE_CONFIG);
  config = mergeConfig(config, readConfigFile(GLOBAL_CONFIG_PATH));
  if (cwd) config = mergeConfig(config, readConfigFile(join(cwd, PROJECT_CONFIG_RELATIVE_PATH)));
  return applyEnvOverrides(config);
}

export function saveGlobalPlanModeConfig(config: PlanModeConfig): void {
  mkdirSync(dirname(GLOBAL_CONFIG_PATH), { recursive: true });
  writeFileSync(GLOBAL_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export function formatPhaseModelConfig(config: PhaseModelConfig): string {
  return `${config.model.provider}/${config.model.id}:${config.thinking}`;
}

function cloneConfig(config: PlanModeConfig): PlanModeConfig {
  return {
    plan: { model: { ...config.plan.model }, thinking: config.plan.thinking },
    execute: { model: { ...config.execute.model }, thinking: config.execute.thinking },
  };
}

function readConfigFile(path: string): PartialConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as PartialConfig;
  } catch {
    return undefined;
  }
}

function mergeConfig(base: PlanModeConfig, override: PartialConfig | undefined): PlanModeConfig {
  if (!override) return base;
  return {
    plan: mergePhase(base.plan, override.plan),
    execute: mergePhase(base.execute, override.execute ?? override.exec),
  };
}

function mergePhase(
  base: PhaseModelConfig,
  override: PartialConfig['plan'] | PartialConfig['execute'] | undefined,
): PhaseModelConfig {
  if (!override) return base;
  const provider = stringOrUndefined(override.model?.provider) ?? stringOrUndefined(override.provider);
  const id = stringOrUndefined(override.model?.id) ?? stringOrUndefined(override.id);
  const thinking = parseThinkingLevel(override.thinking);
  return {
    model: {
      provider: provider ?? base.model.provider,
      id: id ?? base.model.id,
    },
    thinking: thinking ?? base.thinking,
  };
}

function applyEnvOverrides(config: PlanModeConfig): PlanModeConfig {
  const next = cloneConfig(config);

  next.plan.model.provider =
    readEnv('PI_PLAN_MODE_PLAN_PROVIDER') ?? readEnv('PI_PLAN_PROVIDER') ?? next.plan.model.provider;
  next.plan.model.id = readEnv('PI_PLAN_MODE_PLAN_MODEL') ?? readEnv('PI_PLAN_MODEL') ?? next.plan.model.id;
  next.plan.thinking =
    parseThinkingLevel(readEnv('PI_PLAN_MODE_PLAN_THINKING') ?? readEnv('PI_PLAN_THINKING')) ??
    next.plan.thinking;

  next.execute.model.provider =
    readEnv('PI_PLAN_MODE_EXEC_PROVIDER') ?? readEnv('PI_EXEC_PROVIDER') ?? next.execute.model.provider;
  next.execute.model.id =
    readEnv('PI_PLAN_MODE_EXEC_MODEL') ?? readEnv('PI_EXEC_MODEL') ?? next.execute.model.id;
  next.execute.thinking =
    parseThinkingLevel(readEnv('PI_PLAN_MODE_EXEC_THINKING') ?? readEnv('PI_EXEC_THINKING')) ??
    next.execute.thinking;

  return next;
}

function readEnv(name: string): string | undefined {
  return stringOrUndefined(process.env[name]);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return THINKING_LEVELS.has(normalized) ? (normalized as ThinkingLevel) : undefined;
}
