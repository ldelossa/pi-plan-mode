# @ldelossa/pi-plan-mode

Two-phase planning workflow for [pi](https://github.com/badlogic/pi-mono).

This is a standalone fork of `@dreki-gg/pi-plan-mode` with configurable plan and execute models. Plans are persisted as files in `.plans/` for clean context handoff between phases.

## Install

```bash
pi install git:github.com/ldelossa/pi-plan-mode
```

Recommended companions:

```bash
pi install npm:@dreki-gg/pi-questionnaire
```

## What it provides

| Feature  | Name           | Notes                                          |
| -------- | -------------- | ---------------------------------------------- |
| Flag     | `--plan`       | Start pi in plan mode                          |
| Command  | `/plan [prompt]` | Enter plan mode, optionally with a starting prompt |
| Command  | `/plan resume` | Pick up an in-progress plan from disk          |
| Command  | `/plan models` / `/plan settings` | Configure plan/execute models and thinking levels |
| Command  | `/plan-models` | Open the same model configuration UI directly |
| Command  | `/plan focus <name>` | Pin a plan so tracking calls default to it (multi-plan repos) |
| Command  | `/plans`       | List/filter/sort plans                          |
| Command  | `/initiatives` | List initiatives with member-plan rollup        |
| Command  | `/todos`       | Show current plan progress                     |
| Shortcut | `Ctrl+Alt+P`   | Toggle plan mode                               |
| Tool     | `revise_plan`  | Rewrite an existing plan in place (title/handoff/tasks) |
| Tool     | `update_task`  | Mark a task done / skipped / blocked           |
| Tool     | `update_tasks` | Mark several tasks done / skipped in one call  |
| Tool     | `add_task`     | Capture a discovered follow-up (deferred)      |
| Tool     | `plan_status`  | Read-only snapshot; progress table when many plans are active |
| Tool     | `set_active_plan` | Pin a plan as active (tool form of `/plan focus`) so tracking calls target it |
| Tool     | `update_plan`  | Close/reopen a plan: done, superseded, abandoned, in-progress |
| Tool     | `submit_initiative` | Create an initiative that groups multiple plans          |
| Tool     | `update_initiative` | Close/reopen an initiative: done, superseded, abandoned, in-progress |
| Tool     | `initiative_status` | Snapshot an initiative: member plans, progress, ready/blocked |
| Tool     | `reconcile_plans` | Detect & repair drift between tasks.jsonl and the registry (plans **and** initiatives) |

## Initiatives — grouping large work

When a body of work is too large for a single plan, group it under an **initiative**.
An initiative is one level above a plan; the same projection rule applies one level up:

```
Initiative  status = projection of its member plans' statuses
   Plan     status = projection of its tasks' statuses
      Task  base state
```

An initiative is `done` when it has ≥1 member plan and every member is terminal
(`done` / `superseded` / `abandoned`). Member plans link to the initiative by name and
carry **plan-level** `depends_on` (cross-initiative allowed), so the extension can compute
*ready work* — plans whose dependencies are all `done`. `initiative_status` surfaces, per
member plan, whether it is **ready** or **blocked by** which plans — the view you want when
splitting an initiative across sessions or subagents.

```text
# 1. Create the initiative
submit_initiative(name: "auth-overhaul", title: "Auth Overhaul", overview: "...")

# 2. Submit member plans linked + ordered
submit_plan(name: "auth-schema",  initiative: "auth-overhaul")
submit_plan(name: "auth-jwt",     initiative: "auth-overhaul", depends_on_plans: ["auth-schema"])
submit_plan(name: "auth-ui",      initiative: "auth-overhaul", depends_on_plans: ["auth-jwt"])

# 3. See what's ready to pick up
initiative_status(initiative: "auth-overhaul")
```

Initiative lifecycle mirrors plans: `done` is projected automatically, while `superseded` /
`abandoned` (and reopen) are explicit via `update_initiative` with a `reason`. The `clean`
CLI archives closed initiatives the same way it archives closed plans.

### Plan lifecycle status

The registry (`.plans/plans.jsonl`) `status` is a **projection of task state**, not a
hand-maintained flag. Marking every task `done`/`skipped` (via `update_task`, in any
session or model) automatically flips the plan to `done` — completion is no longer
coupled to a formal in-session execution run.

| Status        | Meaning                                            | Active? |
| ------------- | -------------------------------------------------- | ------- |
| `in-progress` | Active, tracked, eligible for auto-resolution      | ✅      |
| `done`        | All tasks resolved                                 | —       |
| `superseded`  | Another plan absorbed the work                     | —       |
| `abandoned`   | Won't do / rejected                                | —       |

`superseded` / `abandoned` are set explicitly via `update_plan` (with a `reason`) and are
never auto-overridden by task reconciliation. Only `in-progress` plans participate in
active-plan resolution.

In repos with **many** in-progress plans, an explicit `{ plan: "<name>" }` on
`update_task` / `add_task` / `plan_status` **always** targets that plan — it is never
silently overridden by whatever plan was last submitted in the session.

## Model configuration

Open the model picker with either command:

```text
/plan models
/plan-models
```

The picker shows available Pi models in a filterable TUI list, then asks for the thinking level for that phase. Selections are persisted in Pi's global settings file under the `piPlanMode` key:

```text
~/.pi/agent/settings.json
```

Project-specific overrides are also supported, after project trust, under the same key:

```text
.pi/settings.json
```

Config shape:

```json
{
  "piPlanMode": {
    "plan": {
      "model": { "provider": "anthropic", "id": "claude-opus-4-6" },
      "thinking": "medium"
    },
    "execute": {
      "model": { "provider": "openai", "id": "gpt-5.5" },
      "thinking": "low"
    }
  }
}
```

Environment variables override config files when present:

| Env variable | Description |
| ------------ | ----------- |
| `PI_PLAN_PROVIDER` / `PI_PLAN_MODE_PLAN_PROVIDER` | Planning model provider |
| `PI_PLAN_MODEL` / `PI_PLAN_MODE_PLAN_MODEL` | Planning model ID |
| `PI_PLAN_THINKING` / `PI_PLAN_MODE_PLAN_THINKING` | Planning thinking level |
| `PI_EXEC_PROVIDER` / `PI_PLAN_MODE_EXEC_PROVIDER` | Execution model provider |
| `PI_EXEC_MODEL` / `PI_PLAN_MODE_EXEC_MODEL` | Execution model ID |
| `PI_EXEC_THINKING` / `PI_PLAN_MODE_EXEC_THINKING` | Execution thinking level |

Defaults remain `anthropic/claude-opus-4-6:medium` for planning and `openai/gpt-5.5:low` for execution.

## Workflow

### 1. Plan (configured plan model)

```text
/plan add authentication middleware with JWT support
```

The planner has access to read-only tools plus `edit`/`write` restricted to `.plans/` files. Bash is locked to a strict allowlist of safe commands.

The planner:
- Inspects the codebase using read-only tools
- Uses `questionnaire` when requirements are underspecified
- Creates `.plans/<kebab-name>/PLAN.md` with the full numbered plan
- Creates `.plans/<kebab-name>/START-PROMPT.md` — a self-contained handoff prompt with all context needed to execute without the planning conversation
- Can add supporting files in the same directory for extra context

### 2. Choose next step

When the planner finishes, a menu appears:

| Option           | Description                                                            |
| ---------------- | ---------------------------------------------------------------------- |
| **Open HANDOFF.md in `$EDITOR` and reconcile** | Edit/comment on the plan inline; after the editor closes, the planner rereads the file and calls `revise_plan` to sync `HANDOFF.md` and `tasks.jsonl` |
| **Execute Plan** | Extract todos from PLAN.md, choose the configured execution model or pick another, then start with START-PROMPT.md |
| **Provide follow-up instructions** | Open an editor for additional instructions to the planner              |
| **Stay in plan mode** | Keep the plan as-is and continue planning manually                  |
| **Exit plan mode** | Disable plan mode and restore original model                        |

### 3. Execute (configured execute model)

When **Execute Plan** is selected:
1. Todos are extracted from `PLAN.md`
2. Model switches to the configured execution model with full tool access
3. The executor starts with a **clean context window** using `START-PROMPT.md`
4. Each step must be marked with `[DONE:n]` before moving to the next
5. Progress is tracked in a widget in the status bar
6. When all steps complete, the original model and thinking level are restored

## Plan directory structure

```
.plans/
├── plans.jsonl               # Plan registry — plan status lifecycle
├── initiatives.jsonl         # Initiative registry — groups member plans
├── auth-overhaul/            # An initiative directory
│   └── INITIATIVE.md         # Initiative overview + plan breakdown
└── auth-jwt/                 # A member plan (linked by name in the registry)
    ├── HANDOFF.md            # Self-contained executor handoff
    ├── tasks.jsonl           # Tasks (gains optional initiative + plan-level depends_on)
    └── ...                   # Optional supporting files
```

### plans.json

The extension automatically maintains `.plans/plans.json` to track plan lifecycle:

```json
{
  "add-auth-middleware": {
    "status": "in-progress",
    "title": "Add Authentication Middleware with JWT Support",
    "created": "2026-05-08T12:00:00.000Z",
    "completed": null
  },
  "fix-ci-flakes": {
    "status": "done",
    "title": "Fix CI Flaky Tests",
    "created": "2026-05-07T10:00:00.000Z",
    "completed": "2026-05-07T14:30:00.000Z"
  }
}
```

Plans start as `"in-progress"` when created and are marked `"done"` when all execution steps complete. This prevents accidental deletion of in-flight plans.

## Cleaning completed plans

Use the CLI to clean closed plans (`done` / `superseded` / `abandoned`). By default it
**archives** plan directories to `.plans/.archive/<name>/` — keeping HANDOFF.md and
tasks.jsonl as a record — rather than deleting them:

```bash
# Preview what would be cleaned (no changes)
npx @ldelossa/pi-plan-mode clean --dry-run

# Archive closed plans to .plans/.archive/ and update plans.jsonl
npx @ldelossa/pi-plan-mode clean

# Permanently delete instead of archiving
npx @ldelossa/pi-plan-mode clean --purge
```

In-flight plans (`"status": "in-progress"`) are never touched. Archiving is the default so
that closing out a finished plan never silently destroys its handoff + task ledger.

### GitHub Actions

Clean done plans automatically after merge — similar to changesets:

```yaml
name: Clean Plans

on:
  push:
    branches: [main]
    paths: ['.plans/**']

jobs:
  clean:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
      - run: npx @ldelossa/pi-plan-mode clean
      - name: Commit cleanup
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add .plans/
          git diff --cached --quiet || git commit -m "chore: clean completed plans"
          git push
```

### Should you gitignore `.plans/`?

**No.** Commit your plans — they provide decision history and execution context. Use the `clean` CLI to remove done plans after merge, keeping the directory lean. Plans are execution blueprints, not permanent documentation; for lasting decisions, use ADRs.

## Footer indicators

- `📝 plan` — plan mode active (configured planning model, strict bash)
- `📋 exec 2/5` — executing plan with the configured execution model, 2 of 5 steps done

## Bash safety

In plan mode, bash is restricted to read-only commands (ls, grep, git status, cat, rg, etc.). Destructive commands (rm, mv, git commit, etc.) are blocked.

## CLI reference

```
pi-plan-mode clean [--dry-run] [--purge]
```

| Option      | Description                                                        |
| ----------- | ----------------------------------------------------------------- |
| `clean`     | Archive closed plan directories to `.plans/.archive/`, update manifest |
| `--dry-run` | Show what would be cleaned without changing anything              |
| `--purge`   | Permanently delete instead of archiving                           |
