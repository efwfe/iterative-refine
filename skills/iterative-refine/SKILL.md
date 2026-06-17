---
name: iterative-refine
description: Run multi-agent Iterative Contextual Refinement on a hard problem. A 3-agent loop (Main Generator → Aggressive Critique → Strategic Pool with 12-15 diverse solutions) with Memory condensation forces radical reconceptualization rather than incremental polishing. Exits automatically when Critique finds zero flaws 3× in a row. Use for architecture decisions, algorithm design, hard bugs, or any task where standard approaches feel stuck.
license: Apache-2.0
metadata:
  version: "1.0"
  author: Iterative Studio (ported to Claude Code)
---

# Iterative Contextual Refinement Skill

Runs a self-terminating multi-agent loop that forces deep, paradigm-shifting solutions
rather than incremental polishing. Based on the Iterative Studio architecture.

## When to invoke

- Hard engineering problems where the first solution is probably wrong
- Architecture / design decisions needing adversarial pressure
- Algorithm optimization where the solution space is poorly understood
- Any situation where "try harder" on a single pass won't work

## How to run

**Step 1**: Collect the full task. If the user's request refers to files, read them
first and include relevant excerpts in the task string.

**Step 2**: Run the script (Node.js 18+, zero dependencies):

```bash
node ~/.claude/skills/iterative-refine/iterative_refine.mjs "TASK_HERE" --output result.md
```

Or for a longer task, write it to a temp file first:

```bash
cat > /tmp/icr_task.txt << 'EOF'
TASK_CONTENT
EOF
node ~/.claude/skills/iterative-refine/iterative_refine.mjs --file /tmp/icr_task.txt --output result.md
```

**Step 3**: After the script exits, read `result.md` and summarise the final solution
for the user.

## Environment variables

| Variable            | Default            | Purpose                        |
|---------------------|--------------------|--------------------------------|
| `ICR_MODEL`         | `claude-sonnet-4-6`| Model for all agents           |
| `ICR_MAX_TOKENS`    | `8000`             | Max tokens per agent call      |
| `ICR_MAX_ITERATIONS`| `20`               | Hard cap on loop iterations    |
| `ANTHROPIC_API_KEY` | (from env)         | Required                       |

Override example:
```bash
ICR_MODEL=claude-opus-4-8 ICR_MAX_ITERATIONS=10 node ~/.claude/skills/iterative-refine/iterative_refine.mjs "task"
```

## Architecture

```
User Task
   │
   ▼
┌─────────────────────────────────────────────────┐
│  MAIN GENERATOR                                  │
│  Generates/corrects solution with radical        │
│  open-mindedness. Must answer 5 critical         │
│  questions before revising. Can abandon the      │
│  entire previous solution.                       │
└──────────────────────┬──────────────────────────┘
                       │ generation
                       ▼
┌─────────────────────────────────────────────────┐
│  CRITIQUE AGENT  (never suggests fixes)          │
│  Asks exactly 5 questions that force             │
│  reconceptualization (not clarification).        │
│  Labels: FUNDAMENTAL FLAW / LOGICAL ERROR /      │
│  FRAMEWORK INADEQUACY.                           │
│  Provides concrete counterexamples.              │
└──────────────────────┬──────────────────────────┘
                       │ critique + 5 questions
                       ▼
┌─────────────────────────────────────────────────┐
│  STRATEGIC POOL  (Divergent Explorer)            │
│  12–15 pathways, each with a DIFFERENT final     │
│  answer. Confidence scores updated dramatically  │
│  after each critique.                            │
│                                                  │
│  Tracks consecutive "zero flaws" critiques.      │
│  Outputs <<<Exit>>> after 3 in a row.            │
└──────────────────────┬──────────────────────────┘
                       │ pool + exit signal
                       ▼
        [every 10 iterations]
┌─────────────────────────────────────────────────┐
│  MEMORY AGENT                                    │
│  Condenses iteration history into a factual,     │
│  neutral record. Resets agent histories to       │
│  prevent context overflow in long runs.          │
└─────────────────────────────────────────────────┘
```

## Key design principles (from the original project)

**Radical open-mindedness**: The Main Generator must be willing to throw away the
entire previous solution. Incremental patching of a fundamentally broken approach
is explicitly prohibited.

**Aggressive, non-prescriptive critique**: The Critique Agent identifies *what* is
wrong with precision and evidence. It never says *what to do instead* — that is the
Main Generator's job.

**Strategic pool as anti-anchoring**: 12-15 solutions all reaching *different*
conclusions prevents the system from converging on a wrong local optimum. Low-confidence
solutions are kept alive because breakthroughs often come from the unexpected path.

**Memory condensation**: Every 10 iterations the Memory Agent distills the loop into
a neutral factual record. Agent histories are then reset around this condensed context,
allowing runs of 2+ hours without context overflow.

**Self-terminating**: No human needs to decide when "done". The Strategic Pool Agent
tracks consecutive flawless critiques internally and emits `<<<Exit>>>` at 3.
