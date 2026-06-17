#!/usr/bin/env node
/**
 * Iterative Contextual Refinement CLI
 * Zero dependencies — requires Node.js 18+ (built-in fetch + ReadableStream)
 * Based on the Iterative Studio project (Apache-2.0)
 *
 * Usage:
 *   node iterative_refine.mjs "your task here"
 *   node iterative_refine.mjs --file problem.txt --output result.md
 *   echo "problem" | node iterative_refine.mjs
 */

import { createReadStream } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { createInterface } from 'readline';
import process from 'process';

// ── ANSI colours ──────────────────────────────────────────────────────────────
const R     = '\x1b[0m';
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const BLUE  = '\x1b[94m';
const GREEN = '\x1b[92m';
const YELLOW= '\x1b[93m';
const RED   = '\x1b[91m';
const MAG   = '\x1b[95m';
const CYAN  = '\x1b[96m';

// ── Config (override via env) ─────────────────────────────────────────────────
const MODEL         = process.env.ICR_MODEL         ?? 'claude-sonnet-4-6';
const MAX_TOKENS    = parseInt(process.env.ICR_MAX_TOKENS ?? '8000', 10);
let   MAX_ITERS     = parseInt(process.env.ICR_MAX_ITERATIONS ?? '20', 10);
const CONDENSE_EVERY = 10;
const API_KEY       = process.env.ANTHROPIC_API_KEY;

// ── Global stop flag ──────────────────────────────────────────────────────────
let stop = false;
process.on('SIGINT', () => {
  process.stdout.write(`\n${YELLOW}[→ interrupt — finishing current agent call]${R}\n`);
  stop = true;
});

// ── System prompts ────────────────────────────────────────────────────────────

const MAIN_SYS = `\
You are the Main Generator in an iterative refinement system.

YOUR CORE MANDATE: radical open-mindedness. The previous solution might be completely wrong
at a foundational level. You must be willing to throw it away entirely.

AFTER ITERATION 1, structure every response as:

### Part 0 — What Worked / What Didn't
Track every approach attempted, what failed and why, what showed promise.

### Part 1 — Q&A (skip only if taking a wholly new approach)
Answer each of the 5 critical questions from the Critique Agent honestly.
If any question exposes a fundamental flaw, say so explicitly, then abandon that direction.

### Part 2 — Selected Approach
Declare which solution from the Strategic Pool you will explore, or announce a novel path.
If the pool's top-confidence solutions are flawed, say so and pick a low-confidence or
entirely new approach.

### Part 3 — Solution
Implement your chosen approach fully. No placeholders.

PROHIBITIONS:
- Do NOT patch the existing solution when the critique shows it is fundamentally broken.
- Do NOT defend conclusions against counter-examples.
- Do NOT restate "I'll refine X" when the critique demands you abandon X entirely.
`;

const CRITIQUE_SYS = `\
You are the Critique Agent — a diagnostic specialist. You identify flaws; you never fix them.

SEVERITY LABELS (use these literally):
  FUNDAMENTAL FLAW — the core framework cannot produce correct results
  LOGICAL ERROR     — invalid reasoning step invalidates the conclusion
  FRAMEWORK INADEQUACY — wrong approach for this class of problem

OUTPUT FORMAT (mandatory):

## Critical Questions
Exactly 5 questions that:
- Challenge the FUNDAMENTAL approach and core assumptions, not implementation details
- Force genuine reconceptualization (not clarification or justification)
- Expose cognitive traps (anchoring, confirmation bias, sunk-cost)
- Are unanswerable by "adding more detail to the current approach"

## Counterexamples and Proofs (omit section if none)
Concrete, executable evidence that breaks the solution.

AFTER 2–3 ITERATIONS OF THE SAME CLASS OF FLAW:
Explicitly state: "The final answer/conclusion is wrong. You are confidently justifying
an incorrect result. Change the fundamental conclusion, not just the approach."
(Vary the wording each time.)

PROHIBITIONS:
- Never suggest what the correct approach is. Diagnose only.
- Never ask for "more detail" or "clarification" — only demand reconceptualization.
- Never soften fundamental flaws into cosmetic issues.
`;

const POOL_SYS = `\
You are the Strategic Pool Agent ("Divergent Explorer").

Generate and maintain a pool of 12–15 solution pathways that are GENUINELY ORTHOGONAL —
every solution must reach a DIFFERENT final answer, conclusion, or complexity class.

For each solution provide:
  ID: Short label (e.g. "Greedy Reduction", "DP with Memoization")
  Confidence: X.X  (0.0–1.0; update DRAMATICALLY based on critique feedback)
  Summary: 2–4 sentences — approach, key assumption, why it differs from others
  Final answer / conclusion / value: stated explicitly

UPDATE PROTOCOL:
- When critique reveals flaws in high-confidence solutions: drop their score significantly.
- When critique validates a low-confidence path: raise its score significantly.
- Replace definitively invalidated solutions with genuinely novel alternatives.
- Never let two solutions reach the same final answer.

QUALITY MANDATE: Every solution must be defensible and internally coherent. No filler.

EXIT MECHANISM:
Track consecutive critique sessions where the Critique Agent finds ZERO flaws.
Reset counter to 0 whenever any flaw is found.
When counter reaches 3, output ONLY this single line and nothing else:

<<<Exit>>>
`;

const MEMORY_SYS = `\
You are the Memory Agent. Produce a concise, factual, EVOLVING record of the refinement.

Sections (use exactly these headings):
  ## Attempted Approaches
  ## Identified Issues
  ## Applied Modifications
  ## Recurring Patterns
  ## Current State

RULES:
- Neutral observation language only: "the generation included X", "the critique identified Y"
- No evaluations: never write "successfully", "failed", "improved", "degraded"
- Evolve — do not append. Remove superseded observations. Keep only what remains relevant.
- Be dense: every sentence must contain a concrete fact from the iteration history.
`;

// ── Anthropic API streaming ───────────────────────────────────────────────────

/**
 * Call the Anthropic Messages API with streaming.
 * Returns the complete assistant text.
 */
async function callAnthropic(system, messages) {
  if (!API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Anthropic API ${response.status}: ${err}`);
  }

  let full = '';
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';   // keep incomplete last line

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') break;
      try {
        const evt = JSON.parse(payload);
        if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
          const text = evt.delta.text;
          process.stdout.write(text);
          full += text;
        }
      } catch {
        // ignore malformed SSE lines
      }
    }
  }

  return full;
}

// ── Agent runner ──────────────────────────────────────────────────────────────

async function runAgent(label, color, system, messages) {
  const bar = '─'.repeat(58);
  process.stdout.write(`\n${BOLD}${color}${bar}${R}\n`);
  process.stdout.write(`${BOLD}${color}▶  ${label}${R}\n`);
  process.stdout.write(`${color}${bar}${R}\n`);

  const text = await callAnthropic(system, messages);
  process.stdout.write('\n');
  return text;
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function run(task, outputPath) {
  process.stdout.write(`\n${BOLD}${CYAN}Iterative Contextual Refinement${R}\n`);
  process.stdout.write(`${DIM}Task  : ${task.slice(0, 120)}${task.length > 120 ? '…' : ''}${R}\n`);
  process.stdout.write(`${DIM}Model : ${MODEL}  |  max iterations: ${MAX_ITERS}  |  condense every: ${CONDENSE_EVERY}${R}\n`);

  /** @type {Array<{role:string,content:string}>} */
  const taskMsg  = { role: 'user', content: `Task/Problem:\n${task}` };
  let mainHist   = [taskMsg];
  let critHist   = [taskMsg];
  let poolHist   = [taskMsg];

  let generation = '';
  let critique   = '';
  let pool       = '';
  let memory     = '';
  let turnsSinceCondense = 0;
  /** @type {Array<{iteration:number,generation:string,critique:string}>} */
  const results  = [];

  for (let iter = 1; iter <= MAX_ITERS; iter++) {
    if (stop) break;

    process.stdout.write(`\n${BOLD}${'━'.repeat(60)}${R}\n`);
    process.stdout.write(`${BOLD}  ITERATION ${iter} / ${MAX_ITERS}${R}\n`);
    process.stdout.write(`${BOLD}${'━'.repeat(60)}${R}\n`);

    // ── 1. Main Generator ───────────────────────────────────────────────────
    if (iter > 1) {
      mainHist.push({
        role: 'user',
        content:
          `${critique}\n\n---\n\n## Strategic Pool\n${pool}\n\n---\n\n` +
          'Implement the next iteration. Address the critique\'s core questions. ' +
          'If the critique shows your framework is broken, abandon it entirely and ' +
          'choose a genuinely different approach from the pool or beyond it.',
      });
    }

    generation = await runAgent('MAIN GENERATOR', BLUE, MAIN_SYS, mainHist);
    mainHist.push({ role: 'assistant', content: generation });
    critHist.push({ role: 'assistant', content: generation });

    if (stop) break;

    // ── 2. Critique Agent ───────────────────────────────────────────────────
    critHist.push({ role: 'user', content: 'Critique the solution above. Be precise and aggressive. Use severity labels.' });
    critique = await runAgent('CRITIQUE AGENT', RED, CRITIQUE_SYS, critHist);
    critHist.push({ role: 'assistant', content: critique });

    if (stop) break;

    // ── 3. Strategic Pool ───────────────────────────────────────────────────
    poolHist.push({
      role: 'user',
      content:
        `## Current Generation\n${generation}\n\n## Critique\n${critique}\n\n` +
        'Update your strategic pool: adjust confidence scores dramatically based on ' +
        'the critique evidence, replace invalidated solutions with novel alternatives, ' +
        'and ensure every solution still reaches a DIFFERENT final answer.',
    });
    pool = await runAgent('STRATEGIC POOL', MAG, POOL_SYS, poolHist);
    poolHist.push({ role: 'assistant', content: pool });

    if (pool.includes('<<<Exit>>>')) {
      process.stdout.write(`\n${BOLD}${GREEN}✓ CONVERGENCE  —  Critique found zero flaws 3× in a row${R}\n\n`);
      break;
    }

    results.push({ iteration: iter, generation, critique });
    turnsSinceCondense++;

    // ── 4. Memory condensation ──────────────────────────────────────────────
    if (turnsSinceCondense >= CONDENSE_EVERY && !stop) {
      process.stdout.write(`\n${DIM}[Memory Agent — condensing ${iter} iterations …]${R}\n`);

      const recentText = results.slice(-CONDENSE_EVERY).map(r =>
        `=== Iteration ${r.iteration} ===\n` +
        `Generation (excerpt):\n${r.generation.slice(0, 800)}\n\n` +
        `Critique (excerpt):\n${r.critique.slice(0, 400)}`
      ).join('\n\n');

      const memContent =
        `Original task:\n${task}\n\n` +
        (memory ? `Previous memory:\n${memory}\n\n` : '') +
        `Recent iterations:\n${recentText}`;

      memory = await runAgent('MEMORY AGENT', DIM + YELLOW, MEMORY_SYS, [{ role: 'user', content: memContent }]);

      const memInject = { role: 'user', content: `Memory summary (what was tried and what patterns emerged):\n${memory}` };

      mainHist = [taskMsg, memInject,
        { role: 'assistant', content: generation },
        { role: 'user', content:
          `${critique}\n\n---\n\n## Strategic Pool\n${pool}\n\n---\n\nImplement the next iteration.` }];
      critHist = [taskMsg, memInject,
        { role: 'assistant', content: generation },
        { role: 'user', content: 'Critique the solution above.' },
        { role: 'assistant', content: critique }];
      poolHist = [taskMsg, memInject,
        { role: 'assistant', content: pool }];

      turnsSinceCondense = 0;
    }
  }

  // ── Final output ────────────────────────────────────────────────────────────
  const iters = results.length || 1;
  process.stdout.write(`\n${BOLD}${'═'.repeat(60)}${R}\n`);
  process.stdout.write(`${BOLD}${GREEN}FINAL SOLUTION  (after ${iters} iteration${iters !== 1 ? 's' : ''})${R}\n`);
  process.stdout.write(`${'═'.repeat(60)}\n\n`);
  process.stdout.write(generation + '\n');

  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const doc =
    `# Iterative Contextual Refinement — Result\n\n` +
    `**Task:** ${task}\n\n` +
    `**Completed:** ${ts}  |  **Iterations:** ${iters}  |  **Model:** ${MODEL}\n\n` +
    `---\n\n## Final Solution\n\n${generation}\n\n---\n\n## Last Critique\n\n${critique}\n`;

  await writeFile(outputPath, doc, 'utf8');
  process.stdout.write(`\n${GREEN}Saved → ${outputPath}${R}\n\n`);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = { task: null, file: null, output: null, iterations: null };

  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--file' || args[i] === '-f') && args[i + 1]) {
      opts.file = args[++i];
    } else if ((args[i] === '--output' || args[i] === '-o') && args[i + 1]) {
      opts.output = args[++i];
    } else if ((args[i] === '--iterations' || args[i] === '-n') && args[i + 1]) {
      opts.iterations = parseInt(args[++i], 10);
    } else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write([
        'Usage: node iterative_refine.mjs [task] [options]',
        '',
        'Options:',
        '  -f, --file PATH         Read task from file',
        '  -o, --output PATH       Save result (default: icr_<timestamp>.md)',
        '  -n, --iterations N      Max loop iterations (default: 20)',
        '  -h, --help              Show this help',
        '',
        'Env vars:',
        '  ANTHROPIC_API_KEY       Required',
        '  ICR_MODEL               Model (default: claude-sonnet-4-6)',
        '  ICR_MAX_TOKENS          Tokens per agent call (default: 8000)',
        '  ICR_MAX_ITERATIONS      Iteration cap (default: 20)',
        '',
        'Examples:',
        '  node iterative_refine.mjs "Design a lock-free queue"',
        '  node iterative_refine.mjs --file problem.txt --iterations 5',
        '  echo "Optimize this algorithm" | node iterative_refine.mjs',
      ].join('\n') + '\n');
      process.exit(0);
    } else if (!args[i].startsWith('-')) {
      opts.task = args[i];
    }
  }
  return opts;
}

async function readStdin() {
  const rl = createInterface({ input: process.stdin });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return lines.join('\n');
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.iterations) MAX_ITERS = opts.iterations;

  let task;
  if (opts.file) {
    task = (await readFile(opts.file, 'utf8')).trim();
  } else if (opts.task) {
    task = opts.task.trim();
  } else if (!process.stdin.isTTY) {
    task = (await readStdin()).trim();
  } else {
    process.stderr.write('Error: provide a task as argument, --file, or via stdin.\n');
    process.stderr.write('Run with --help for usage.\n');
    process.exit(1);
  }

  if (!task) {
    process.stderr.write('Error: empty task.\n');
    process.exit(1);
  }

  const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-').replace(/-(?=\d{2}$)/, '').slice(0, 15).replace(/-/g, '');
  const outputPath = opts.output ?? `icr_${Date.now()}.md`;

  await run(task, outputPath);
}

main().catch(err => {
  process.stderr.write(`${RED}Fatal: ${err.message}${R}\n`);
  process.exit(1);
});
