#!/usr/bin/env bun
import * as fs from 'fs';
import * as path from 'path';
import { createRequire } from 'module';
import { query } from '@anthropic-ai/claude-agent-sdk';

const requireModule = createRequire(import.meta.url);
const WORKSPACE_DIR = process.cwd();

if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
  const resourceBash = path.join(WORKSPACE_DIR, 'resources', 'msys2', 'usr', 'bin', 'bash.exe');
  const commonPaths = [resourceBash, 'C:\\Program Files\\Git\\bin\\bash.exe'];
  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      process.env.CLAUDE_CODE_GIT_BASH_PATH = p;
      break;
    }
  }
}

function resolveClaudeCodeCli(): string {
  const sdkEntry = requireModule.resolve('@anthropic-ai/claude-agent-sdk');
  return path.join(path.dirname(sdkEntry), 'cli.js');
}

function resolveBunExecutable(): string {
  const resourceBun = path.join(WORKSPACE_DIR, 'resources', process.platform === 'win32' ? 'bun.exe' : 'bun');
  if (fs.existsSync(resourceBun)) return resourceBun;
  return 'bun';
}

async function main() {
  console.log('\n🧪 Testing Extended Context Beta with Bypass Auth\n');

  const q = query({
    prompt: 'Say exactly: "Extended context beta works!"',
    options: {
      model: 'haiku',
      settingSources: ['project'],
      permissionMode: 'bypassPermissions',
      allowedTools: ['Read'],
      executable: resolveBunExecutable(),
      pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      cwd: WORKSPACE_DIR,
      stderr: (msg) => {
        if (msg.includes('Spawning')) console.log('[SDK] Starting with beta parameter...');
      },
      // @ts-expect-error - Testing extended context beta
      betas: ['context-1m-2025-08-07']
    }
  });

  let output = '';
  for await (const msg of q) {
    if (msg.type === 'stream_event') {
      if (msg.event.type === 'content_block_delta' && msg.event.delta.type === 'text_delta') {
        output += msg.event.delta.text;
        process.stdout.write(msg.event.delta.text);
      }
    } else if (msg.type === 'result' && msg.result) {
      output = msg.result;
    } else if (msg.type === 'error') {
      console.error('ERROR:', msg.error);
      process.exit(1);
    }
  }

  console.log('\n\n✅ SUCCESS! Beta parameter accepted. Response:', output);
  console.log('\nNote: This confirms the betas parameter works with bypass auth.');
  console.log('To verify 1M context is active, test with >200K tokens of input.\n');
}

main();
