/**
 * Config Bridge
 * Exposes configuration operations to the renderer.
 */
import type { IpcRenderer } from 'electron';
import type { ModelProvider, ThinkingLevel } from '../../shared/core';
import type { ConfigBridge, ModelConfig } from '../../shared/types/electron-api';

export function createConfigBridge(ipcRenderer: IpcRenderer): ConfigBridge {
  return {
    // Workspace
    getWorkspaceDir: () => ipcRenderer.invoke('config:get-workspace-dir'),
    getAppPath: () => ipcRenderer.invoke('config:get-app-path'),
    setWorkspaceDir: (workspaceDir: string) =>
      ipcRenderer.invoke('config:set-workspace-dir', workspaceDir),
    selectWorkspaceDir: () => ipcRenderer.invoke('config:select-workspace-dir'),

    // Layered config status
    getConfigStatus: () => ipcRenderer.invoke('config:get-config-status'),
    initProjectConfig: () => ipcRenderer.invoke('config:init-project-config'),
    getMergedConfig: () => ipcRenderer.invoke('config:get-merged-config'),

    // Debug mode
    getDebugMode: () => ipcRenderer.invoke('config:get-debug-mode'),
    setDebugMode: (debugMode: boolean) => ipcRenderer.invoke('config:set-debug-mode', debugMode),

    // Floating nav
    getFloatingNav: () => ipcRenderer.invoke('config:get-floating-nav'),
    setFloatingNav: (enabled: boolean) => ipcRenderer.invoke('config:set-floating-nav', enabled),

    // Advisor tool
    getAdvisorEnabled: () => ipcRenderer.invoke('config:get-advisor-enabled'),
    setAdvisorEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('config:set-advisor-enabled', enabled),

    // Diagnostics
    getPathInfo: () => ipcRenderer.invoke('config:get-path-info'),
    getEnvVars: () => ipcRenderer.invoke('config:get-env-vars'),
    getDiagnosticMetadata: () => ipcRenderer.invoke('config:get-diagnostic-metadata'),

    // API key
    getApiKeyStatus: () => ipcRenderer.invoke('config:get-api-key-status'),
    setApiKey: (apiKey?: string | null) => ipcRenderer.invoke('config:set-api-key', apiKey),

    // Thinking level
    getThinkingLevel: () => ipcRenderer.invoke('config:get-thinking-level'),
    setThinkingLevel: (level: string) =>
      ipcRenderer.invoke('config:set-thinking-level', level as ThinkingLevel),
    getThinkingPresets: () => ipcRenderer.invoke('config:get-thinking-presets'),

    // System prompt
    getSystemPromptAppend: () => ipcRenderer.invoke('config:get-system-prompt-append'),
    setSystemPromptAppend: (text: string | null) =>
      ipcRenderer.invoke('config:set-system-prompt-append', text),
    getDefaultSystemPromptAppend: () =>
      ipcRenderer.invoke('config:get-default-system-prompt-append'),

    // Provider configuration
    getProvider: () => ipcRenderer.invoke('config:get-provider'),
    setProvider: (provider: ModelProvider) => ipcRenderer.invoke('config:set-provider', provider),
    getGlmConfig: () => ipcRenderer.invoke('config:get-glm-config'),
    setGlmApiKey: (apiKey: string | null) => ipcRenderer.invoke('config:set-glm-api-key', apiKey),
    setGlmBaseUrl: (baseUrl: string | null) =>
      ipcRenderer.invoke('config:set-glm-base-url', baseUrl),
    getDefaultGlmBaseUrl: () => ipcRenderer.invoke('config:get-default-glm-base-url'),

    // Model IDs configuration
    getAnthropicModels: () => ipcRenderer.invoke('config:get-anthropic-models'),
    setAnthropicModels: (models: ModelConfig) =>
      ipcRenderer.invoke('config:set-anthropic-models', models),
    getDefaultAnthropicModels: () => ipcRenderer.invoke('config:get-default-anthropic-models'),
    getGlmModels: () => ipcRenderer.invoke('config:get-glm-models'),
    setGlmModels: (models: ModelConfig) => ipcRenderer.invoke('config:set-glm-models', models),
    getDefaultGlmModels: () => ipcRenderer.invoke('config:get-default-glm-models'),

    // App settings
    getAppSettings: (appId: string) => ipcRenderer.invoke('config:get-app-settings', appId),
    setAppSettings: (appId: string, settings) =>
      ipcRenderer.invoke('config:set-app-settings', appId, settings),

    // Skills
    getSkillStatus: (appId: string) => ipcRenderer.invoke('skills:get-status', appId),

    // Event listeners
    onWorkspaceChanged: (callback) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        data: { workspaceDir: string; provider: ModelProvider }
      ) => callback(data);
      ipcRenderer.on('config:workspace-changed', listener);
      return () => ipcRenderer.removeListener('config:workspace-changed', listener);
    },
    onFloatingNavChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, data: { enabled: boolean }) =>
        callback(data);
      ipcRenderer.on('config:floating-nav-changed', listener);
      return () => ipcRenderer.removeListener('config:floating-nav-changed', listener);
    }
  };
}
