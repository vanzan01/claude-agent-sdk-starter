import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import { BrowserWindow } from 'electron';

import type { AgentDefinition } from '../../shared/apps';
import type { ThinkingLevel } from '../../shared/constants';
import type { ChatModelPreference } from '../../shared/core';
import { emitEventFromMain } from '../handlers/app-messaging-handlers';
import {
  clearAllOutputs as _clearAllOutputs,
  clearProcessedMarkers,
  isMarkerProcessed,
  markAsProcessed,
  storeAgentOutput
} from './agent-output-store';
import {
  buildClaudeSessionEnv,
  getAdvisorEnabled,
  getChatModelPreferenceSetting,
  getDebugMode,
  getMaxThinkingTokens,
  getProvider,
  getSystemPromptAppend,
  getThinkingLevel,
  getWorkspaceDir,
  setChatModelPreferenceSetting,
  setConfigValue,
  waitForWorkspaceReady
} from './config';
import {
  abortGenerator,
  clearMessageQueue,
  messageGenerator,
  regenerateSessionId,
  resetAbortFlag,
  setSessionId
} from './message-queue';

const requireModule = createRequire(import.meta.url);

const FAST_MODEL_ID = 'haiku';
const SMART_MODEL_ID = 'sonnet';
const DEEP_MODEL_ID = 'opus';

const MODEL_BY_PREFERENCE: Record<ChatModelPreference, string> = {
  fast: FAST_MODEL_ID,
  smart: SMART_MODEL_ID,
  deep: DEEP_MODEL_ID
};

type AgentEventChannel =
  | 'message-chunk'
  | 'thinking-start'
  | 'thinking-chunk'
  | 'tool-use-start'
  | 'tool-input-delta'
  | 'content-block-stop'
  | 'tool-result-start'
  | 'tool-result-delta'
  | 'tool-result-complete'
  | 'message-complete'
  | 'message-stopped'
  | 'message-error'
  | 'session-updated'
  | 'debug-message'
  | 'context-window-update';

// Lazy initialization - don't call electron APIs at module load time
let currentModelPreference: ChatModelPreference | null = null;
let activeAppId = 'chat';
let activeAppSystemPrompt: string | null = null;
let activeSystemPromptAppend: string | null = null;
let activeAllowedTools: string[] | undefined = undefined;

function ensureModelPreference(): ChatModelPreference {
  if (currentModelPreference === null) {
    currentModelPreference = getChatModelPreferenceSetting();
  }
  return currentModelPreference;
}

export function setActiveAppContext(appId: string, systemPrompt: string | null | undefined): void {
  const prevAppId = activeAppId;
  activeAppId = appId || 'chat';
  activeAppSystemPrompt = systemPrompt ?? null;
  console.log(`[Main] setActiveAppContext: "${prevAppId}" -> "${activeAppId}"`);
}

export function getActiveAppId(): string {
  return activeAppId;
}

export function getActiveSystemPromptAppend(): string | null {
  return activeSystemPromptAppend;
}

function resolveClaudeCodeCli(): string {
  // Resolve package directory, then join cli.js (not exported in v0.2+)
  const sdkEntry = requireModule.resolve('@anthropic-ai/claude-agent-sdk');
  const cliPath = path.join(path.dirname(sdkEntry), 'cli.js');
  if (cliPath.includes('app.asar')) {
    const unpackedPath = cliPath.replace('app.asar', 'app.asar.unpacked');
    if (existsSync(unpackedPath)) {
      return unpackedPath;
    }
  }
  return cliPath;
}

// Debug counter for chunk logging
let chunkDebugCount = 0;

function sendAgentEvent(
  mainWindow: BrowserWindow | null,
  channel: AgentEventChannel,
  payload?: unknown,
  appIdOverride?: string
): void {
  const targetWindow =
    mainWindow && !mainWindow.isDestroyed() ?
      mainWindow
    : (BrowserWindow.getAllWindows()[0] ?? null);
  if (!targetWindow || targetWindow.isDestroyed()) {
    return;
  }

  // Use override if provided (for per-session snapshot), otherwise fall back to global
  const effectiveAppId = appIdOverride ?? sessionAppId;

  const enrichedPayload =
    payload && typeof payload === 'object' && !Array.isArray(payload) ?
      { appId: effectiveAppId, ...(payload as Record<string, unknown>) }
    : { appId: effectiveAppId, data: payload };

  // Debug logging for message chunks
  if (channel === 'message-chunk') {
    chunkDebugCount++;
    if (chunkDebugCount <= 5 || chunkDebugCount % 100 === 0) {
      console.log(`[Main] Sending chunk #${chunkDebugCount} with appId="${effectiveAppId}"`);
    }
  }

  targetWindow.webContents.send(`agent:${channel}`, enrichedPayload);
}

let querySession: Query | null = null;
let isProcessing = false;
let shouldAbortSession = false;
let sessionTerminationPromise: Promise<void> | null = null;
let isInterruptingResponse = false;
// Map stream index to tool ID for current message
const streamIndexToToolId: Map<number, string> = new Map();
// Per-step usage from the last main-chain assistant message (actual context fill)
let lastAssistantInputTokens = 0;
let pendingResumeSessionId: string | null = null;
// Promise that resolves when session is ready to process messages
let sessionReadyPromise: Promise<void> | null = null;
let resolveSessionReady: (() => void) | null = null;

// Transcript accumulator for parsing agent markers
let transcriptAccumulator = '';

// The appId that started the current session - captured at session start
// This is different from activeAppId which changes when user switches apps
let sessionAppId: string = 'chat';

// Session token for detecting overlapping sessions (extra safety)
let currentSessionToken = 0;

// Regex to match agent markers: <<<agentId>>>...<<<end-agentId>>>
// Allow hyphens/underscores in agentId (e.g. "news-fetcher")
const AGENT_MARKER_REGEX = /<<<([a-zA-Z0-9_-]+)>>>([\s\S]*?)<<<end-\1>>>/g;

/**
 * Process accumulated transcript for agent output markers.
 * When a complete marker is found (<<<agentId>>>...<<<end-agentId>>>),
 * stores the output and emits an event.
 */
function processTranscriptForAgentOutputs(appId: string, mainWindow: BrowserWindow | null): void {
  // Reset regex state
  AGENT_MARKER_REGEX.lastIndex = 0;

  let match;
  while ((match = AGENT_MARKER_REGEX.exec(transcriptAccumulator)) !== null) {
    const [fullMatch, agentId, content] = match;

    // Create a hash to avoid duplicate processing
    const markerHash = `${appId}:${agentId}:${fullMatch.length}`;
    if (isMarkerProcessed(markerHash)) {
      continue;
    }
    markAsProcessed(markerHash);

    // Store the output in main process
    const dataKey = storeAgentOutput(appId, agentId, content.trim());

    console.log(`[transcript-parser] Found agent marker: ${agentId}, stored as ${dataKey}`);

    // Emit event with reference to stored data
    emitEventFromMain(mainWindow, {
      type: 'agent:step-complete',
      sourceAppId: 'core',
      timestamp: Date.now(),
      appId,
      agentId,
      dataKey
    });
  }
}

function getModelIdForPreference(preference?: ChatModelPreference): string {
  const pref = preference ?? ensureModelPreference();
  return MODEL_BY_PREFERENCE[pref] ?? FAST_MODEL_ID;
}

export function getCurrentModelPreference(): ChatModelPreference {
  return ensureModelPreference();
}

export function getCurrentThinkingLevel(): ThinkingLevel {
  return getThinkingLevel();
}

export async function setCurrentThinkingLevel(level: ThinkingLevel): Promise<void> {
  await setConfigValue('thinkingLevel', level);
  // Note: Thinking level change requires session reset to take effect
  // The SDK doesn't support changing maxThinkingTokens mid-session
}

export async function setChatModelPreference(preference: ChatModelPreference): Promise<void> {
  const current = ensureModelPreference();
  if (preference === current) {
    return;
  }

  currentModelPreference = preference;
  setChatModelPreferenceSetting(currentModelPreference);

  // Reset session to apply new model - same behavior as provider switch
  // This ensures GLM model mappings (set via env vars) are reloaded correctly
  await resetSession();
}

export function isSessionActive(): boolean {
  return isProcessing || querySession !== null;
}

/**
 * Wait for the session to be ready to process messages.
 * This should be called before queuing messages to ensure the SDK is initialized.
 */
export async function waitForSessionReady(): Promise<void> {
  if (sessionReadyPromise) {
    await sessionReadyPromise;
  }
}

/**
 * Pre-warm the SDK session by starting it before the first message.
 * This reduces the delay users experience on their first message.
 * Called after workspace sync is complete.
 */
export function preWarmSession(mainWindow: BrowserWindow | null): void {
  if (isSessionActive()) {
    return;
  }

  console.log('Pre-warming SDK session...');
  startStreamingSession(mainWindow).catch((error) => {
    console.error('Failed to pre-warm session:', error);
  });
}

export async function interruptCurrentResponse(mainWindow: BrowserWindow | null): Promise<boolean> {
  if (!querySession) {
    return false;
  }

  if (isInterruptingResponse) {
    return true;
  }

  isInterruptingResponse = true;
  try {
    await querySession.interrupt();
    sendAgentEvent(mainWindow, 'message-stopped', {});
    return true;
  } catch (error) {
    console.error('Failed to interrupt current response:', error);
    throw error;
  } finally {
    isInterruptingResponse = false;
  }
}

export async function resetSession(resumeSessionId?: string | null): Promise<void> {
  console.log(
    `[Main] resetSession called (current sessionAppId="${sessionAppId}", isProcessing=${isProcessing})`
  );
  // Signal any running session to abort
  shouldAbortSession = true;

  // Signal the message generator to abort
  abortGenerator();

  // Clear the message queue to prevent pending messages from being sent
  clearMessageQueue();

  // Generate or set the appropriate session ID for the next conversation
  regenerateSessionId(resumeSessionId ?? null);
  pendingResumeSessionId = resumeSessionId ?? null;

  // Wait for the current session to fully terminate before proceeding
  if (sessionTerminationPromise) {
    await sessionTerminationPromise;
  }

  // Clear session state
  querySession = null;
  isProcessing = false;
  sessionTerminationPromise = null;
  sessionReadyPromise = null;
  resolveSessionReady = null;
  activeSystemPromptAppend = null;
  activeAllowedTools = undefined;

  // NOTE: sessionAppId is NOT reset here - it will be captured at the START
  // of the next session in startStreamingSession() or runSingleAgentCall().
  // This ensures the old session can't accidentally use a changed appId.
}

// Start streaming session
function buildDefaultSystemPromptAppend(): string {
  return [getSystemPromptAppend(), activeAppSystemPrompt]
    .filter((text) => typeof text === 'string' && text.trim().length > 0)
    .join('\n\n');
}

/**
 * Run a single agent call and return the complete response.
 * This is a blocking call that waits for the agent to finish.
 * Used for deterministic sequential agent orchestration.
 * Emits 'single-agent-chunk' events for real-time progress visibility.
 */
export async function runSingleAgentCall(
  mainWindow: BrowserWindow | null,
  appId: string,
  config: {
    systemPrompt: string;
    allowedTools?: string[];
    model?: 'sonnet' | 'opus' | 'haiku';
    outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
  },
  userPrompt: string
): Promise<{ success: true; response: string; structuredOutput?: unknown } | { success: false; error: string }> {
  console.log('[SingleAgent] Starting agent call...');
  console.log('[SingleAgent] AppId:', appId);
  console.log('[SingleAgent] Model:', config.model ?? 'haiku');
  console.log('[SingleAgent] Tools:', config.allowedTools ?? ['WebSearch', 'WebFetch']);
  console.log('[SingleAgent] Prompt preview:', userPrompt.slice(0, 100) + '...');

  // Set sessionAppId so events are routed to the correct app
  sessionAppId = appId;
  // Create a snapshot for this single-agent call
  const singleAgentAppId = appId;

  // Only wait for termination if a shutdown is already in-flight. If a persistent session
  // is active, we intentionally do NOT block single-agent calls.
  if (sessionTerminationPromise && !querySession) {
    console.log('[SingleAgent] Waiting for previous session to terminate...');
    await sessionTerminationPromise;
  }

  // Wait for workspace to be ready
  console.log('[SingleAgent] Waiting for workspace...');
  await waitForWorkspaceReady();
  console.log('[SingleAgent] Workspace ready, starting SDK query...');

  let responseText = '';

  try {
    const env = buildClaudeSessionEnv();
    const modelId = config.model ?? 'haiku';
    const maxThinkingTokens = getMaxThinkingTokens();

    // Create a one-shot query (not using the persistent session)
    const singleQuery = query({
      prompt: userPrompt,
      options: {
        model: modelId,
        maxThinkingTokens,
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowedTools: config.allowedTools ?? ['WebSearch', 'WebFetch'],
        pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
        executable: 'bun',
        env,
        stderr: (message: string) => {
          console.log('[SingleAgent][stderr]', message);
          if (getDebugMode()) {
            sendAgentEvent(mainWindow, 'debug-message', { message }, singleAgentAppId);
          }
        },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: config.systemPrompt
        },
        cwd: getWorkspaceDir(),
        includePartialMessages: true, // CRITICAL: Enables streaming events
        ...(config.outputFormat && { outputFormat: config.outputFormat })
      }
    });

    console.log('[SingleAgent] SDK query created WITH STREAMING ENABLED');
    console.log('[SingleAgent] STREAMING appId:', sessionAppId, '| mainWindow:', !!mainWindow);

    // Map stream index to tool ID for this single-agent call
    const singleAgentToolMap: Map<number, string> = new Map();
    let streamEventCount = 0;

    // Process the response and accumulate text
    for await (const sdkMessage of singleQuery) {
      streamEventCount++;
      if (streamEventCount <= 10 || streamEventCount % 100 === 0) {
        console.log(`[SingleAgent] Event #${streamEventCount}: type=${sdkMessage.type}`);
      }
      if (sdkMessage.type === 'stream_event') {
        const streamEvent = sdkMessage.event;
        if (streamEvent.type === 'content_block_delta') {
          if (streamEvent.delta.type === 'text_delta') {
            responseText += streamEvent.delta.text;
            if (streamEventCount <= 10) {
              console.log(`[SingleAgent] TEXT CHUNK: "${streamEvent.delta.text.slice(0, 50)}..."`);
            }
            // Emit chunk for real-time UI updates
            sendAgentEvent(mainWindow, 'message-chunk', { chunk: streamEvent.delta.text }, singleAgentAppId);
          } else if (streamEvent.delta.type === 'thinking_delta') {
            // Emit thinking chunks for UI streaming
            sendAgentEvent(mainWindow, 'thinking-chunk', {
              index: streamEvent.index,
              delta: streamEvent.delta.thinking
            }, singleAgentAppId);
          } else if (streamEvent.delta.type === 'input_json_delta') {
            // Emit tool input deltas
            const toolId = singleAgentToolMap.get(streamEvent.index);
            sendAgentEvent(mainWindow, 'tool-input-delta', {
              index: streamEvent.index,
              toolId: toolId || '',
              delta: streamEvent.delta.partial_json
            }, singleAgentAppId);
          }
        } else if (streamEvent.type === 'content_block_start') {
          if (streamEvent.content_block.type === 'thinking') {
            sendAgentEvent(mainWindow, 'thinking-start', {
              index: streamEvent.index
            }, singleAgentAppId);
          } else if (streamEvent.content_block.type === 'tool_use') {
            // Store mapping for tool input deltas
            singleAgentToolMap.set(streamEvent.index, streamEvent.content_block.id);
            console.log(`[SingleAgent] TOOL START: ${streamEvent.content_block.name} | appId=${sessionAppId}`);
            sendAgentEvent(mainWindow, 'tool-use-start', {
              id: streamEvent.content_block.id,
              name: streamEvent.content_block.name,
              input: {},
              streamIndex: streamEvent.index
            }, singleAgentAppId);
          }
        } else if (streamEvent.type === 'content_block_stop') {
          const toolId = singleAgentToolMap.get(streamEvent.index);
          sendAgentEvent(mainWindow, 'content-block-stop', {
            index: streamEvent.index,
            toolId
          }, singleAgentAppId);
        }
      } else if (sdkMessage.type === 'assistant') {
        console.log('[SingleAgent] Assistant message received');
        // Extract text content from assistant message if stream didn't capture it
        if (sdkMessage.message && Array.isArray(sdkMessage.message.content)) {
          for (const block of sdkMessage.message.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              // Only add if we haven't already accumulated this text via streaming
              if (!responseText.includes(block.text)) {
                responseText += block.text;
                console.log(
                  '[SingleAgent] Extracted text from assistant message:',
                  block.text.slice(0, 100)
                );
              }
            }
          }
        }
      } else if ((sdkMessage as unknown as { type?: string }).type === 'tool_result') {
        // Emit tool result events (older SDK stream shape; keep runtime support)
        const toolResult = sdkMessage as unknown as {
          tool_use_id?: string;
          content?: string;
          is_error?: boolean;
        };
        if (toolResult.tool_use_id) {
          sendAgentEvent(mainWindow, 'tool-result-start', {
            toolUseId: toolResult.tool_use_id,
            content: toolResult.content || '',
            isError: toolResult.is_error || false
          }, singleAgentAppId);
          sendAgentEvent(mainWindow, 'tool-result-complete', {
            toolUseId: toolResult.tool_use_id,
            content: toolResult.content || '',
            isError: toolResult.is_error || false
          }, singleAgentAppId);
        }
      } else if (sdkMessage.type === 'result') {
        console.log('[SingleAgent] Result received, agent complete');
        // Emit message-complete event
        sendAgentEvent(mainWindow, 'message-complete', {}, singleAgentAppId);
        // Extract structured output if available (from JSON schema output format)
        const structuredOutput = (sdkMessage as { structured_output?: unknown }).structured_output;
        if (structuredOutput !== undefined) {
          console.log('[SingleAgent] Structured output found');
        }
        console.log('[SingleAgent] Stream complete. Response length:', responseText.length);
        return { success: true, response: responseText, structuredOutput };
      }
    }

    // Fallback return if no result message was received
    sendAgentEvent(mainWindow, 'message-complete', {}, singleAgentAppId);
    console.log('[SingleAgent] Stream complete (no result message). Response length:', responseText.length);
    return { success: true, response: responseText };
  } catch (error) {
    console.error('[SingleAgent] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

export async function startStreamingSession(
  mainWindow: BrowserWindow | null,
  allowedTools?: string[],
  systemPromptAppend?: string | null,
  agents?: Record<string, AgentDefinition>,
  modelOverride?: 'haiku' | 'sonnet' | 'opus'
): Promise<void> {
  // IMPORTANT: Create sessionReadyPromise BEFORE any awaits to prevent race conditions
  // This ensures waitForSessionReady() has something to wait on even if we yield
  if (!sessionReadyPromise && !isProcessing && !querySession) {
    sessionReadyPromise = new Promise((resolve) => {
      resolveSessionReady = resolve;
    });
  }

  // Wait for any pending session termination to complete first
  if (sessionTerminationPromise) {
    await sessionTerminationPromise;
  }

  const providedAppend =
    typeof systemPromptAppend === 'string' && systemPromptAppend.trim().length > 0 ?
      systemPromptAppend
    : null;
  const desiredAppend = providedAppend ?? buildDefaultSystemPromptAppend();

  // Check if allowedTools changed (need special array comparison)
  const toolsChanged = (() => {
    if (!allowedTools && !activeAllowedTools) return false;
    if (!allowedTools || !activeAllowedTools) return true;
    if (allowedTools.length !== activeAllowedTools.length) return true;
    return !allowedTools.every((t, i) => t === activeAllowedTools![i]);
  })();

  // Check if appId changed (need to reset session for app isolation)
  const appIdChanged = sessionAppId !== activeAppId;
  console.log(`[Main] startStreamingSession: sessionAppId="${sessionAppId}", activeAppId="${activeAppId}", appIdChanged=${appIdChanged}, isProcessing=${isProcessing}, querySession=${querySession !== null}`);

  // Reset session if system prompt OR allowedTools OR appId changed
  if (
    (isProcessing || querySession) &&
    (desiredAppend !== activeSystemPromptAppend || toolsChanged || appIdChanged)
  ) {
    console.log(
      `[Main] Session config changed - resetting (promptChanged=${desiredAppend !== activeSystemPromptAppend}, toolsChanged=${toolsChanged}, appIdChanged=${appIdChanged})`
    );
    console.log(`[Main] Previous sessionAppId: "${sessionAppId}", new activeAppId: "${activeAppId}"`);
    console.log(`[Main] Previous tools: ${JSON.stringify(activeAllowedTools)}`);
    console.log(`[Main] New tools: ${JSON.stringify(allowedTools)}`);
    await resetSession();
  }

  if (isProcessing || querySession) {
    // Session is already starting/running, wait for it to be ready
    console.log(
      `[Main] Reusing existing session (sessionAppId="${sessionAppId}", isProcessing=${isProcessing})`
    );
    if (sessionReadyPromise) {
      await sessionReadyPromise;
    }
    return;
  }

  // Reset abort flags for new session
  shouldAbortSession = false;
  resetAbortFlag();

  // Mark session as starting before async work so callers see the active state
  isProcessing = true;
  // Clear stream index mapping for new session
  streamIndexToToolId.clear();
  lastAssistantInputTokens = 0;

  // Reset transcript accumulator and processed markers for new session
  transcriptAccumulator = '';
  clearProcessedMarkers();

  // Capture the appId at session start - this won't change even if user switches apps
  sessionAppId = activeAppId;
  // Create a session-local snapshot for event routing
  // This ensures all events from THIS session use the appId at session start,
  // regardless of any later changes to activeAppId or sessionAppId
  const sessionAppIdSnapshot = sessionAppId;
  // Increment session token for detecting overlapping sessions
  const mySessionToken = ++currentSessionToken;
  chunkDebugCount = 0; // Reset chunk counter for new session
  console.log(
    `[Main] Session started with sessionAppId="${sessionAppId}" (activeAppId="${activeAppId}") token=${mySessionToken}`
  );

  // Create a promise that resolves when this session terminates
  let resolveTermination: () => void;
  sessionTerminationPromise = new Promise((resolve) => {
    resolveTermination = resolve;
  });

  // Note: sessionReadyPromise was already created at the top of this function
  // to prevent race conditions with waitForSessionReady()

  // Wait for workspace to be ready (skills synced) before starting session
  // This prevents the first message from hanging while skills are being copied
  await waitForWorkspaceReady();

  try {
    // Use the shared environment builder to ensure consistency across Electron app,
    // Claude Agent SDK, and debug panel. This handles both Anthropic and GLM providers,
    // setting the appropriate API key and base URL environment variables.
    const env = buildClaudeSessionEnv();

    const resumeSessionId = pendingResumeSessionId;
    const isResumedSession = typeof resumeSessionId === 'string' && resumeSessionId.length > 0;
    pendingResumeSessionId = null;

    // Use model override if provided, otherwise use user preference
    const modelId = modelOverride ?? getModelIdForPreference();

    const maxThinkingTokens = getMaxThinkingTokens();
    const appendPrompt = desiredAppend;
    activeSystemPromptAppend = appendPrompt;
    activeAllowedTools = allowedTools;

    // Check if advisor tool is enabled (routes hard decisions to Opus)
    const advisorEnabled = getAdvisorEnabled();
    const betas: string[] = [];
    if (advisorEnabled) {
      betas.push('advisor-tool-2026-03-01');
      console.log('[Main] Advisor tool enabled - adding beta header');
    }

    console.log(`[Main] Starting new session with allowedTools: ${JSON.stringify(allowedTools)}`);

    querySession = query({
      prompt: messageGenerator(),
      options: {
        model: modelId,
        maxThinkingTokens,
        settingSources: ['project'],
        permissionMode: 'bypassPermissions',
        allowedTools: allowedTools ?? [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebFetch',
          'WebSearch',
          'Skill'
        ],
        pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
        executable: 'bun',
        env,
        stderr: (message: string) => {
          // Only send debug messages if debug mode is enabled
          if (getDebugMode()) {
            sendAgentEvent(mainWindow, 'debug-message', { message }, sessionAppIdSnapshot);
          }
        },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: appendPrompt
        },
        cwd: getWorkspaceDir(),
        includePartialMessages: true,
        ...(agents && { agents }),
        ...(isResumedSession && { resume: resumeSessionId! }),
        ...(betas.length > 0 && { betas: betas as never })
      }
    });

    // Signal that the session query object is created
    // Note: The SDK subprocess may still be initializing, but we can queue messages
    if (resolveSessionReady) {
      resolveSessionReady();
      resolveSessionReady = null;
    }

    // Emit agent:started event for notification system
    emitEventFromMain(mainWindow, {
      type: 'agent:started',
      timestamp: Date.now(),
      sourceAppId: 'core',
      appId: sessionAppId,
      taskPreview: `Task started in ${sessionAppId}`
    });

    // Process streaming responses
    for await (const sdkMessage of querySession) {
      // Guard: if a new session started, stop emitting from this old one
      if (shouldAbortSession || mySessionToken !== currentSessionToken) {
        console.log(`[Main] Session ${mySessionToken} exiting (current=${currentSessionToken}, shouldAbort=${shouldAbortSession})`);
        // Emit message-stopped so renderer can clear loading state
        if (mainWindow && !mainWindow.isDestroyed()) {
          sendAgentEvent(mainWindow, 'message-stopped', {}, sessionAppIdSnapshot);
        }
        break;
      }

      if (!mainWindow || mainWindow.isDestroyed()) {
        break;
      }

      if (sdkMessage.type === 'stream_event') {
        // Handle streaming events
        const streamEvent = sdkMessage.event;

        if (streamEvent.type === 'content_block_delta') {
          if (streamEvent.delta.type === 'text_delta') {
            // Regular text delta
            sendAgentEvent(mainWindow, 'message-chunk', { chunk: streamEvent.delta.text }, sessionAppIdSnapshot);

            // Accumulate for agent marker detection
            transcriptAccumulator += streamEvent.delta.text;
            // Check for complete agent markers and emit events
            // Use sessionAppIdSnapshot (captured at start) not activeAppId (changes when user switches apps)
            processTranscriptForAgentOutputs(sessionAppIdSnapshot, mainWindow);

            // GLM provider: Check for reasoning_content in the delta
            // Z.AI GLM returns reasoning in a separate field instead of thinking blocks
            const deltaWithReasoning = streamEvent.delta as { reasoning_content?: string };
            if (deltaWithReasoning.reasoning_content && getProvider() === 'glm') {
              sendAgentEvent(mainWindow, 'thinking-chunk', {
                index: streamEvent.index,
                delta: deltaWithReasoning.reasoning_content
              }, sessionAppIdSnapshot);
            }
          } else if (streamEvent.delta.type === 'thinking_delta') {
            // Thinking text delta - send as thinking chunk
            sendAgentEvent(mainWindow, 'thinking-chunk', {
              index: streamEvent.index,
              delta: streamEvent.delta.thinking
            }, sessionAppIdSnapshot);
          } else if (streamEvent.delta.type === 'input_json_delta') {
            // Handle input JSON deltas for tool use
            // Look up the tool ID for this stream index
            const toolId = streamIndexToToolId.get(streamEvent.index);
            sendAgentEvent(mainWindow, 'tool-input-delta', {
              index: streamEvent.index,
              toolId: toolId || '', // Send tool ID if available
              delta: streamEvent.delta.partial_json
            }, sessionAppIdSnapshot);
          }
        } else if (streamEvent.type === 'content_block_start') {
          // Handle thinking blocks
          if (streamEvent.content_block.type === 'thinking') {
            sendAgentEvent(mainWindow, 'thinking-start', {
              index: streamEvent.index
            }, sessionAppIdSnapshot);
          } else if (streamEvent.content_block.type === 'tool_use') {
            // Store mapping of stream index to tool ID
            streamIndexToToolId.set(streamEvent.index, streamEvent.content_block.id);

            console.log(
              `[agent:${sessionAppId}] tool-use-start`,
              streamEvent.content_block.name,
              streamEvent.content_block.input ?? {}
            );
            sendAgentEvent(mainWindow, 'tool-use-start', {
              id: streamEvent.content_block.id,
              name: streamEvent.content_block.name,
              input: streamEvent.content_block.input || {},
              streamIndex: streamEvent.index
            }, sessionAppIdSnapshot);
          } else if (
            (streamEvent.content_block.type === 'web_search_tool_result' ||
              streamEvent.content_block.type === 'web_fetch_tool_result' ||
              streamEvent.content_block.type === 'code_execution_tool_result' ||
              streamEvent.content_block.type === 'bash_code_execution_tool_result' ||
              streamEvent.content_block.type === 'text_editor_code_execution_tool_result' ||
              streamEvent.content_block.type === 'mcp_tool_result') &&
            'tool_use_id' in streamEvent.content_block
          ) {
            // Handle tool result blocks starting - these are the actual tool result types
            const toolResultBlock = streamEvent.content_block as {
              tool_use_id: string;
              content?: string | unknown;
              is_error?: boolean;
            };

            let contentStr = '';
            if (typeof toolResultBlock.content === 'string') {
              contentStr = toolResultBlock.content;
            } else if (toolResultBlock.content !== null && toolResultBlock.content !== undefined) {
              contentStr = JSON.stringify(toolResultBlock.content, null, 2);
            }

            if (contentStr) {
              sendAgentEvent(mainWindow, 'tool-result-start', {
                toolUseId: toolResultBlock.tool_use_id,
                content: contentStr,
                isError: toolResultBlock.is_error || false
              }, sessionAppIdSnapshot);
            }
          }
        } else if (streamEvent.type === 'content_block_stop') {
          // Signal end of a content block
          // Look up tool ID for this stream index (if it's a tool block)
          const toolId = streamIndexToToolId.get(streamEvent.index);
          sendAgentEvent(mainWindow, 'content-block-stop', {
            index: streamEvent.index,
            toolId: toolId || undefined
          }, sessionAppIdSnapshot);
        }
      } else if (sdkMessage.type === 'assistant') {
        // Handle complete assistant messages - extract tool results
        const assistantMessage = sdkMessage.message;

        // Capture per-step usage from main-chain messages (not subagent sidechain)
        // Each assistant message's input_tokens = full conversation context for that API call
        if (!(sdkMessage as any).parent_tool_use_id) {
          const stepUsage = (assistantMessage as any).usage as {
            input_tokens?: number;
            cache_creation_input_tokens?: number;
            cache_read_input_tokens?: number;
          } | undefined;
          if (stepUsage?.input_tokens) {
            lastAssistantInputTokens = stepUsage.input_tokens
              + (stepUsage.cache_creation_input_tokens ?? 0)
              + (stepUsage.cache_read_input_tokens ?? 0);
          }
        }


        // GLM provider: Check for reasoning_content at message level
        // Z.AI GLM may return reasoning as a top-level field on the message
        const messageWithReasoning = assistantMessage as { reasoning_content?: string };
        if (messageWithReasoning.reasoning_content && getProvider() === 'glm') {
          // Send as a complete thinking block
          sendAgentEvent(mainWindow, 'thinking-start', { index: -1 }, sessionAppIdSnapshot);
          sendAgentEvent(mainWindow, 'thinking-chunk', {
            index: -1,
            delta: messageWithReasoning.reasoning_content
          }, sessionAppIdSnapshot);
          sendAgentEvent(mainWindow, 'content-block-stop', { index: -1 }, sessionAppIdSnapshot);
        }

        if (assistantMessage.content) {
          for (const block of assistantMessage.content) {
            // GLM provider: Check for reasoning_content in content blocks
            // Z.AI GLM may include reasoning in individual content blocks
            if (
              typeof block === 'object' &&
              block !== null &&
              'reasoning_content' in block &&
              getProvider() === 'glm'
            ) {
              const blockWithReasoning = block as { reasoning_content: string };
              sendAgentEvent(mainWindow, 'thinking-chunk', {
                index: -1,
                delta: blockWithReasoning.reasoning_content
              }, sessionAppIdSnapshot);
            }

            // Check for tool result blocks (SDK uses specific types like web_search_tool_result, etc.)
            // These blocks have tool_use_id and content properties
            if (
              typeof block === 'object' &&
              block !== null &&
              'tool_use_id' in block &&
              'content' in block
            ) {
              // Type guard for tool_result-like blocks
              // Content contains ToolOutput types (BashOutput, ReadOutput, GrepOutput, etc.)
              // which are structured objects describing the tool's result
              const toolResultBlock = block as {
                tool_use_id: string;
                content: string | unknown[] | unknown;
                is_error?: boolean;
              };

              // Convert content to string representation
              // Content can be:
              // - A string (for simple text results)
              // - An array of content blocks (text, images, etc.) from Anthropic API
              // - A structured ToolOutput object (BashOutput, ReadOutput, GrepOutput, etc.)
              let contentStr: string;
              if (typeof toolResultBlock.content === 'string') {
                contentStr = toolResultBlock.content;
              } else if (Array.isArray(toolResultBlock.content)) {
                // Array of content blocks - extract text from each
                contentStr = toolResultBlock.content
                  .map((c) => {
                    if (typeof c === 'string') {
                      return c;
                    }
                    if (typeof c === 'object' && c !== null) {
                      // Could be text block, image block, etc.
                      if ('text' in c && typeof c.text === 'string') {
                        return c.text;
                      }
                      if ('type' in c && c.type === 'text' && 'text' in c) {
                        return String(c.text);
                      }
                      // For other types, stringify
                      return JSON.stringify(c, null, 2);
                    }
                    return String(c);
                  })
                  .join('\n');
              } else if (
                typeof toolResultBlock.content === 'object' &&
                toolResultBlock.content !== null
              ) {
                // Structured ToolOutput object (e.g., BashOutput with output/exitCode,
                // ReadOutput with content/total_lines, GrepOutput with matches, etc.)
                // Stringify as JSON - the renderer will format it nicely
                contentStr = JSON.stringify(toolResultBlock.content, null, 2);
              } else {
                contentStr = String(toolResultBlock.content);
              }

              // Send tool result - this will be displayed in the UI
              sendAgentEvent(mainWindow, 'tool-result-complete', {
                toolUseId: toolResultBlock.tool_use_id,
                content: contentStr,
                isError: toolResultBlock.is_error || false
              }, sessionAppIdSnapshot);
            }
          }
        }
        // Don't signal completion here - agent may still be running tools
      } else if (sdkMessage.type === 'result') {
        // Send context window info to renderer
        // Use lastAssistantInputTokens (from the last assistant message's per-step usage)
        // which represents the actual context fill — NOT the cumulative modelUsage totals
        const modelUsage = (sdkMessage as any).modelUsage as Record<string, { contextWindow: number }> | undefined;
        if (modelUsage && lastAssistantInputTokens > 0) {
          const entries = Object.entries(modelUsage);
          if (entries.length > 0) {
            const [modelKey, usage] = entries[0];
            sendAgentEvent(mainWindow, 'context-window-update', {
              model: modelKey,
              contextWindow: usage.contextWindow,
              tokensUsed: lastAssistantInputTokens
            }, sessionAppIdSnapshot);
          }
        }

        // Final result message - this is when the agent is truly done
        sendAgentEvent(mainWindow, 'message-complete', {}, sessionAppIdSnapshot);

        // Emit agent:completed event for notification system
        emitEventFromMain(mainWindow, {
          type: 'agent:completed',
          timestamp: Date.now(),
          sourceAppId: 'core',
          appId: sessionAppId,
          summary: `Task completed in ${sessionAppId}`
        });
      } else if (sdkMessage.type === 'system') {
        if (sdkMessage.subtype === 'init') {
          const sessionIdFromSdk = sdkMessage.session_id;
          if (sessionIdFromSdk) {
            setSessionId(sessionIdFromSdk);
            sendAgentEvent(mainWindow, 'session-updated', {
              sessionId: sessionIdFromSdk,
              resumed: isResumedSession
            }, sessionAppIdSnapshot);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error in streaming session:', error);
    // Resolve the ready promise on error so callers don't hang
    if (resolveSessionReady) {
      resolveSessionReady();
      resolveSessionReady = null;
    }
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    sendAgentEvent(mainWindow, 'message-error', { error: errorMessage }, sessionAppIdSnapshot);

    // Emit agent:error event for notification system
    emitEventFromMain(mainWindow, {
      type: 'agent:error',
      timestamp: Date.now(),
      sourceAppId: 'core',
      appId: sessionAppId,
      error: errorMessage
    });
  } finally {
    isProcessing = false;
    querySession = null;
    // Clear the ready promise so next session creates a new one
    sessionReadyPromise = null;

    // Resolve the termination promise to signal session has ended
    resolveTermination!();
  }
}
