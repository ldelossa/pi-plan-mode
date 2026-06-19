/**
 * User-configurable model presets for plan/execute phases.
 *
 * Config precedence, lowest to highest:
 *   1. Built-in defaults
 *   2. ~/.pi/agent/settings.json   → piPlanMode
 *   3. <cwd>/.pi/settings.json     → piPlanMode, only when project trusted
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

export type ConfigPhase = 'plan' | 'execute';

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

export const SETTINGS_KEY = 'piPlanMode';
export const GLOBAL_SETTINGS_PATH = join(homedir(), '.pi', 'agent', 'settings.json');
export const PROJECT_SETTINGS_RELATIVE_PATH = join('.pi', 'settings.json');

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

const PLAN_ENV_KEYS = ['PI_PLAN_MODE_PLAN_PROVIDER', 'PI_PLAN_PROVIDER', 'PI_PLAN_MODE_PLAN_MODEL', 'PI_PLAN_MODEL', 'PI_PLAN_MODE_PLAN_THINKING', 'PI_PLAN_THINKING'];
const EXECUTE_ENV_KEYS = ['PI_PLAN_MODE_EXEC_PROVIDER', 'PI_EXEC_PROVIDER', 'PI_PLAN_MODE_EXEC_MODEL', 'PI_EXEC_MODEL', 'PI_PLAN_MODE_EXEC_THINKING', 'PI_EXEC_THINKING'];

type PartialConfig = Partial<{
  plan: Partial<PhaseModelConfig> & { provider?: string; id?: string; model?: Partial<ModelPreset> };
  execute: Partial<PhaseModelConfig> & { provider?: string; id?: string; model?: Partial<ModelPreset> };
  exec: Partial<PhaseModelConfig> & { provider?: string; id?: string; model?: Partial<ModelPreset> };
}>;

export function loadPlanModeConfig(cwd?: string, projectTrusted = false): PlanModeConfig {
  return applyEnvOverrides(loadPlanModeSettingsConfig(cwd, projectTrusted));
}

export function loadPlanModeSettingsConfig(cwd?: string, projectTrusted = false): PlanModeConfig {
  let config = cloneConfig(DEFAULT_PLAN_MODE_CONFIG);
  config = mergeConfig(config, readPlanModeSettings(GLOBAL_SETTINGS_PATH));
  if (cwd && projectTrusted) {
    config = mergeConfig(config, readPlanModeSettings(join(cwd, PROJECT_SETTINGS_RELATIVE_PATH)));
  }
  return config;
}

export function saveGlobalPhaseModelConfig(phase: ConfigPhase, config: PhaseModelConfig): PlanModeConfig {
  const next = loadGlobalPlanModeSettingsConfig();
  next[phase] = clonePhase(config);
  writePlanModeSettings(GLOBAL_SETTINGS_PATH, next);
  return next;
}

export function getEnvOverrideKeys(phase?: ConfigPhase): string[] {
  const keys = phase === 'plan' ? PLAN_ENV_KEYS : phase === 'execute' ? EXECUTE_ENV_KEYS : [...PLAN_ENV_KEYS, ...EXECUTE_ENV_KEYS];
  return keys.filter((key) => stringOrUndefined(process.env[key]));
}

export function formatPhaseModelConfig(config: PhaseModelConfig): string {
  return `${config.model.provider}/${config.model.id}:${config.thinking}`;
}

function loadGlobalPlanModeSettingsConfig(): PlanModeConfig {
  return mergeConfig(cloneConfig(DEFAULT_PLAN_MODE_CONFIG), readPlanModeSettings(GLOBAL_SETTINGS_PATH));
}

function cloneConfig(config: PlanModeConfig): PlanModeConfig {
  return {
    plan: clonePhase(config.plan),
    execute: clonePhase(config.execute),
  };
}

function clonePhase(config: PhaseModelConfig): PhaseModelConfig {
  return { model: { ...config.model }, thinking: config.thinking };
}

function readPlanModeSettings(path: string): PartialConfig | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const settings = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    return settings[SETTINGS_KEY] as PartialConfig | undefined;
  } catch {
    return undefined;
  }
}

function writePlanModeSettings(path: string, config: PlanModeConfig): void {
  let settings: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      settings = {};
    }
  }
  settings[SETTINGS_KEY] = config;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
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
