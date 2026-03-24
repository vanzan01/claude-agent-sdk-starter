import { existsSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { query, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ChatModelPreference } from '../../../shared/types/ipc';
import {
  buildClaudeSessionEnv,
  getChatModelPreferenceSetting,
  getDebugMode,
  getMaxThinkingTokens,
  getProvider,
  getSystemPromptAppend,
  getWorkspaceDir,
  waitForWorkspaceReady
} from '../config';
import { extractLocalhostUrls } from '../url-extractor';
import type { QueuedMessage, SessionConfig, SessionState, WindowGetter } from './types';

const requireModule = createRequire(import.meta.url);

// SDK Message Types - minimal interfaces for runtime message handling
interface SDKMessageBase {
  type: string;
  subtype?: string;
  session_id?: string;
  event?: SDKStreamEvent;
  message?: SDKAssistantMessage;
}

interface SDKStreamEvent {
  type: string;
  index: number;
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    reasoning_content?: string;
  };
  content_block?: {
    type: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    content?: string | unknown;
    tool_use_id?: string;
    is_error?: boolean;
  };
}

interface SDKAssistantMessage {
  reasoning_content?: string;
  content?: Array<{
    reasoning_content?: string;
    tool_use_id?: string;
    content?: string | unknown[] | unknown;
    is_error?: boolean;
  }>;
}

const FAST_MODEL_ID = 'haiku';
const SMART_MODEL_ID = 'sonnet';
const DEEP_MODEL_ID = 'opus';

const MODEL_BY_PREFERENCE: Record<ChatModelPreference, string> = {
  fast: FAST_MODEL_ID,
  smart: SMART_MODEL_ID,
  deep: DEEP_MODEL_ID
};

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

// Plan mode state - shared across all sessions
type PermissionMode = 'bypassPermissions' | 'plan' | 'default' | 'acceptEdits';
let currentPlanMode = false;

export function isPlanModeEnabled(): boolean {
  return currentPlanMode;
}

export function setPlanMode(enabled: boolean): void {
  currentPlanMode = enabled;
}

// Current project path - shared state for tracking active project
// This is separate from per-session projectPath (each session can have its own)
let currentProjectPath: string | null = null;

/**
 * Sets the current project path. When set, new sessions will use this as their cwd.
 * This is the global "active project" that affects new sessions.
 */
export function setCurrentProjectPath(path: string | null): void {
  currentProjectPath = path;
}

/**
 * Gets the current project path, or null if no project is active.
 * Used by handlers to determine the default project for new sessions.
 */
export function getCurrentProjectPath(): string | null {
  return currentProjectPath;
}

function getCurrentPermissionMode(): PermissionMode {
  return currentPlanMode ? 'plan' : 'bypassPermissions';
}

/**
 * Session class encapsulates all state for a single conversation session.
 * This allows parallel conversations to run independently.
 *
 * NOTE: This uses 'agent:*' IPC events for compatibility with starter-kit.
 */
export class Session {
  private queryInstance: Query | null = null;
  private state: SessionState;
  private messageQueue: QueuedMessage[] = [];
  private idleTimeout: NodeJS.Timeout | null = null;
  private sessionTerminationPromise: Promise<void> | null = null;
  private sessionReadyPromise: Promise<void> | null = null;
  private resolveSessionReady: (() => void) | null = null;
  private isInterruptingResponse = false;

  // Per-session tool tracking
  private streamIndexToToolId = new Map<number, string>();
  private toolIdToName = new Map<string, string>();
  private previewToolInputBuffer = new Map<string, string>();

  // SDK session ID for resume functionality
  private sdkSessionId: string | null = null;
  private pendingResumeSessionId: string | null = null;

  // Function to get the current main window for IPC
  // Using a getter ensures we always have the latest window reference
  private getMainWindow: WindowGetter;

  // Idle timeout duration (5 minutes)
  private readonly idleTimeoutMs = 5 * 60 * 1000;

  // Max queue size per session
  private readonly maxQueueSize = 20;

  constructor(config: SessionConfig, getMainWindow: WindowGetter) {
    this.state = {
      conversationId: config.conversationId,
      projectPath: config.projectPath,
      isProcessing: false,
      shouldAbort: false,
      isAgentResponding: false,
      lastActivityAt: Date.now()
    };
    this.getMainWindow = getMainWindow;
    this.pendingResumeSessionId = config.resumeSessionId ?? null;
  }

  get conversationId(): string {
    return this.state.conversationId;
  }

  get projectPath(): string {
    return this.state.projectPath;
  }

  get isProcessing(): boolean {
    return this.state.isProcessing;
  }

  get isAgentResponding(): boolean {
    return this.state.isAgentResponding;
  }

  get isIdle(): boolean {
    // Session is only idle if not processing, not responding, AND queue is empty
    // This prevents disposing sessions that are actively streaming responses
    return (
      !this.state.isProcessing && !this.state.isAgentResponding && this.messageQueue.length === 0
    );
  }

  get queueLength(): number {
    return this.messageQueue.length;
  }

  get lastActivityAt(): number {
    return this.state.lastActivityAt;
  }

  get sessionId(): string | null {
    return this.sdkSessionId;
  }

  /**
   * Check if session is active (has a query or is processing)
   */
  isSessionActive(): boolean {
    return this.state.isProcessing || this.queryInstance !== null;
  }

  /**
   * Wait for the session to be ready to process messages.
   */
  async waitForSessionReady(): Promise<void> {
    if (this.sessionReadyPromise) {
      await this.sessionReadyPromise;
    }
  }

  /**
   * Queue a message to be sent to this session.
   */
  async queueMessage(message: SDKUserMessage['message']): Promise<void> {
    this.state.lastActivityAt = Date.now();
    this.resetIdleTimeout();

    // Check queue size limit
    if (this.messageQueue.length >= this.maxQueueSize) {
      throw new Error(
        `Message queue full (max ${this.maxQueueSize}). Please wait for current messages to process.`
      );
    }

    // Start session if not running
    if (!this.isSessionActive()) {
      this.startStreamingSession().catch((error) => {
        console.error(`[Session ${this.conversationId}] Failed to start session:`, error);
      });
    }

    // Wait for session to be ready
    await this.waitForSessionReady();

    if (!this.isSessionActive()) {
      throw new Error('Failed to start chat session');
    }

    // Queue the message
    await new Promise<void>((resolve) => {
      this.messageQueue.push({
        id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        message,
        resolve,
        timestamp: Date.now()
      });
    });
  }

  /**
   * Interrupt the current response.
   */
  async interrupt(): Promise<boolean> {
    if (!this.queryInstance) {
      return false;
    }

    if (this.isInterruptingResponse) {
      return true;
    }

    this.isInterruptingResponse = true;
    try {
      await this.queryInstance.interrupt();
      this.sendEvent('agent:message-stopped', {});
      return true;
    } catch (error) {
      console.error(`[Session ${this.conversationId}] Failed to interrupt:`, error);
      throw error;
    } finally {
      this.isInterruptingResponse = false;
    }
  }

  /**
   * Abort and clean up this session.
   */
  abort(): void {
    this.state.shouldAbort = true;
    this.abortMessageGenerator();
  }

  /**
   * Dispose of this session completely.
   */
  async dispose(): Promise<void> {
    // Capture processing state BEFORE abort() changes it
    const wasProcessing = this.state.isProcessing || this.state.isAgentResponding;

    this.abort();
    this.clearIdleTimeout();
    this.clearMessageQueue();

    // Wait for session to fully terminate
    if (this.sessionTerminationPromise) {
      await this.sessionTerminationPromise;
    }

    // CRITICAL: Notify renderer that session was stopped
    // Must happen BEFORE clearing getMainWindow reference
    if (wasProcessing) {
      this.sendEvent('agent:message-stopped', {});
    }

    this.queryInstance = null;
    // Clear the getter to avoid holding references
    this.getMainWindow = () => null;
  }

  /**
   * Reset the session (for plan mode changes, etc.)
   */
  async reset(resumeSessionId?: string | null): Promise<void> {
    this.state.shouldAbort = true;
    this.abortMessageGenerator();
    this.clearMessageQueue();

    if (resumeSessionId !== undefined) {
      this.pendingResumeSessionId = resumeSessionId;
    }

    // Wait for current session to terminate
    if (this.sessionTerminationPromise) {
      await this.sessionTerminationPromise;
    }

    // Clear session state
    this.queryInstance = null;
    this.state.isProcessing = false;
    this.state.isAgentResponding = false;
    this.state.shouldAbort = false;
    this.sessionTerminationPromise = null;
    this.sessionReadyPromise = null;
    this.resolveSessionReady = null;
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  private resetIdleTimeout(): void {
    this.clearIdleTimeout();
    this.idleTimeout = setTimeout(() => {
      // Session will be cleaned up by SessionManager
    }, this.idleTimeoutMs);
  }

  private clearIdleTimeout(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
  }

  private clearMessageQueue(): void {
    while (this.messageQueue.length > 0) {
      const item = this.messageQueue.shift();
      if (item) {
        item.resolve();
      }
    }
  }

  private abortMessageGenerator(): void {
    // The generator will check state.shouldAbort
  }

  /**
   * Send an event to the renderer with conversationId context.
   * Gets a fresh window reference each time to ensure we always have the current window.
   * Uses 'agent:*' IPC pattern for starter-kit compatibility.
   */
  private sendEvent(channel: string, data: unknown): void {
    const mainWindow = this.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, {
        conversationId: this.state.conversationId,
        ...(data as object)
      });
    }
  }

  /**
   * Async generator for streaming input mode.
   */
  private async *messageGenerator(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (this.state.shouldAbort) {
        return;
      }

      // Wait for a message to be queued
      await new Promise<void>((resolve) => {
        const checkQueue = () => {
          if (this.state.shouldAbort) {
            resolve();
            return;
          }

          if (this.messageQueue.length > 0) {
            resolve();
          } else {
            setTimeout(checkQueue, 100);
          }
        };
        checkQueue();
      });

      if (this.state.shouldAbort) {
        return;
      }

      const item = this.messageQueue.shift();
      if (item) {
        yield {
          type: 'user',
          message: item.message,
          parent_tool_use_id: null,
          session_id: this.sdkSessionId || `session-${Date.now()}`
        };
        item.resolve();
      }
    }
  }

  /**
   * Start the streaming session.
   */
  private async startStreamingSession(): Promise<void> {
    if (this.sessionTerminationPromise) {
      await this.sessionTerminationPromise;
    }

    if (this.state.isProcessing || this.queryInstance) {
      if (this.sessionReadyPromise) {
        await this.sessionReadyPromise;
      }
      return;
    }

    this.state.shouldAbort = false;
    this.state.isProcessing = true;
    this.streamIndexToToolId.clear();
    this.toolIdToName.clear();

    let resolveTermination: () => void;
    this.sessionTerminationPromise = new Promise((resolve) => {
      resolveTermination = resolve;
    });

    this.sessionReadyPromise = new Promise((resolve) => {
      this.resolveSessionReady = resolve;
    });

    await waitForWorkspaceReady();

    try {
      const env = buildClaudeSessionEnv();
      const resumeSessionId = this.pendingResumeSessionId;
      const isResumedSession = typeof resumeSessionId === 'string' && resumeSessionId.length > 0;
      this.pendingResumeSessionId = null;

      const modelId = MODEL_BY_PREFERENCE[getChatModelPreferenceSetting()] ?? FAST_MODEL_ID;
      const maxThinkingTokens = getMaxThinkingTokens();

      this.queryInstance = query({
        prompt: this.messageGenerator(),
        options: {
          model: modelId,
          maxThinkingTokens,
          settingSources: ['project'],
          permissionMode: getCurrentPermissionMode(),
          allowedTools: [
            'Bash',
            'Read',
            'Write',
            'Edit',
            'Glob',
            'Grep',
            'WebFetch',
            'WebSearch',
            'Skill',
            'Preview'
          ],
          pathToClaudeCodeExecutable: resolveClaudeCodeCli(),
          executable: 'bun',
          env,
          stderr: (message: string) => {
            // sendEvent() handles window availability internally
            if (getDebugMode()) {
              this.sendEvent('agent:debug-message', { message });
            }
          },
          systemPrompt: {
            type: 'preset',
            preset: 'claude_code',
            append: getSystemPromptAppend()
          },
          cwd: this.state.projectPath || getWorkspaceDir(),
          ...(this.state.projectPath && {
            additionalDirectories: [getWorkspaceDir()]
          }),
          includePartialMessages: true,
          ...(isResumedSession && { resume: resumeSessionId! })
        }
      });

      if (this.resolveSessionReady) {
        this.resolveSessionReady();
        this.resolveSessionReady = null;
      }

      // Process streaming responses
      for await (const sdkMessage of this.queryInstance) {
        if (this.state.shouldAbort) {
          break;
        }

        // Get fresh window reference for each message
        const mainWindow = this.getMainWindow();
        if (!mainWindow || mainWindow.isDestroyed()) {
          break;
        }

        this.handleSdkMessage(sdkMessage, isResumedSession);
      }
    } catch (error) {
      console.error(`[Session ${this.conversationId}] Error in streaming session:`, error);
      if (this.resolveSessionReady) {
        this.resolveSessionReady();
        this.resolveSessionReady = null;
      }
      // sendEvent() handles window availability internally
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      this.sendEvent('agent:message-error', { error: errorMessage });
    } finally {
      this.state.isProcessing = false;
      this.state.isAgentResponding = false;
      this.queryInstance = null;
      this.sessionReadyPromise = null;
      resolveTermination!();
    }
  }

  /**
   * Handle SDK messages and route to appropriate handlers.
   */
  private handleSdkMessage(sdkMessage: unknown, isResumedSession: boolean): void {
    const msg = sdkMessage as SDKMessageBase;
    if (msg.type === 'stream_event') {
      this.state.isAgentResponding = true;
      // Keep session alive during streaming - prevents idle timeout from disposing active sessions
      this.state.lastActivityAt = Date.now();
      if (msg.event) this.handleStreamEvent(msg.event);
    } else if (msg.type === 'assistant') {
      if (msg.message) this.handleAssistantMessage(msg.message);
    } else if (msg.type === 'result') {
      this.state.isAgentResponding = false;
      this.sendEvent('agent:message-complete', {});
    } else if (msg.type === 'system') {
      if (msg.subtype === 'init') {
        const sessionIdFromSdk = msg.session_id;
        if (sessionIdFromSdk) {
          this.sdkSessionId = sessionIdFromSdk;
          this.sendEvent('agent:session-updated', {
            sessionId: sessionIdFromSdk,
            resumed: isResumedSession
          });
        }
      }
    }
  }

  /**
   * Handle stream events (text deltas, tool calls, etc.)
   */
  private handleStreamEvent(streamEvent: SDKStreamEvent): void {
    const delta = streamEvent.delta;
    const contentBlock = streamEvent.content_block;

    if (streamEvent.type === 'content_block_delta' && delta) {
      if (delta.type === 'text_delta') {
        this.sendEvent('agent:message-chunk', { chunk: delta.text });

        // GLM provider reasoning content
        if (delta.reasoning_content && getProvider() === 'glm') {
          this.sendEvent('agent:thinking-chunk', {
            index: streamEvent.index,
            delta: delta.reasoning_content
          });
        }
      } else if (delta.type === 'thinking_delta') {
        this.sendEvent('agent:thinking-chunk', {
          index: streamEvent.index,
          delta: delta.thinking
        });
      } else if (delta.type === 'input_json_delta') {
        const toolId = this.streamIndexToToolId.get(streamEvent.index);

        if (toolId && this.previewToolInputBuffer.has(toolId)) {
          const current = this.previewToolInputBuffer.get(toolId) || '';
          this.previewToolInputBuffer.set(toolId, current + (delta.partial_json || ''));
        }

        this.sendEvent('agent:tool-input-delta', {
          index: streamEvent.index,
          toolId: toolId || '',
          delta: delta.partial_json
        });
      }
    } else if (streamEvent.type === 'content_block_start' && contentBlock) {
      if (contentBlock.type === 'thinking') {
        this.sendEvent('agent:thinking-start', { index: streamEvent.index });
      } else if (contentBlock.type === 'tool_use') {
        const toolId = contentBlock.id || '';
        const toolName = contentBlock.name || '';

        this.streamIndexToToolId.set(streamEvent.index, toolId);
        this.toolIdToName.set(toolId, toolName);

        if (toolName === 'Preview') {
          this.previewToolInputBuffer.set(toolId, '');
        }

        this.sendEvent('agent:tool-use-start', {
          id: toolId,
          name: toolName,
          input: contentBlock.input || {},
          streamIndex: streamEvent.index
        });
      } else if (this.isToolResultBlock(contentBlock)) {
        let contentStr = '';
        if (typeof contentBlock.content === 'string') {
          contentStr = contentBlock.content;
        } else if (contentBlock.content !== null && contentBlock.content !== undefined) {
          contentStr = JSON.stringify(contentBlock.content, null, 2);
        }

        if (contentStr) {
          this.sendEvent('agent:tool-result-start', {
            toolUseId: contentBlock.tool_use_id,
            content: contentStr,
            isError: contentBlock.is_error || false
          });
        }
      }
    } else if (streamEvent.type === 'content_block_stop') {
      const toolId = this.streamIndexToToolId.get(streamEvent.index);

      // Handle Preview tool completion
      if (toolId && this.previewToolInputBuffer.has(toolId)) {
        const inputJson = this.previewToolInputBuffer.get(toolId) || '';
        this.previewToolInputBuffer.delete(toolId);

        try {
          const input = JSON.parse(inputJson) as { url?: string };
          if (input.url) {
            this.sendEvent('preview:url-detected', {
              url: input.url,
              allUrls: [input.url]
            });
          }
        } catch {
          // Ignore parse errors
        }
      }

      this.sendEvent('agent:content-block-stop', {
        index: streamEvent.index,
        toolId: toolId || undefined
      });
    }
  }

  /**
   * Handle assistant messages (complete messages with tool results)
   */
  private handleAssistantMessage(assistantMessage: SDKAssistantMessage): void {
    // GLM provider reasoning content at message level
    if (assistantMessage.reasoning_content && getProvider() === 'glm') {
      this.sendEvent('agent:thinking-start', { index: -1 });
      this.sendEvent('agent:thinking-chunk', {
        index: -1,
        delta: assistantMessage.reasoning_content
      });
      this.sendEvent('agent:content-block-stop', { index: -1 });
    }

    if (assistantMessage.content) {
      for (const block of assistantMessage.content) {
        // GLM reasoning in content blocks
        if (block.reasoning_content && getProvider() === 'glm') {
          this.sendEvent('agent:thinking-chunk', {
            index: -1,
            delta: block.reasoning_content
          });
        }

        // Tool result blocks
        if (block.tool_use_id && block.content !== undefined) {
          let contentStr: string;
          if (typeof block.content === 'string') {
            contentStr = block.content;
          } else if (Array.isArray(block.content)) {
            contentStr = block.content
              .map((c) => {
                if (typeof c === 'string') return c;
                if (typeof c === 'object' && c !== null) {
                  const obj = c as Record<string, unknown>;
                  if ('text' in obj && typeof obj.text === 'string') return obj.text;
                  if ('type' in obj && obj.type === 'text' && 'text' in obj)
                    return String(obj.text);
                  return JSON.stringify(c, null, 2);
                }
                return String(c);
              })
              .join('\n');
          } else if (typeof block.content === 'object' && block.content !== null) {
            contentStr = JSON.stringify(block.content, null, 2);
          } else {
            contentStr = String(block.content);
          }

          this.sendEvent('agent:tool-result-complete', {
            toolUseId: block.tool_use_id,
            content: contentStr,
            isError: block.is_error || false
          });

          // Check for localhost URLs in Bash tool results
          const toolName = this.toolIdToName.get(block.tool_use_id);
          if (toolName === 'Bash' && !block.is_error) {
            const urlResult = extractLocalhostUrls(contentStr);
            if (urlResult.primaryUrl) {
              this.sendEvent('preview:url-detected', {
                url: urlResult.primaryUrl,
                allUrls: urlResult.allUrls
              });
            }
          }
        }
      }
    }
  }

  /**
   * Check if a content block is a tool result block.
   */
  private isToolResultBlock(block: NonNullable<SDKStreamEvent['content_block']>): boolean {
    const blockType = block.type;
    return (
      (blockType === 'web_search_tool_result' ||
        blockType === 'web_fetch_tool_result' ||
        blockType === 'code_execution_tool_result' ||
        blockType === 'bash_code_execution_tool_result' ||
        blockType === 'text_editor_code_execution_tool_result' ||
        blockType === 'mcp_tool_result') &&
      block.tool_use_id !== undefined
    );
  }
}
