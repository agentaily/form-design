# Subagents

Project subagents for dividing work on Agentaily Forms. Each has a single
responsibility, least-privilege tools, and communicates through **durable
artifacts** — `features/*.feature` is the contract everyone works against.

## Roster

| Agent            | Owns                                                                                | Doesn't touch                 |
| ---------------- | ----------------------------------------------------------------------------------- | ----------------------------- |
| `spec-architect` | `SPEC.md`, `features/`, `src/core` type contracts                                   | implementation, tests         |
| `designer`       | `DESIGN.md` (visual truth) + design pages in Claude Design → land via `design-sync` | product logic, tests          |
| `design-syncer`  | land a handoff you already have → code (`design-sync` skill, passive)               | behavior design               |
| `implementer`    | `src/core` bodies, app UI, `tests/unit` (inner-loop TDD)                            | features, integration/e2e, CI |
| `outer-tester`   | `tests/integration/`, `e2e/` (realize features)                                     | product code                  |
| `reviewer`       | independent adversarial review (read-only)                                          | editing code                  |
| `release-eng`    | `.github/`, Pages, Workers, Changesets, lefthook, Prettier                          | product code                  |

## Flow (double-loop TDD + PR-driven)

```
PR (task ticket) ─► worker self-triage ─► classify + route ──────┐
intent / handoff ─► spec-architect ─► features/ + contracts ─────┤
        designer ─► design (Claude Design) ─┐                     │
        design-syncer ─► land handoff ──────┴► design deltas ─────┤
                                                                  ▼
                              implementer  ◄── contract ──►  outer-tester
                          (inner loop: code + unit tests)   (outer loop: integration + e2e)
                                            └───────┬────────┘
                                                    ▼
                                              reviewer  (independent, read-only)
                                                    ▼
                                              release-eng  (CI / Pages / Workers / release)
```

## Principles

- **Contract-first**: agents hand off via artifacts (features, types, structured reports), not prose.
- **Independent verification**: `reviewer` ≠ `implementer`; reviewer is read-only and adversarial.
- **Don't split the inner loop**: the same agent (`implementer`) writes a unit's failing test and its code — red→green→refactor is too tight to hand off.
- **Least privilege**: tools encode the boundary (reviewer has no Write).
- **Parallelism needs isolation**: run concurrent implementers in git worktrees to avoid clobbering shared files.
- **Skills vs agents**: skills (`agentaily-design`, `design-sync`) are shared know-how any agent loads; agents are the workers.
- **Persistent memory**: each agent carries `memory: project` + a `# Persistent Agent Memory` block — it accrues institutional knowledge into `.claude/agent-memory/<agent>/` (per-agent, project-scoped, version-controlled & team-shared), so learnings survive across conversations.

Invoke via the Agent tool (`subagent_type: <name>`). The main loop stays the orchestrator: it decomposes by feature, routes, and reconciles conflicts.
