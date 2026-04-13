#!/usr/bin/env bun
/**
 * Test: SDK Context Window & Model Resolution Verification
 *
 * Verifies that all three model tiers (opus, sonnet, haiku) resolve to valid
 * API model IDs via ANTHROPIC_DEFAULT_*_MODEL env vars, and that opus gets
 * the 1M context window via the [1m] suffix (SDK bug #35214 workaround).
 *
 * Usage:
 *   ./resources/bun run scripts/test-context-window.ts          # test all models
 *   ./resources/bun run scripts/test-context-window.ts --bug     # reproduce opus 200k bug (no env var)
 *
 * Exit codes:
 *   0 = all models resolve correctly and context windows match expectations
 *   1 = a model failed to resolve or context window mismatch
 */
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { query, type SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk';

const requireModule = createRequire(import.meta.url);
const WORKSPACE_DIR = process.cwd();

// ---------- platform setup ----------

if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
  const resourceBash = path.join(WORKSPACE_DIR, 'resources', 'msys2', 'usr', 'bin', 'bash.exe');
  const commonPaths = [
    resourceBash,
    'D:\\Program Files\\Git\\bin\\bash.exe',
    'D:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
  ];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      process.env.CLAUDE_CODE_GIT_BASH_PATH = p;
      break;
    }
  }
  if (!process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    console.error('[ERROR] Could not find git-bash! Checked:');
    commonPaths.forEach((p) => console.error(`  - ${p}`));
  }
}

function resolveClaudeCodeCli(): string {
  const sdkEntry = requireModule.resolve('@anthropic-ai/claude-agent-sdk');
  return path.join(path.dirname(sdkEntry), 'cli.js');
}

function resolveBunExecutable(): string {
  const resourceBun = path.join(
    WORKSPACE_DIR,
    'resources',
    process.platform === 'win32' ? 'bun.exe' : 'bun'
  );
  if (fs.existsSync(resourceBun)) return resourceBun;
  return 'bun';
}

// ---------- types ----------

interface ModelUsageEntry {
  contextWindow: number;
  maxOutputTokens: number;
  inputTokens: number;
  outputTokens: number;
}

interface ModelTestCase {
  alias: string;
  env: Record<string, string> | undefined;
  expectedContextWindow: number;
  description: string;
}

// ---------- test runner ----------

async function runModelTest(test: ModelTestCase): Promise<boolean> {
  console.log(`\n  Testing ${test.alias} — ${test.description}`);

  let modelUsage: Record<string, ModelUsageEntry> | null = null;

  try {
    const q = query({
      prompt: 'Say exactly: "ok"',
      options: {
        model: test.alias,
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowedTools: [],
        executable: resolveBunExecutable(),
        pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        cwd: WORKSPACE_DIR,
        env: test.env,
      }
    });

    for await (const msg of q) {
      if (msg.type === 'result' && msg.subtype === 'success') {
        modelUsage = (msg as SDKResultSuccess).modelUsage ?? null;
      } else if (msg.type === 'result' && msg.subtype === 'error') {
        console.error(`  FAIL [${test.alias}]: SDK returned error:`, msg.errors);
        return false;
      }
    }
  } catch (err) {
    console.error(`  FAIL [${test.alias}]: Query threw:`, err);
    return false;
  }

  if (!modelUsage) {
    console.error(`  FAIL [${test.alias}]: modelUsage was null`);
    return false;
  }

  const entries = Object.entries(modelUsage);
  if (entries.length === 0) {
    console.error(`  FAIL [${test.alias}]: modelUsage was empty`);
    return false;
  }

  const [resolvedModel, usage] = entries[0];
  const actual = usage.contextWindow;

  console.log(`    Resolved model : ${resolvedModel}`);
  console.log(`    Context window : ${actual}`);
  console.log(`    Expected       : ${test.expectedContextWindow}`);

  if (actual === test.expectedContextWindow) {
    console.log(`  PASS [${test.alias}]`);
    return true;
  } else {
    console.error(`  FAIL [${test.alias}]: expected ${test.expectedContextWindow}, got ${actual}`);
    return false;
  }
}

// ---------- main ----------

async function main() {
  const bugMode = process.argv.includes('--bug');

  const sdkPkg = JSON.parse(
    fs.readFileSync(
      path.join(WORKSPACE_DIR, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
      'utf-8'
    )
  );

  console.log('');
  console.log('========================================');
  console.log(' SDK Context Window & Model Resolution');
  console.log('========================================');
  console.log(`  SDK version : ${sdkPkg.version}`);
  console.log(`  Mode        : ${bugMode ? '--bug (reproduce opus 200k bug)' : 'default (verify all models)'}`);

  // In --bug mode, only test opus without the env var override to reproduce the bug.
  // In default mode, test all three models with the env vars the Electron app sets.
  const tests: ModelTestCase[] = bugMode
    ? [
        {
          alias: 'opus',
          env: undefined,
          expectedContextWindow: 200_000,
          description: 'no env override — expect 200k (SDK bug #35214)'
        }
      ]
    : [
        {
          alias: 'opus',
          env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6[1m]' },
          expectedContextWindow: 1_000_000,
          description: 'env override with [1m] — expect 1M'
        },
        {
          alias: 'sonnet',
          env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-6' },
          expectedContextWindow: 200_000,
          description: 'full model ID via env — expect 200k'
        },
        {
          alias: 'haiku',
          env: { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5-20251001' },
          expectedContextWindow: 200_000,
          description: 'full model ID via env — expect 200k'
        }
      ];

  let allPassed = true;

  for (const test of tests) {
    const passed = await runModelTest(test);
    if (!passed) allPassed = false;
  }

  // ---------- summary ----------

  console.log('');
  console.log('========================================');

  if (allPassed) {
    if (bugMode) {
      console.log('PASS: SDK bug #35214 confirmed — opus without [1m] reports 200k');
      console.log('');
      console.log('Run without --bug to verify the fix for all models:');
      console.log('  ./resources/bun run scripts/test-context-window.ts');
    } else {
      console.log(`PASS: All ${tests.length} models resolved correctly`);
      console.log('');
      console.log('  opus   → claude-opus-4-6[1m]        → 1M context');
      console.log('  sonnet → claude-sonnet-4-6           → 200k context');
      console.log('  haiku  → claude-haiku-4-5-20251001   → 200k context');
    }
    process.exit(0);
  } else {
    console.log('FAIL: One or more models did not resolve correctly');
    console.log('Check buildClaudeSessionEnv() and DEFAULT_ANTHROPIC_MODELS in config.ts');
    process.exit(1);
  }
}

main();
