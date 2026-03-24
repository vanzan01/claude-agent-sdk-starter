#!/usr/bin/env bun
/**
 * Test: SDK Context Window Verification
 *
 * Validates that the SDK correctly reports 1M context window for Opus/Sonnet 4.6.
 *
 * Background (SDK bug #35214):
 *   The SDK's internal sM() function only returns 1M when the model string
 *   contains "[1m]". Without it, even claude-opus-4-6 falls back to 200k.
 *   The app passes model: 'opus' (short alias) to the SDK, so we must set
 *   ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6[1m] in the env to get 1M.
 *
 * This test runs 4 scenarios and asserts expected context window values:
 *   1. 'opus' with no env override            → 200k (SDK bug baseline)
 *   2. 'opus' + ANTHROPIC_DEFAULT_OPUS_MODEL   → 1M   (our workaround)
 *   3. 'claude-opus-4-6' (no [1m] suffix)     → 200k (SDK bug baseline)
 *   4. 'claude-opus-4-6[1m]' (with suffix)    → 1M   (direct fix)
 *
 * Run: ./resources/bun run scripts/test-context-window.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { query } from '@anthropic-ai/claude-agent-sdk';

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

interface TestCase {
  name: string;
  modelId: string;
  env?: Record<string, string>;
  expectedContextWindow: number;
}

interface TestResult {
  name: string;
  modelId: string;
  resolvedModelKey: string;
  contextWindow: number | null;
  expected: number;
  passed: boolean;
  error?: string;
}

// ---------- test runner ----------

async function runTestCase(tc: TestCase): Promise<TestResult> {
  const fail = (reason: string): TestResult => ({
    name: tc.name,
    modelId: tc.modelId,
    resolvedModelKey: '-',
    contextWindow: null,
    expected: tc.expectedContextWindow,
    passed: false,
    error: reason
  });

  try {
    const q = query({
      prompt: 'Say exactly: "ok"',
      options: {
        model: tc.modelId,
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowedTools: [],
        executable: resolveBunExecutable(),
        pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        cwd: WORKSPACE_DIR,
        env: tc.env,
      }
    });

    let modelUsage: Record<string, ModelUsageEntry> | null = null;

    for await (const msg of q) {
      if (msg.type === 'result') {
        modelUsage = (msg as any).modelUsage ?? null;
      } else if (msg.type === 'error') {
        return fail(String((msg as any).error));
      }
    }

    if (!modelUsage) {
      return fail('modelUsage was null — SDK did not return usage data');
    }

    const entries = Object.entries(modelUsage);
    if (entries.length === 0) {
      return fail('modelUsage was empty');
    }

    // Take the first (and typically only) entry
    const [resolvedKey, usage] = entries[0];
    const passed = usage.contextWindow === tc.expectedContextWindow;

    return {
      name: tc.name,
      modelId: tc.modelId,
      resolvedModelKey: resolvedKey,
      contextWindow: usage.contextWindow,
      expected: tc.expectedContextWindow,
      passed
    };
  } catch (err) {
    return fail(String(err));
  }
}

// ---------- main ----------

async function main() {
  const sdkPkg = JSON.parse(
    fs.readFileSync(
      path.join(WORKSPACE_DIR, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'),
      'utf-8'
    )
  );

  console.log('');
  console.log('========================================');
  console.log(' SDK Context Window Verification Test');
  console.log('========================================');
  console.log(`  SDK version : ${sdkPkg.version}`);
  console.log(`  CLI path    : ${resolveClaudeCodeCli()}`);
  console.log(`  Bun path    : ${resolveBunExecutable()}`);
  console.log('');

  const tests: TestCase[] = [
    {
      name: '1. opus (bare alias, no env override)',
      modelId: 'opus',
      expectedContextWindow: 200_000
    },
    {
      name: '2. opus + ANTHROPIC_DEFAULT_OPUS_MODEL env var [OUR FIX]',
      modelId: 'opus',
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6[1m]' },
      expectedContextWindow: 1_000_000
    },
    {
      name: '3. claude-opus-4-6 (full ID, no [1m] suffix)',
      modelId: 'claude-opus-4-6',
      expectedContextWindow: 200_000
    },
    {
      name: '4. claude-opus-4-6[1m] (full ID with suffix)',
      modelId: 'claude-opus-4-6[1m]',
      expectedContextWindow: 1_000_000
    }
  ];

  const results: TestResult[] = [];

  for (const tc of tests) {
    console.log(`Running: ${tc.name}`);
    const result = await runTestCase(tc);
    results.push(result);

    if (result.error) {
      console.log(`  ERROR: ${result.error}\n`);
    } else {
      const icon = result.passed ? 'PASS' : 'FAIL';
      console.log(
        `  ${icon}: ${result.resolvedModelKey} → contextWindow=${result.contextWindow} (expected ${result.expected})\n`
      );
    }
  }

  // ---------- summary ----------

  console.log('========================================');
  console.log(' RESULTS');
  console.log('========================================');
  console.log('');

  const col1 = 55;
  const col2 = 30;
  const col3 = 15;
  const col4 = 15;
  console.log(
    'Test'.padEnd(col1) +
    'Resolved Model'.padEnd(col2) +
    'Context'.padEnd(col3) +
    'Expected'.padEnd(col4) +
    'Status'
  );
  console.log('-'.repeat(col1 + col2 + col3 + col4 + 6));

  for (const r of results) {
    const cw = r.contextWindow !== null ? String(r.contextWindow) : 'ERROR';
    const status = r.error ? `ERR: ${r.error.slice(0, 30)}` : r.passed ? 'PASS' : 'FAIL';
    console.log(
      r.name.padEnd(col1) +
      r.resolvedModelKey.padEnd(col2) +
      cw.padEnd(col3) +
      String(r.expected).padEnd(col4) +
      status
    );
  }

  console.log('');

  // ---------- assertions ----------

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;

  console.log(`${passed}/${results.length} passed, ${failed} failed`);
  console.log('');

  // The critical assertion: test 2 (our workaround) MUST pass
  const workaroundTest = results[1];
  if (!workaroundTest.passed) {
    console.log('CRITICAL FAILURE: The ANTHROPIC_DEFAULT_OPUS_MODEL env var workaround');
    console.log('did NOT produce 1M context window. The fix in buildClaudeSessionEnv()');
    console.log('will NOT prevent early compaction.');
    console.log('');
    process.exit(1);
  }

  // Tests 1 and 3 are expected to fail (they document the SDK bug)
  // Test 4 is the direct model ID fix (also should pass)
  const directTest = results[3];
  if (!directTest.passed) {
    console.log('FAILURE: Passing claude-opus-4-6[1m] directly did NOT produce 1M.');
    console.log('The SDK [1m] suffix detection may have changed.');
    console.log('');
    process.exit(1);
  }

  if (failed === 0) {
    console.log('ALL TESTS PASSED');
    console.log('');
    console.log('Confirmed:');
    console.log('  - SDK bug #35214 is present (tests 1,3 show 200k without workaround)');
    console.log('  - Env var workaround works  (test 2 shows 1M with ANTHROPIC_DEFAULT_OPUS_MODEL)');
    console.log('  - Direct [1m] suffix works  (test 4 shows 1M with claude-opus-4-6[1m])');
  } else {
    console.log('SOME TESTS FAILED — review output above');
    process.exit(1);
  }
}

main();
