#!/usr/bin/env bun
/**
 * Test: SDK Context Window Verification
 *
 * Proves that our workaround for SDK bug #35214 gives 1M context window.
 *
 * The SDK only reports 1M when the resolved model string contains "[1m]".
 * Our app passes model:'opus' to the SDK. Without the env var override,
 * the SDK resolves 'opus' → 'claude-opus-4-6' (no [1m]) → 200k context.
 * With ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6[1m], it resolves
 * 'opus' → 'claude-opus-4-6[1m]' → 1M context.
 *
 * This test makes ONE real SDK call using the same model alias ('opus')
 * and env var that the Electron app uses, then asserts contextWindow === 1M.
 *
 * Usage:
 *   ./resources/bun run scripts/test-context-window.ts          # test the fix
 *   ./resources/bun run scripts/test-context-window.ts --bug     # reproduce the bug (no env var)
 *
 * Exit codes:
 *   0 = contextWindow matches expectation
 *   1 = contextWindow does NOT match expectation
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
  console.log(' SDK Context Window Verification');
  console.log('========================================');
  console.log(`  SDK version : ${sdkPkg.version}`);
  console.log(`  Mode        : ${bugMode ? '--bug (reproduce SDK bug, expect 200k)' : 'default (verify fix, expect 1M)'}`);
  console.log('');

  // Both modes pass model:'opus' — same as the Electron app.
  // The only difference is whether the env var override is present.
  const env: Record<string, string> | undefined = bugMode
    ? undefined
    : { ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-opus-4-6[1m]' };

  const expectedContextWindow = bugMode ? 200_000 : 1_000_000;

  if (env) {
    console.log(`  Env override: ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6[1m]`);
  } else {
    console.log(`  Env override: (none — bare SDK defaults)`);
  }
  console.log(`  Expected    : contextWindow=${expectedContextWindow}`);
  console.log('');
  console.log('Running SDK query with model:"opus"...');

  let modelUsage: Record<string, ModelUsageEntry> | null = null;

  try {
    const q = query({
      prompt: 'Say exactly: "ok"',
      options: {
        model: 'opus',
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowedTools: [],
        executable: resolveBunExecutable(),
        pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        cwd: WORKSPACE_DIR,
        env,
      }
    });

    for await (const msg of q) {
      if (msg.type === 'result') {
        modelUsage = (msg as any).modelUsage ?? null;
      } else if (msg.type === 'error') {
        console.error('SDK error:', (msg as any).error);
        process.exit(1);
      }
    }
  } catch (err) {
    console.error('Query threw:', err);
    process.exit(1);
  }

  // ---------- evaluate ----------

  if (!modelUsage) {
    console.error('FAIL: modelUsage was null — SDK did not return usage data');
    process.exit(1);
  }

  const entries = Object.entries(modelUsage);
  if (entries.length === 0) {
    console.error('FAIL: modelUsage was empty');
    process.exit(1);
  }

  const [resolvedModel, usage] = entries[0];
  const actualContextWindow = usage.contextWindow;

  console.log('');
  console.log('----------------------------------------');
  console.log(`  Resolved model : ${resolvedModel}`);
  console.log(`  Context window : ${actualContextWindow}`);
  console.log(`  Expected       : ${expectedContextWindow}`);
  console.log('----------------------------------------');
  console.log('');

  if (actualContextWindow === expectedContextWindow) {
    if (bugMode) {
      console.log('PASS: SDK bug #35214 confirmed — opus without [1m] reports 200k');
      console.log('');
      console.log('This proves the bug exists. Now run without --bug to verify the fix:');
      console.log('  ./resources/bun run scripts/test-context-window.ts');
    } else {
      console.log('PASS: Fix verified — opus with env var override reports 1M');
      console.log('');
      console.log('The ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-4-6[1m] workaround');
      console.log('correctly gives the SDK 1M context window. Compaction will trigger');
      console.log('at ~1M, not 200k.');
      console.log('');
      console.log('To confirm the bug still exists without the fix:');
      console.log('  ./resources/bun run scripts/test-context-window.ts --bug');
    }
    process.exit(0);
  } else {
    if (bugMode) {
      console.log(`FAIL: Expected 200k (SDK bug) but got ${actualContextWindow}`);
      console.log('');
      if (actualContextWindow === 1_000_000) {
        console.log('The SDK may have fixed bug #35214. If so, the env var workaround');
        console.log('is no longer needed (but is harmless).');
      }
    } else {
      console.log(`FAIL: Expected 1M but got ${actualContextWindow}`);
      console.log('');
      console.log('The env var workaround did NOT produce 1M context window.');
      console.log('Compaction will fire at ~200k. Investigate buildClaudeSessionEnv().');
    }
    process.exit(1);
  }
}

main();
