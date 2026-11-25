# pstack source analysis

Upstream examined: `github.com/cursor/plugins`, path `pstack/`, commit
`41e400932eca14f289e7db717a70455256b6d388` (2026-11-24), plugin version 0.15.48. Files read in full:
`skills/poteto-mode/SKILL.md`, `skills/poteto-mode/worker.md`, playbooks `bug-fix`, `feature`,
`prototype`, `refactoring`, `perf-issue`, `investigation`, `autonomous-run`, `pause-safely`,
`session-pickup`, `opening-a-pr`; skills `swarm`, `arena`, `interrogate`, `figure-it-out`,
`setup-pstack`, `show-me-your-work`, `principle-prove-it-works`; `agents/poteto-agent.md`,
`agents/comment-sicko.md`; `docs/guide/02-poteto-mode.md`; `automations/benny/README.md`;
`skills/poteto-mode/scripts/watch-pr/types.ts`. Pi was examined at 1.6.1 (installed docs and
`dist/` type declarations).

## What pstack is

pstack is a Cursor plugin made of markdown. `plugin.json` registers `./skills/` and `./agents/`.
Almost all behavior is instructions to the model. The few executable parts are TypeScript helpers:
`watch-pr` (PR/CI polling policy), `bootstrap.ts`, `worktree-audit.sh`, the statechart compiler,
and log helpers.

| Layer | Upstream evidence | Role |
|---|---|---|
| Entry point | `skills/poteto-mode/SKILL.md` (`disable-model-invocation: true`) | Single router, invoked only explicitly with `/poteto-mode` |
| Playbooks | `skills/poteto-mode/playbooks/*.md` (22) | Ordered steps per task type, copied into the todo list |
| Principles | `skills/principle-*/SKILL.md` (25) | Leaf rules, read only when applied, cited by name |
| Routed skills | `swarm`, `arena`, `interrogate`, `architect`, `figure-it-out`, `unslop`, `technical-writing`, ... | Reusable procedures that playbooks call conditionally |
| Agents | `agents/poteto-agent.md`, `comment-sicko.md` | Delegate type that re-reads the router. A comment-deletion reviewer |
| Worker contract | `skills/poteto-mode/worker.md` | Rules every delegate must read first |
| Model config | `setup-pstack` writes `~/.cursor/rules/pstack-models.mdc` | Per-role model and effort overrides |
| Automations | `automations/benny` | Slack triage and repro automations (Cursor-specific) |

## Behavioral contracts (C-ids are used in the parity matrix)

- **C1 Single explicit entry point.** `/poteto-mode <goal>` is the front door. The skill is not model-invocable.
- **C2 Restate first.** The first message restates the goal and the smallest change that meets it.
- **C3 Classify and route.** Match the task to one playbook and copy its steps into the todo list.
  Large, cross-cutting or unmatched work goes to `figure-it-out`.
- **C4 Conditional activation.** Principles and routed skills are read when their trigger applies
  ("Read the leaf skill in full for any principle you apply"). Nothing loads up front.
- **C5 Prove it works.** Verify on the real artifact. Verdicts are VERIFIED, NOT VERIFIED or
  INCONCLUSIVE, and inconclusive is not a pass (`figure-it-out` Phase C, `principle-prove-it-works`).
- **C6 Root causes, repro first.** Bug fix: reproduce on the real surface, binary-search the cause,
  stage the failing repro before the fix (`bug-fix.md` steps 1, 2, 5).
- **C7 Test behavior.** `principle-test-behavior-not-implementation`.
- **C8 Pinned contract for refactors.** Characterization first, behavior unchanged (`refactoring.md` 1, 6).
- **C9 Measured performance.** Baseline and post-fix numbers vetted with benchmark-checklist (`perf-issue.md`).
- **C10 Delegation.** Fresh `poteto-agent` per task. The first kickoff line is `Read <path>/worker.md`.
  The parent owns review ("You own every subagent's work").
- **C11 Fan-out, bakeoff, adversarial review.** `swarm` (slices, races), `arena` (N candidates,
  cross-judge, graft), `interrogate` (findings survive only if a run proves them).
- **C12 Model per role.** Role defaults, user overrides via `setup-pstack`, fallback ladders.
- **C13 Autonomy.** Proceed on reversible work. Pause only for irreversible actions. Never ask
  the human a question a run could settle. Session overrides like "don't stop" are honored.
- **C14 Long-run discipline.** `autonomous-run` (exit predicate, keep going), `show-me-your-work`
  (decision log), `pause-safely` (durable checkpoint), `session-pickup` (trust the trail).
- **C15 Reporting.** Evidence or a label for every claim. Never hand the human a check you could
  run. The reply format is specific to each playbook.
- **C16 Pre-review hygiene.** `no-comments`, `deslop`, Opening a PR format.
- **C17 Encode lessons in structure.** Repeated corrections become lints, checks or scripts.
- **C18 PR and stack operations.** `babysit`, `shipping`, `autopilot-*`, `watch-pr` policy.

## Representative workflow traces

### T1: `/poteto-mode users get two notifications after a retry. repro first, then fix and verify.`

1. `poteto-mode/SKILL.md` loads (explicit only). Non-negotiables: restate the goal (C2).
2. Playbooks section: the task matches **Bug fix**. Its 6 steps are copied into the todo list (C3).
3. `bug-fix.md` step 1: reproduce on the matching surface through `control-ui`/`control-cli`.
4. Step 2: binary-search the cause, using the `why` skill for history. Runtime evidence per split.
5. Step 3: `architect` if the fix crosses a boundary. Delegate to `poteto-agent` with the
   bug-fix model. The kickoff starts `Read <path>/worker.md` (C10).
6. Step 4: verify on the same surface. "Inconclusive is not a pass" (C5).
7. Step 5: failing repro committed before the fix (`tdd`).
8. Step 6: Opening a PR. The reply pastes failing-then-passing output (C15).
**Guarantee:** all of it is model compliance. Nothing stops a skipped step.

### T2: `/poteto-mode add CSV export to the report page`

`feature.md`: trace, `architect`, a throughput checkpoint with four todo items, delegation to a
fresh subagent with a named data shape, verification on the surface, ordered commits,
`interrogate` if the design is contested, then Opening a PR.

### T3: `/interrogate` on a diff

`interrogate/SKILL.md`: frame the intent, fan out adversaries using arena Phases A and B (one model
per vendor seat), each proving findings with a run in its own worktree. The parent reruns each
finding's command and keeps only the ones that reproduce. Findings are reported, not fixed.

### T4: interruption and resume

`pause-safely.md` writes a `wip:` commit and a resume note. `session-pickup.md` reads the trail,
diffs done against pending, and resumes without redoing work. Then it verifies inherited claims on
the real artifact.

## What changes in a Pi-native, domain-specific system

pstack relies on model compliance because Cursor gives it no hooks. Pi does: `tool_call` can block,
`agent_before_settle` can force a continuation, tools can run real commands, and
`appendEntry`/`getBranch` persist state per branch. This package moves every contract that decides
an outcome from instructions into code (C3, C5, C6, C7, C8, C9, C13, C14, C15 for the testing
domain). The judgment parts stay instructions (C2, C4, root cause analysis, test design).

Applicability limits, each detailed in the parity matrix:
- Generic engineering playbooks (feature, hillclimb, visual parity, PR babysitting, shipping,
  autopilot, worktree cleanup) do not apply to a Compose testing package. The pstack Pi kit covers
  them already, and both packages can be installed side by side.
- Subagent fan-out (C10 to C12) is not implemented in this package yet. It is the main open parity gap.
