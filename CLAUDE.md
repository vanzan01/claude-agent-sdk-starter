# Claude Agent SDK Starter

## Quick Start

```bash
npm run dev          # Development mode
npm run build        # Production build
```

## Test Pipelines

```bash
npm run test:ai-news-tweet       # 3-stage pipeline demo
npm run test:bypass-auth         # SDK auth verification
npm run test:context-window      # Verify 1M context window fix (SDK bug #35214)
npm run test:context-window:bug  # Reproduce the 200k bug (no workaround)
```

## Project Structure

```
.claude/
  agents/           # Agent definitions (markdown)
  skills/           # Skill definitions with scripts
  rules/            # Auto-loaded rules for Claude Code
scripts/            # Test pipelines
src/
  main/             # Electron main process
  renderer/         # React frontend
  preload/          # IPC bridge
  shared/apps/      # App manifests
```

## Demo App: ai-news-tweet

3-stage pipeline: Researcher → Analyst → Writer

| Component | Path |
|-----------|------|
| Agents | `.claude/agents/ai-news-tweet/` |
| Skills | `.claude/skills/news-tools/`, `analysis-helper/`, `tweet-writer/` |
| Test | `scripts/test-ai-news-tweet.ts` |

## Key Rules (auto-loaded from .claude/rules/)

- **Bypass Auth**: `.claude/rules/core/bypass-auth.md` - SDK without API key
- **App Registration**: `.claude/rules/development/app-registration.md` - Adding new apps
- **Pipeline Patterns**: `.claude/rules/architecture/pipeline-patterns.md` - Running agents
- **IPC Security**: `.claude/rules/architecture/ipc-security.md` - Electron security

## Verification

```bash
npm run lint && npm run typecheck && npm run build
```
