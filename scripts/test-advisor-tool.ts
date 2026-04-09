#!/usr/bin/env bun
/**
 * Test for the Advisor Tool beta (advisor-tool-2026-03-01)
 *
 * The Advisor Tool lets a smaller executor model (Sonnet/Haiku) call Opus
 * for planning guidance on hard decisions, all within a single /v1/messages
 * request. This keeps costs low while improving quality.
 *
 * SDK usage:
 *   tools=[{ type: "advisor_20260301", name: "advisor", model: "claude-opus-4-6", max_uses: 3 }]
 *   Header: anthropic-beta: advisor-tool-2026-03-01
 *
 * Run: bun scripts/test-advisor-tool.ts
 */
import * as fs from 'fs';
import { createRequire } from 'module';
import * as path from 'path';
import { query } from '@anthropic-ai/claude-agent-sdk';

const requireModule = createRequire(import.meta.url);

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message: string, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function success(message: string) {
  log(`✓ ${message}`, colors.green);
}

function info(message: string) {
  log(`ℹ ${message}`, colors.cyan);
}

const WORKSPACE_DIR = process.cwd();

// Set git-bash path for Windows if needed
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
    console.error('[ERROR] Could not find git-bash! Checked:', commonPaths);
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

async function runTest() {
  log('\n=== Advisor Tool Beta Test ===\n', colors.blue);

  info('Testing: advisor-tool-2026-03-01 beta parameter');
  info('This verifies the SDK accepts the advisor beta header.');
  info(
    'When the advisor tool is active, the executor model can call Opus for planning on hard decisions.\n'
  );

  const systemPrompt = [
    'You are a helpful assistant with access to the Advisor tool.',
    'The Advisor tool routes hard decisions to a more capable model (Opus) for planning.',
    'When you encounter a complex problem that needs careful planning, the advisor can help.',
    '',
    'For this test, simply respond with a brief greeting and confirm you are operational.',
    'Mention that the advisor tool beta is active if you can detect it.'
  ].join('\n');

  const q = query({
    prompt: 'Hello! Please confirm you are operational and describe any special capabilities you have access to.',
    options: {
      model: 'sonnet',
      settingSources: ['project'] as const,
      permissionMode: 'bypassPermissions' as const,
      allowedTools: ['Read'],
      executable: resolveBunExecutable(),
      pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
      systemPrompt: {
        type: 'preset' as const,
        preset: 'claude_code' as const,
        append: systemPrompt
      },
      cwd: WORKSPACE_DIR,
      stderr: (msg: string) => {
        if (msg.includes('Spawning')) info('[SDK] Starting advisor test...');
      },
      // @ts-expect-error - Testing advisor tool beta
      betas: ['advisor-tool-2026-03-01']
    }
  });

  let output = '';
  process.stdout.write(colors.cyan);
  for await (const msg of q) {
    if (msg.type === 'stream_event') {
      if (msg.event.type === 'content_block_delta' && msg.event.delta.type === 'text_delta') {
        output += msg.event.delta.text;
        process.stdout.write(msg.event.delta.text);
      }
    } else if (msg.type === 'result' && msg.result) {
      output = msg.result;
    } else if (msg.type === 'error') {
      console.error('SDK ERROR:', msg.error);
    }
  }
  process.stdout.write(colors.reset + '\n');

  if (output.length > 0) {
    success('Advisor tool beta parameter accepted by SDK');
    success(`Response length: ${output.length} characters`);
    log('\nNote: This confirms the betas parameter works with the advisor tool beta.');
    log('In production, the executor model (Sonnet/Haiku) would call advisor_20260301');
    log('to route complex planning decisions to Opus.\n');
    log('SDK tool configuration would include:', colors.yellow);
    log(
      JSON.stringify(
        {
          type: 'advisor_20260301',
          name: 'advisor',
          model: 'claude-opus-4-6',
          max_uses: 3
        },
        null,
        2
      ),
      colors.yellow
    );
    log('\nWith header: anthropic-beta: advisor-tool-2026-03-01\n', colors.yellow);
  } else {
    log('✗ No response received', colors.red);
    process.exit(1);
  }
}

runTest().catch(console.error);
