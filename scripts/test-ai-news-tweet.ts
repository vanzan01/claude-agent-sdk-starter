#!/usr/bin/env bun
/**
 * E2E test for ai-news-tweet 3-stage pipeline
 * Tests: Researcher → Analysis → Writer
 *
 * Run: bun scripts/test-ai-news-tweet.ts
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

function error(message: string) {
  log(`✗ ${message}`, colors.red);
}

function info(message: string) {
  log(`ℹ ${message}`, colors.cyan);
}

function warn(message: string) {
  log(`⚠ ${message}`, colors.yellow);
}

const WORKSPACE_DIR = process.cwd();

// Retry configuration
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 10000,
  backoffMultiplier: 2
};

// Set git-bash path for Windows if needed
if (process.platform === 'win32' && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
  // Try to find bash - first check project resources, then system paths
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

// Calculate retry delay
function getRetryDelay(attempt: number): number {
  const delay = RETRY_CONFIG.baseDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
  return Math.min(delay, RETRY_CONFIG.maxDelayMs);
}

// Sleep helper
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveClaudeCodeCli(): string {
  const sdkEntry = requireModule.resolve('@anthropic-ai/claude-agent-sdk');
  return path.join(path.dirname(sdkEntry), 'cli.js');
}

function resolveBunExecutable(): string {
  // Try to find bun in resources/bun (like in electron app) or just use 'bun'
  const resourceBun = path.join(WORKSPACE_DIR, 'resources', process.platform === 'win32' ? 'bun.exe' : 'bun');
  if (fs.existsSync(resourceBun)) return resourceBun;
  return 'bun';
}

// Base SDK query options shared across all stages
function getBaseQueryOptions(systemPromptAppend: string, allowedTools: string[], stageName: string) {
  return {
    model: 'haiku' as const,
    settingSources: ['project'] as const,
    permissionMode: 'bypassPermissions' as const,
    allowedTools,
    executable: resolveBunExecutable(),
    pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
    systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend },
    cwd: WORKSPACE_DIR,
    stderr: (msg: string) => {
      if (msg.includes('Spawning')) info(`[SDK] Starting ${stageName}...`);
    }
  };
}

// Helper to stream and capture SDK output
async function runSdkQuery(
  prompt: string,
  options: ReturnType<typeof getBaseQueryOptions>,
  agentId: string
): Promise<string> {
  const q = query({ prompt, options });

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

  return extractContent(output, agentId) || output;
}

// Helper to extract content from markers (simulating backend logic)
function extractContent(output: string, agentId: string): string | null {
  const startMarker = `<<<${agentId}>>>`;
  const endMarker = `<<<end-${agentId}>>>`;
  const startIdx = output.lastIndexOf(startMarker);
  const endIdx = output.lastIndexOf(endMarker);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return output.slice(startIdx + startMarker.length, endIdx).trim();
  }
  return null;
}

function wrapWithMarkers(agentId: string, prompt: string): string {
  return `${prompt}` +
    `\nCRITICAL OUTPUT REQUIREMENT - YOU MUST FOLLOW THIS:` +
    `\nYour ENTIRE final output MUST be wrapped in these exact markers:` +
    `\n` +
    `<<<${agentId}>>>` +
    `\n[your content here]` +
    `\n<<<end-${agentId}>>>` +
    `\nWITHOUT these markers, your output will NOT be captured. This is NON-NEGOTIABLE.` +
    `\nPlace markers OUTSIDE any JSON, text, or other content you produce.`;
}

// Generic retry wrapper
async function runWithRetry<T>(
  stageName: string,
  runStage: () => Promise<T>,
  validate: (result: T) => { valid: boolean; errors: string[] }
): Promise<T> {
  let lastError: Error | null = null;
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getRetryDelay(attempt - 1);
        warn(`${stageName} retry ${attempt}/${RETRY_CONFIG.maxRetries} after ${delay}ms...`);
        await sleep(delay);
      }

      const result = await runStage();
      const validation = validate(result);

      if (validation.valid) {
        if (attempt > 0) {
          success(`${stageName} succeeded after ${attempt} retries`);
        }
        return result;
      }

      lastErrors = validation.errors;
      lastError = new Error(validation.errors.join('; '));
      warn(`${stageName} validation failed: ${lastErrors.join(', ')}`);
    } catch (err) {
      lastError = err as Error;
      lastErrors = [lastError.message];
      warn(`${stageName} attempt ${attempt} failed: ${lastError.message}`);
    }
  }

  error(`${stageName} failed after ${RETRY_CONFIG.maxRetries} retries: ${lastErrors.join(', ')}`);
  throw lastError || new Error(`${stageName} failed`);
}

async function runTest() {
  log('\n=== AI News Tweet Pipeline Test ===\n', colors.blue);
  
  const todayStr = new Date().toISOString().split('T')[0];
  info(`Date: ${todayStr}`);

  // Load agent definitions
  const agentDir = path.join(WORKSPACE_DIR, '.claude/agents/ai-news-tweet');
  const researchDef = fs.readFileSync(path.join(agentDir, 'researcher.md'), 'utf-8').replace(/^---[\s\S]*?---\n*/, '').trim();
  const analysisDef = fs.readFileSync(path.join(agentDir, 'analysis.md'), 'utf-8').replace(/^---[\s\S]*?---\n*/, '').trim();
  const writerDef = fs.readFileSync(path.join(agentDir, 'writer.md'), 'utf-8').replace(/^---[\s\S]*?---\n*/, '').trim();

  // Load skill YAML metadata (progressive disclosure - Level 1)
  interface SkillMetadata {
    name: string;
    description: string;
    allowedTools?: string[];
  }

  function loadSkillYaml(skillName: string): SkillMetadata {
    const skillPath = path.join(WORKSPACE_DIR, '.claude/skills', skillName, 'SKILL.md');
    if (!fs.existsSync(skillPath)) {
      throw new Error(`Skill not found: ${skillName}`);
    }
    const content = fs.readFileSync(skillPath, 'utf-8');
    const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!frontmatterMatch) {
      throw new Error(`Skill ${skillName} missing YAML frontmatter`);
    }
    const yamlLines = frontmatterMatch[1].split(/\r?\n/);
    const metadata: Record<string, string> = {};
    for (const line of yamlLines) {
      const match = line.match(/^([\w-]+):\s*(.*)$/);
      if (match) {
        metadata[match[1]] = match[2].trim();
      }
    }
    return {
      name: metadata.name || skillName,
      description: metadata.description || '',
      allowedTools: metadata['allowed-tools']?.split(',').map(t => t.trim())
    };
  }

  function buildSkillPrompt(skillMeta: SkillMetadata): string {
    const skillDir = `.claude/skills/${skillMeta.name}`;
    return `--- AVAILABLE SKILL: ${skillMeta.name} ---
Description: ${skillMeta.description}
Documentation: ${skillDir}/SKILL.md
Reference: ${skillDir}/reference.md (if you need deeper detail)
${skillMeta.allowedTools ? `Allowed Tools: ${skillMeta.allowedTools.join(', ')}` : ''}

You MUST Read ${skillDir}/SKILL.md to understand how to use this skill.
--- END SKILL ---`;
  }

  // Load skill metadata (YAML only - ~50 tokens each)
  const newsToolsMeta = loadSkillYaml('news-tools');
  const analysisHelperMeta = loadSkillYaml('analysis-helper');
  const tweetWriterMeta = loadSkillYaml('tweet-writer');

  success('Loaded skill metadata (YAML only - progressive disclosure)');
  info(`  news-tools: ${newsToolsMeta.description.slice(0, 50)}...`);
  info(`  analysis-helper: ${analysisHelperMeta.description.slice(0, 50)}...`);
  info(`  tweet-writer: ${tweetWriterMeta.description.slice(0, 50)}...`);

  // ============================================================================
  // STAGE 1: RESEARCHER
  // ============================================================================
  log('\n--- Stage 1: Researcher ---\n', colors.yellow);

  const researchPrompt = wrapWithMarkers('researcher', `${researchDef}\n\n${buildSkillPrompt(newsToolsMeta)}`);

  const runResearcher = async () => {
    const options = getBaseQueryOptions(researchPrompt, ['WebSearch', 'Read'], 'researcher');
    return runSdkQuery(
      `Find today's most interesting AI news. Today is ${todayStr}. Return JSON with the news items.`,
      options,
      'researcher'
    );
  };

  const researchOutput = await runWithRetry('Researcher', runResearcher, (output) => {
    if (!output || !output.includes('{')) return { valid: false, errors: ['No JSON found'] };
    try {
        // Basic check
        const jsonMatch = output.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { valid: false, errors: ['No JSON block found'] };
        const json = JSON.parse(jsonMatch[0]);
        if (!json.items && !json.news_items) return { valid: false, errors: ['Missing items/news_items'] };
        return { valid: true, errors: [] };
    } catch (e) {
        return { valid: false, errors: [(e as Error).message] };
    }
  });

  success('Stage 1 PASSED');

  // ============================================================================
  // STAGE 2: ANALYSIS
  // ============================================================================
  log('\n--- Stage 2: Analysis ---\n', colors.yellow);

  const analysisPrompt = wrapWithMarkers('analysis', `${analysisDef}\n\n${buildSkillPrompt(analysisHelperMeta)}`);

  const runAnalysis = async () => {
    const options = getBaseQueryOptions(analysisPrompt, ['Read'], 'analysis');
    return runSdkQuery(
      `Analyze this research and pick the most impactful story:\n\n${researchOutput}`,
      options,
      'analysis'
    );
  };

  const analysisOutput = await runWithRetry('Analysis', runAnalysis, (output) => {
    if (!output.includes('Winner:') || !output.includes('Why it matters')) {
        return { valid: false, errors: ['Missing "Winner:" or "Why it matters"'] };
    }
    return { valid: true, errors: [] };
  });

  success('Stage 2 PASSED');

  // ============================================================================
  // STAGE 3: WRITER
  // ============================================================================
  log('\n--- Stage 3: Writer ---\n', colors.yellow);

  const writerPrompt = wrapWithMarkers('writer', `${writerDef}\n\n${buildSkillPrompt(tweetWriterMeta)}`);

  const runWriter = async () => {
    const options = getBaseQueryOptions(writerPrompt, ['Read'], 'writer');
    return runSdkQuery(
      `Write a tweet about this analysis:\n\n${analysisOutput}`,
      options,
      'writer'
    );
  };

  const writerOutput = await runWithRetry('Writer', runWriter, (output) => {
    if (!output.includes('#')) return { valid: false, errors: ['Missing hashtag'] };
    if (output.length > 280) return { valid: false, errors: ['Too long'] };
    return { valid: true, errors: [] };
  });

  success('Stage 3 PASSED');
  log('\nFinal Tweet:', colors.green);
  console.log(writerOutput);
}

runTest().catch(console.error);
