/**
 * Plan Mode Extension — Thin orchestrator
 *
 * Two-phase workflow:
 *   1. PLAN phase  — read-only tools + submit_plan tool + medium thinking
 *   2. EXECUTE phase — full tools + update_task tool + low thinking
 *
 * Commands:
 *   /plan [prompt]  — enter plan mode
 *   /plan resume    — resume an in-progress plan from disk
 *   /plan-exec      — execute the current plan in a clean session
 *   /todos          — show current plan progress
 *   Ctrl+Alt+P      — toggle plan mode
 *
 * Flag:
 *   --plan          — start session in plan mode
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Key } from '@earendil-works/pi-tui';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PLAN_TOOLS, EXEC_TOOLS } from './constants.js';
import type { ThinkingLevel, TaskStatus } from './types.js';
import { PlanModeState } from './state.js';
import { makePlanRuntime } from '@dreki-gg/taskman';
import { loadHandoff } from '@dreki-gg/taskman';
import { readAndClearExecPending } from './exec-pending.js';
import { readTasksJsonl, writeTasksJsonl } from '@dreki-gg/taskman';
import { upsertPlanEntry, reconcilePlanStatus } from '@dreki-gg/taskman';
import { updateUI } from './ui.js';
import { buildPlanModePrompt, buildExecutionPrompt } from './prompts.js';
import { filterExecutionMessages, filterStalePlanMessages } from './context-filter.js';
import { activeTasksResolved, deferredTasks, isPlanFinalizable } from '@dreki-gg/taskman';
import { enterPlanMode, exitPlanMode, switchModel } from './phase-transitions.js';
import { resumePlan, executeInNewSession } from './resume.js';
import { loadPlanModeConfig } from './config.js';
import { configurePlanModeModels } from './model-selector.js';
import { resolveActivePlan, focusActivePlan } from './resolve-plan.js';
import { reconcileInitiativeForPlan } from '@dreki-gg/taskman';
import { collectPlanDrift } from '@dreki-gg/taskman';
import { registerSubmitPlanTool } from './tools/submit-plan.js';
import { registerSubmitInitiativeTool } from './tools/submit-initiative.js';
import { registerRevisePlanTool } from './tools/revise-plan.js';
import { registerPreviewPrototypeTool } from './tools/preview-prototype.js';
import { registerUpdateTaskTool } from './tools/update-task.js';
import { registerUpdateTasksTool } from './tools/update-tasks.js';
import { registerAddTaskTool } from './tools/add-task.js';
import { registerPlanStatusTool } from './tools/plan-status.js';
import { registerSetActivePlanTool } from './tools/set-active-plan.js';
import { registerUpdatePlanTool } from './tools/update-plan.js';
import { registerUpdateInitiativeTool } from './tools/update-initiative.js';
import { registerInitiativeStatusTool } from './tools/initiative-status.js';
import { registerReconcilePlansTool } from './tools/reconcile-plans.js';
import { isSafeCommand, isPlanPath } from './utils.js';
import { handleListPlans } from './commands/list-plans.js';
import { handleListInitiatives } from './commands/list-initiatives.js';
import { createPlanReferenceIndex } from './references/plan-index.js';
import { registerPlanReferenceAutocomplete } from './references/autocomplete.js';
import { registerPlanReferenceContext } from './references/context.js';

export default function planMode(pi: ExtensionAPI): void {
  const state = new PlanModeState();
  // Build the live Effect runtime once; all storage I/O runs through this bridge.
  const runPlanIO = makePlanRuntime();
  // Cached plan list for `@plan:<slug>` autocomplete; refreshed at session start.
  const planReferenceIndex = createPlanReferenceIndex(runPlanIO);
  let planReadyForReview = false;

  // ── Flag ──────────────────────────────────────────────────────────────────
  pi.registerFlag('plan', {
    description: 'Start in plan mode (read-only + medium thinking)',
    type: 'boolean',
    default: false,
  });

  // ── Tools ─────────────────────────────────────────────────────────────────
  registerSubmitPlanTool(pi, runPlanIO, {
    onPlanSubmitted: (dir, submittedPlan) => {
      state.planDir = dir;
      state.plan = submittedPlan;
      state.latestPlanName = submittedPlan.planName;
      planReadyForReview = true;
      state.persist(pi);
    },
  });

  registerRevisePlanTool(pi, runPlanIO, {
    resolvePlan: (opts) => resolveActivePlan(state, pi, runPlanIO, opts),
    onPlanRevised: (dir, revisedPlan) => {
      state.planDir = dir;
      state.plan = revisedPlan;
      state.latestPlanName = revisedPlan.planName;
      planReadyForReview = true;
      state.persist(pi);
    },
  });

  registerSubmitInitiativeTool(pi, runPlanIO);

  registerPreviewPrototypeTool(pi, runPlanIO);

  // Shared task-write closure: mutate the in-memory task, persist tasks.jsonl,
  // and re-derive registry status. Used by both update_task and update_tasks.
  const onTaskUpdated = async (
    taskId: string,
    status: Exclude<TaskStatus, 'pending'>,
    notes?: string,
  ) => {
    if (!state.plan || !state.planDir) return;
    const task = state.plan.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return;
    task.status = status;
    task.updated_at = new Date().toISOString();
    if (notes) task.notes = notes;
    await runPlanIO(
      writeTasksJsonl(
        state.planDir,
        {
          _type: 'meta',
          title: state.plan.title,
          plan_name: state.plan.planName,
          created_at: state.plan.tasks[0]?.created_at ?? task.updated_at,
        },
        state.plan.tasks,
      ),
    );
    // FEEDBACK #1: registry status is a projection of task state. Re-derive it
    // on every task write so completion is decoupled from in-session execution
    // — cross-session / disk-tracked task updates now close the plan too.
    await runPlanIO(
      reconcilePlanStatus(
        state.plan.planName,
        isPlanFinalizable(state.plan.tasks),
        state.plan.title,
      ),
    );
    // Project plan status up to its parent initiative (no-op when standalone).
    await runPlanIO(reconcileInitiativeForPlan(state.plan.planName));
    state.persist(pi);
  };

  registerUpdateTaskTool(pi, {
    resolvePlan: (opts) => resolveActivePlan(state, pi, runPlanIO, opts),
    onTaskUpdated,
  });

  registerUpdateTasksTool(pi, {
    resolvePlan: (opts) => resolveActivePlan(state, pi, runPlanIO, opts),
    // Coalesced batch write: mutate every task in memory first, then perform a
    // SINGLE tasks.jsonl write + ONE registry reconcile. This is the whole point
    // of update_tasks — repeated single-task writes caused file-write contention.
    onTasksUpdated: async (updates) => {
      if (!state.plan || !state.planDir) return;
      const now = new Date().toISOString();
      for (const { taskId, status, notes } of updates) {
        const task = state.plan.tasks.find((candidate) => candidate.id === taskId);
        if (!task) continue;
        task.status = status;
        task.updated_at = now;
        if (notes) task.notes = notes;
      }
      await runPlanIO(
        writeTasksJsonl(
          state.planDir,
          {
            _type: 'meta',
            title: state.plan.title,
            plan_name: state.plan.planName,
            created_at: state.plan.tasks[0]?.created_at ?? now,
          },
          state.plan.tasks,
        ),
      );
      await runPlanIO(
        reconcilePlanStatus(
          state.plan.planName,
          isPlanFinalizable(state.plan.tasks),
          state.plan.title,
        ),
      );
      await runPlanIO(reconcileInitiativeForPlan(state.plan.planName));
      state.persist(pi);
    },
  });

  registerPlanStatusTool(pi, {
    resolvePlan: (opts) => resolveActivePlan(state, pi, runPlanIO, opts),
    listInProgress: async () => {
      const rows = await runPlanIO(collectPlanDrift());
      return rows
        .filter((row) => row.registryStatus === 'in-progress')
        .map((row) => ({
          name: row.name,
          title: row.title ?? row.name,
          resolved: row.resolved ?? 0,
          total: row.total ?? 0,
        }));
    },
  });

  registerSetActivePlanTool(pi, {
    setActivePlan: (name) => focusActivePlan(state, pi, runPlanIO, name),
  });

  registerUpdatePlanTool(pi, runPlanIO);
  registerUpdateInitiativeTool(pi, runPlanIO);
  registerInitiativeStatusTool(pi, runPlanIO);
  registerReconcilePlansTool(pi, runPlanIO);

  // Attach a referenced plan (`@plan:<slug>`) as context when present in a prompt.
  registerPlanReferenceContext(pi, runPlanIO);

  registerAddTaskTool(pi, {
    resolvePlan: (opts) => resolveActivePlan(state, pi, runPlanIO, opts),
    onTaskAdded: async (task) => {
      if (!state.plan || !state.planDir) return;
      state.plan.tasks.push(task);
      await runPlanIO(
        writeTasksJsonl(
          state.planDir,
          {
            _type: 'meta',
            title: state.plan.title,
            plan_name: state.plan.planName,
            created_at: state.plan.tasks[0]?.created_at ?? task.created_at,
          },
          state.plan.tasks,
        ),
      );
      // A new deferred follow-up means the plan is no longer finalizable: re-open
      // it in the registry if it had been auto-marked done.
      await runPlanIO(
        reconcilePlanStatus(
          state.plan.planName,
          isPlanFinalizable(state.plan.tasks),
          state.plan.title,
        ),
      );
      await runPlanIO(reconcileInitiativeForPlan(state.plan.planName));
      state.persist(pi);
    },
  });

  async function configureAndApplyPlanModeModels(ctx: ExtensionContext): Promise<void> {
    const result = await configurePlanModeModels(ctx);
    const config = loadPlanModeConfig(ctx.cwd, ctx.isProjectTrusted());

    if (state.planEnabled && result.planChanged) {
      if (await switchModel(pi, ctx, config.plan.model)) {
        pi.setThinkingLevel(config.plan.thinking);
        ctx.ui.notify(`Active plan model applied — ${config.plan.model.provider}/${config.plan.model.id}:${config.plan.thinking}`, 'info');
      }
    }

    if (state.executing && result.executeChanged) {
      if (await switchModel(pi, ctx, config.execute.model)) {
        pi.setThinkingLevel(config.execute.thinking);
        ctx.ui.notify(
          `Active execute model applied — ${config.execute.model.provider}/${config.execute.model.id}:${config.execute.thinking}`,
          'info',
        );
      }
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────
  pi.registerCommand('plan', {
    description:
      'Enter plan mode, optionally with a starting prompt. "/plan resume" picks up an existing plan; "/plan edit [name]" opens the latest/named plan in $EDITOR; "/plan focus <name>" pins the active plan for tracking calls.',
    handler: async (args, ctx) => {
      const trimmed = args?.trim();
      if (trimmed === 'resume') {
        await resumePlan(state, pi, ctx, runPlanIO);
        return;
      }
      if (trimmed === 'models' || trimmed === 'settings') {
        await configureAndApplyPlanModeModels(ctx);
        return;
      }
      if (trimmed === 'edit' || trimmed?.startsWith('edit ')) {
        const name = trimmed === 'edit' ? undefined : trimmed.slice('edit'.length).trim();
        await openPlanInEditorAndReconcile(ctx, name);
        return;
      }
      // "/plan focus <name>" — pin a plan so update_task / add_task / plan_status
      // default to it without repeating { plan: "<name>" } on every call (#5).
      if (trimmed?.startsWith('focus')) {
        const name = trimmed.slice('focus'.length).trim();
        if (!name) {
          ctx.ui.notify('Usage: /plan focus <name>', 'info');
          return;
        }
        const { plan, candidates } = await focusActivePlan(state, pi, runPlanIO, name);
        if (plan) {
          state.latestPlanName = plan.planName;
          state.persist(pi);
          ctx.ui.notify(`Focused plan: ${plan.title} (${plan.planName})`, 'info');
        } else {
          const hint = candidates.length ? ` In-progress: ${candidates.join(', ')}.` : '';
          ctx.ui.notify(`No plan named "${name}".${hint}`, 'error');
        }
        return;
      }
      if (state.planEnabled || state.executing) {
        await exitPlanMode(state, pi, ctx);
        return;
      }
      if (await enterPlanMode(state, pi, ctx)) {
        if (trimmed) pi.sendUserMessage(trimmed);
      }
    },
  });

  pi.registerCommand('plan-models', {
    description: 'Configure plan/execute models and thinking levels',
    handler: async (_args, ctx) => {
      await configureAndApplyPlanModeModels(ctx);
    },
  });

  pi.registerCommand('plan-exec', {
    description: 'Execute the current plan in a clean session',
    handler: async (_args, ctx) => {
      if (!state.planDir || !state.plan) {
        ctx.ui.notify('No plan to execute.', 'error');
        return;
      }
      const taskList = state.plan.tasks.map((task) => `${task.id}. ${task.description}`).join('\n');
      const first =
        state.plan.tasks.find((task) => task.status === 'pending')?.id ?? state.plan.tasks[0]?.id;
      const kickoff = `Execute the following plan: "${state.plan.title}"\n\nTasks:\n${taskList}\n\nStart with ${first}. Call update_task after completing each task.`;
      await executeInNewSession(ctx, runPlanIO, state.planDir, state.plan, kickoff);
    },
  });

  pi.registerCommand('plans', {
    description:
      'List all plans with filtering and sorting. Usage: /plans [filter] [sort]. Filters: all, in-progress, done, superseded, abandoned. Sorts: newest, oldest, tasks, name.',
    handler: async (args, ctx) => {
      await handleListPlans(ctx, runPlanIO, args);
    },
  });

  pi.registerCommand('initiatives', {
    description:
      'List all initiatives with member-plan rollup. Usage: /initiatives [filter]. Filters: all, in-progress, done, superseded, abandoned.',
    handler: async (args, ctx) => {
      await handleListInitiatives(ctx, runPlanIO, args);
    },
  });

  pi.registerCommand('todos', {
    description: 'Show current plan progress',
    handler: async (_args, ctx) => {
      if (!state.plan || state.plan.tasks.length === 0) {
        ctx.ui.notify('No plan yet. Use /plan to start planning.', 'info');
        return;
      }
      const statusIcon = {
        pending: '○',
        done: '✓',
        skipped: '⊘',
        blocked: '✗',
        deferred: '⏸',
      } as const;
      const list = state.plan.tasks
        .map((s) => {
          const marker = s.origin === 'discovered' ? ' (discovered)' : '';
          return `${s.id}. ${statusIcon[s.status]} ${s.description}${marker}`;
        })
        .join('\n');
      ctx.ui.notify(`Plan Progress:\n${list}`, 'info');
    },
  });

  pi.registerShortcut(Key.ctrlAlt('p'), {
    description: 'Toggle plan mode',
    handler: async (ctx) => {
      if (state.planEnabled || state.executing) {
        await exitPlanMode(state, pi, ctx);
      } else {
        await enterPlanMode(state, pi, ctx);
      }
    },
  });

  // ── Event: block destructive bash + restrict writes in plan mode ──────────
  pi.on('tool_call', async (event) => {
    if (!state.planEnabled) return;

    // Block destructive bash commands
    if (event.toolName === 'bash') {
      const command = event.input.command as string;
      if (!isSafeCommand(command)) {
        return {
          block: true,
          reason: `Plan mode: command blocked. Use /plan to exit plan mode first.\nCommand: ${command}`,
        };
      }
    }

    // Restrict write to .plans/ directory only
    if (event.toolName === 'write' || event.toolName === 'edit') {
      const path = event.input.path as string;
      if (!isPlanPath(path)) {
        return {
          block: true,
          reason: `Plan mode: writes are restricted to .plans/ directory only.\nPath: ${path}`,
        };
      }
    }
  });

  // ── Event: filter context ─────────────────────────────────────────────────
  pi.on('context', async (event) => {
    if (state.planEnabled) return;
    if (state.executing && state.executionStartIdx !== undefined) {
      return { messages: filterExecutionMessages(event.messages, state.executionStartIdx) };
    }
    return { messages: filterStalePlanMessages(event.messages) };
  });

  // ── Event: inject phase prompts ───────────────────────────────────────────
  pi.on('before_agent_start', async () => {
    if (state.planEnabled) {
      return {
        message: {
          customType: 'plan-mode-context',
          content: buildPlanModePrompt(),
          display: false,
        },
      };
    }
    if (state.executing && state.plan) {
      const content = buildExecutionPrompt(state.plan);
      if (content) {
        return {
          message: { customType: 'plan-execution-context', content, display: false },
        };
      }
    }
  });

  function sendUserPrompt(ctx: ExtensionContext, prompt: string): void {
    if (ctx.isIdle()) {
      pi.sendUserMessage(prompt);
    } else {
      pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
    }
  }

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }

  async function resolvePlanForEdit(ctx: ExtensionContext, name?: string): Promise<boolean> {
    const hint = name?.trim() || state.plan?.planName || state.latestPlanName;
    let resolved = await resolveActivePlan(state, pi, runPlanIO, hint ? { name: hint } : {});

    if (!resolved.plan && !hint && resolved.candidates.length > 1) {
      const choice = await ctx.ui.select('Edit which plan?', [...resolved.candidates, 'Cancel']);
      if (!choice || choice === 'Cancel') return false;
      resolved = await resolveActivePlan(state, pi, runPlanIO, { name: choice });
    }

    if (!resolved.plan || !state.plan || !state.planDir) {
      const hintText = resolved.candidates.length ? ` Candidates: ${resolved.candidates.join(', ')}.` : '';
      ctx.ui.notify(`No plan to edit.${hintText}`, 'error');
      return false;
    }

    state.latestPlanName = state.plan.planName;
    state.persist(pi);
    return true;
  }

  async function enterPlanModeForCurrentPlan(ctx: ExtensionContext): Promise<boolean> {
    if (!state.plan || !state.planDir) return false;
    const config = loadPlanModeConfig(ctx.cwd, ctx.isProjectTrusted());
    const previousThinking = pi.getThinkingLevel() as ThinkingLevel;
    const previousModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;

    if (!(await switchModel(pi, ctx, config.plan.model))) {
      ctx.ui.notify('Could not enter plan edit mode because the configured plan model is unavailable.', 'error');
      return false;
    }

    if (!state.planEnabled && !state.executing) {
      state.previousThinking = previousThinking;
      state.previousModel = previousModel;
    }
    state.planEnabled = true;
    state.executing = false;
    state.executionStartIdx = undefined;
    pi.setActiveTools(PLAN_TOOLS);
    pi.setThinkingLevel(config.plan.thinking);
    updateUI(state, ctx);
    state.persist(pi);
    return true;
  }

  async function openPlanInEditorAndReconcile(ctx: ExtensionContext, name?: string): Promise<void> {
    if (!(await resolvePlanForEdit(ctx, name))) return;
    if (!(await enterPlanModeForCurrentPlan(ctx))) return;

    const handoffBefore = state.plan!.handoff;
    const handoffPath = join(ctx.cwd, state.planDir!, 'HANDOFF.md');
    const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
    const result = spawnSync(`${editor} ${shellQuote(handoffPath)}`, {
      stdio: 'inherit',
      shell: true,
    });

    if (result.error) {
      ctx.ui.notify(`Failed to open editor: ${result.error.message}`, 'error');
      planReadyForReview = true;
      return;
    }
    if (typeof result.status === 'number' && result.status !== 0) {
      ctx.ui.notify(`Editor exited with status ${result.status}; leaving plan unchanged.`, 'warning');
      planReadyForReview = true;
      return;
    }

    state.plan!.handoff = (await runPlanIO(loadHandoff(state.planDir!))) ?? state.plan!.handoff;
    state.persist(pi);

    const changed = state.plan!.handoff !== handoffBefore;

    if (!changed) {
      // Plan was not edited — return to the plan-ready menu so the user can
      // take another action without an unnecessary agent turn.
      planReadyForReview = true;
      ctx.ui.notify('Plan is unchanged.', 'info');
      return;
    }

    planReadyForReview = false;

    // Inject context-only instructions; the user should not see these.
    pi.sendMessage(
      {
        customType: 'plan-edit-context',
        content: [
          `I edited my plan file at ${state.planDir}/HANDOFF.md in my editor.`,
          '',
          'Read the edited HANDOFF.md and tasks.jsonl. Evaluate whether the plan text contains inline review comments, questions, or directives to change the plan.',
          '',
          'If my edits include review comments that require plan changes, reconcile them by calling revise_plan for the same plan name. If I wrote inline questions, answer them. If I gave directives (e.g. "change step 3 to use X instead of Y"), apply them.',
          '',
          'If the plan content is effectively unchanged or my edits are just minor wording, note that the plan is unchanged and suggest next steps.',
          '',
          `Plan name: "${state.plan!.planName}"`,
          '',
          'Stay in plan mode. Do not execute the plan.',
        ].join('\n'),
        display: false,
      },
      { deliverAs: 'followUp' },
    );
  }

  async function showPlanReadyMenu(ctx: ExtensionContext): Promise<void> {
    if (!state.plan || !state.planDir || !planReadyForReview) return;

    const choice = await ctx.ui.select(`Plan ready — ${state.plan.title}`, [
      'Open HANDOFF.md in $EDITOR and reconcile',
      'Execute plan',
      'Provide follow-up instructions',
      'Stay in plan mode',
      'Exit plan mode',
    ]);

    if (!choice || choice === 'Stay in plan mode') {
      planReadyForReview = false;
      return;
    }

    if (choice === 'Open HANDOFF.md in $EDITOR and reconcile') {
      await openPlanInEditorAndReconcile(ctx);
      return;
    }

    planReadyForReview = false;

    if (choice === 'Execute plan') {
      sendUserPrompt(ctx, '/plan-exec');
      return;
    }

    if (choice === 'Provide follow-up instructions') {
      const instructions = await ctx.ui.editor('Follow-up instructions for the planner:', '');
      if (instructions?.trim()) sendUserPrompt(ctx, instructions.trim());
      return;
    }

    if (choice === 'Exit plan mode') {
      await exitPlanMode(state, pi, ctx);
    }
  }

  // ── Event: agent_end — blocked tasks, completion, post-plan menu ──────────
  pi.on('agent_end', async (_event, ctx) => {
    // ── During execution: handle blocked tasks and completion ──
    if (state.executing && state.plan) {
      const blocked = state.plan.tasks.filter((s) => s.status === 'blocked');

      if (blocked.length > 0) {
        const bs = blocked[0];
        let info = bs.notes
          ? `Task ${bs.id}: ${bs.description}\nReason: ${bs.notes}`
          : `Task ${bs.id}: ${bs.description}`;

        const pausedFollowups = deferredTasks(state.plan.tasks);
        if (pausedFollowups.length > 0) {
          info += `\n\nNote: ${pausedFollowups.length} follow-up(s) captured for later review (/plan resume).`;
        }

        const choice = await ctx.ui.select(`Task blocked — ${info}\n\nWhat next?`, [
          'Skip this task',
          'Provide instructions',
          'Re-plan',
          'Abort execution',
        ]);

        if (choice === 'Skip this task') {
          bs.status = 'skipped';
          bs.updated_at = new Date().toISOString();
          await runPlanIO(
            writeTasksJsonl(
              state.planDir!,
              {
                _type: 'meta',
                title: state.plan.title,
                plan_name: state.plan.planName,
                created_at: state.plan.tasks[0]?.created_at ?? bs.updated_at,
              },
              state.plan.tasks,
            ),
          );
          updateUI(state, ctx);
          state.persist(pi);
          if (state.plan.tasks.some((s) => s.status === 'pending')) {
            pi.sendUserMessage('The blocked task has been skipped. Continue with the next task.', {
              deliverAs: 'followUp',
            });
          }
        } else if (choice === 'Provide instructions') {
          const instructions = await ctx.ui.editor('Instructions for the blocked task:', '');
          if (instructions?.trim()) {
            bs.status = 'pending';
            bs.notes = undefined;
            bs.updated_at = new Date().toISOString();
            await runPlanIO(
              writeTasksJsonl(
                state.planDir!,
                {
                  _type: 'meta',
                  title: state.plan.title,
                  plan_name: state.plan.planName,
                  created_at: state.plan.tasks[0]?.created_at ?? bs.updated_at,
                },
                state.plan.tasks,
              ),
            );
            updateUI(state, ctx);
            state.persist(pi);
            pi.sendUserMessage(
              `Retry task ${bs.id} with these additional instructions: ${instructions.trim()}`,
              { deliverAs: 'followUp' },
            );
          }
          return;
        } else if (choice === 'Re-plan') {
          if (await enterPlanMode(state, pi, ctx)) {
            pi.sendUserMessage(
              `Task ${bs.id} was blocked: ${bs.notes ?? 'no details'}. Re-analyze and create a revised plan.`,
              { deliverAs: 'followUp' },
            );
          }
          return;
        } else if (choice === 'Abort execution') {
          await exitPlanMode(state, pi, ctx);
          return;
        }
      }

      // ── Discovered follow-ups checkpoint ──
      // Active work is done but the agent captured deferred follow-ups: keep the
      // plan in-progress and inform the user, who decides via /plan resume.
      const deferred = deferredTasks(state.plan.tasks);
      if (activeTasksResolved(state.plan.tasks) && deferred.length > 0) {
        if (state.planDir) {
          await runPlanIO(
            writeTasksJsonl(
              state.planDir,
              {
                _type: 'meta',
                title: state.plan.title,
                plan_name: state.plan.planName,
                created_at: state.plan.tasks[0]?.created_at ?? new Date().toISOString(),
              },
              state.plan.tasks,
            ),
          );
        }

        const followups = deferred
          .map((s) => {
            const label = `${s.id}. ⏸ ${s.description}`;
            return s.notes ? `${label}\n   ${s.notes}` : label;
          })
          .join('\n');
        const followSummary = [
          `**Plan tasks complete — ${deferred.length} follow-up(s) discovered (kept for later)**`,
          '',
          'Run `/plan resume` to review and decide whether to implement them.',
          '',
          '## Discovered follow-ups',
          '',
          followups,
        ].join('\n');
        pi.sendMessage(
          { customType: 'plan-followups', content: followSummary, display: true },
          { triggerTurn: false },
        );

        const { previousModel: dpm, previousThinking: dpt } = state;
        state.exitPreservingPlan();
        pi.setActiveTools(EXEC_TOOLS);
        if (dpm) await switchModel(pi, ctx, dpm);
        if (dpt) pi.setThinkingLevel(dpt);
        updateUI(state, ctx);
        state.persist(pi);
        return;
      }

      // Check completion
      const allResolved = state.plan.tasks.every(
        (s) => s.status === 'done' || s.status === 'skipped',
      );
      if (allResolved) {
        if (state.planDir) {
          await runPlanIO(
            upsertPlanEntry(state.plan.planName, { status: 'done', title: state.plan.title }),
          );
          await runPlanIO(reconcileInitiativeForPlan(state.plan.planName));
          await runPlanIO(
            writeTasksJsonl(
              state.planDir,
              {
                _type: 'meta',
                title: state.plan.title,
                plan_name: state.plan.planName,
                created_at: state.plan.tasks[0]?.created_at ?? new Date().toISOString(),
              },
              state.plan.tasks,
            ),
          );
        }
        const done = state.plan.tasks.filter((s) => s.status === 'done').length;
        const skipped = state.plan.tasks.filter((s) => s.status === 'skipped').length;
        const total = state.plan.tasks.length;
        const stats =
          skipped > 0 ? `${done}/${total} done, ${skipped} skipped` : `${done}/${total} done`;

        // Build a summary of what was actually done from task notes
        const changeSummary = state.plan.tasks
          .map((s) => {
            const icon = s.status === 'done' ? '✓' : '⊘';
            const label = `${s.id}. ${icon} ${s.description}`;
            return s.notes ? `${label}\n   ${s.notes}` : label;
          })
          .join('\n');

        const summary = [
          `**Plan Complete!** ✓ — ${state.plan.title}`,
          '',
          `> ${stats}`,
          '',
          '## Summary',
          '',
          changeSummary,
        ].join('\n');

        pi.sendMessage(
          { customType: 'plan-complete', content: summary, display: true },
          { triggerTurn: false },
        );

        const { previousModel: pm, previousThinking: pt } = state;
        state.reset();
        pi.setActiveTools(EXEC_TOOLS);
        if (pm) await switchModel(pi, ctx, pm);
        if (pt) pi.setThinkingLevel(pt);
        updateUI(state, ctx);
        state.persist(pi);
        return;
      }
      return;
    }

    // During planning: once submit_plan/revise_plan succeeds, let the user
    // review, edit in $EDITOR, ask for more planning, or kick off execution.
    if (state.planEnabled && state.plan && state.planDir && planReadyForReview) {
      await showPlanReadyMenu(ctx);
    }
  });

  // ── Event: session restore ────────────────────────────────────────────────
  pi.on('session_start', async (_event, ctx) => {
    if (pi.getFlag('plan') === true) state.planEnabled = true;

    state.restore(
      ctx.sessionManager.getEntries() as Array<{ type: string; customType?: string; data?: any }>,
    );

    // Register `@plan:<slug>` autocomplete and warm its cache.
    await planReferenceIndex.refresh();
    registerPlanReferenceAutocomplete(ctx, planReferenceIndex);

    // Check for exec-pending handoff from planning session
    const pending = await runPlanIO(readAndClearExecPending());
    if (pending) {
      state.planDir = pending.planDir;
      {
        const snapshot = await runPlanIO(readTasksJsonl(pending.planDir));
        state.plan = snapshot
          ? {
              title: snapshot.meta.title,
              planName: snapshot.meta.plan_name,
              handoff: (await runPlanIO(loadHandoff(pending.planDir))) ?? '',
              tasks: snapshot.tasks,
              base_commit: snapshot.meta.base_commit,
            }
          : undefined;
      }
      if (state.plan) {
        state.latestPlanName = state.plan.planName;
        if (!(await switchModel(pi, ctx, pending.config.model))) {
          state.executing = false;
          state.planEnabled = false;
          ctx.ui.notify('Execution handoff paused because the selected model is unavailable.', 'error');
          updateUI(state, ctx);
          state.persist(pi);
          return;
        }
        state.executing = true;
        state.planEnabled = false;
        pi.setActiveTools(EXEC_TOOLS);
        pi.setThinkingLevel(pending.config.thinking as ThinkingLevel);
        updateUI(state, ctx);
        state.persist(pi);
        return;
      }
    }

    // No plan attached from this session's entries or the exec handoff, but a
    // plan may exist on disk (planning happened in another session). Attach the
    // single in-progress plan so update_task / add_task work without an
    // interactive /plan resume. Data only — does NOT enter execution mode.
    if (!state.plan) {
      await resolveActivePlan(state, pi, runPlanIO);
    }

    // Apply tool restrictions, model, and thinking level
    const config = loadPlanModeConfig(ctx.cwd, ctx.isProjectTrusted());
    if (state.planEnabled) {
      if (await switchModel(pi, ctx, config.plan.model)) {
        pi.setActiveTools(PLAN_TOOLS);
        pi.setThinkingLevel(config.plan.thinking);
      } else {
        state.planEnabled = false;
        ctx.ui.notify('Plan mode restored from session state but disabled because the plan model is unavailable.', 'error');
      }
    } else if (state.executing) {
      if (await switchModel(pi, ctx, config.execute.model)) {
        pi.setActiveTools(EXEC_TOOLS);
        pi.setThinkingLevel(config.execute.thinking);
      } else {
        state.executing = false;
        ctx.ui.notify('Execution mode restored from session state but disabled because the execute model is unavailable.', 'error');
      }
    }

    updateUI(state, ctx);
    state.persist(pi);
  });
}
