# Iterative Refine — Claude Code Plugin

A Claude Code skill that runs **Iterative Contextual Refinement**: a self-terminating
multi-agent loop that forces radical reconceptualization rather than incremental polishing.

## Install

```bash
# Add this repo as a Claude Code plugin marketplace
claude plugin add marketplace https://github.com/efwfe/iterative-refine

# Then install the skill
claude plugin install iterative-refine
```

Or manually copy:
```bash
cp -r claude-plugin/skills/iterative-refine ~/.claude/skills/
```

## Requirements

- Node.js 18+ (zero npm dependencies — uses built-in `fetch`)
- `ANTHROPIC_API_KEY` in your environment

## Use inside Claude Code

After installing, type `/iterative-refine` and describe your problem.

## Use from the terminal

```bash
SKILL=~/.claude/skills/iterative-refine/iterative_refine.mjs

# Basic
node $SKILL "Design a lock-free MPSC queue"

# From file
node $SKILL --file problem.txt --output result.md

# Quick run (3 iterations)
node $SKILL "task" --iterations 3

# Stronger model
ICR_MODEL=claude-opus-4-8 node $SKILL "hard problem"
```

## How it works

```
User Task
   ↓
Main Generator   — generates solution; answers 5 critique questions; can scrap everything
   ↓
Critique Agent   — asks 5 reconceptualization questions; never suggests fixes
   ↓
Strategic Pool   — 12–15 pathways all with DIFFERENT final answers; tracks zero-flaw streaks
   ↓  (every 10 iterations)
Memory Agent     — condenses history to prevent context overflow in long runs
   ↓
[loop until <<<Exit>>> (3× zero flaws) or Ctrl+C]
```

## Environment variables

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Required** |
| `ICR_MODEL` | `claude-sonnet-4-6` | Model used for all 4 agents |
| `ICR_MAX_TOKENS` | `8000` | Max tokens per agent call |
| `ICR_MAX_ITERATIONS` | `20` | Hard loop cap |

## License

Apache-2.0
