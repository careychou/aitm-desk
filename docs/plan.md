# AITM Desk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Copilot-like macOS Electron app that runs a main agent plus sync/parallel/background sub-agents against heb-model-proxy, loading skills, agents, and instructions from `.github/` and `~/.copilot/`.

**Architecture:** A headless TypeScript engine (adapter → loop → tools → manager) lives in `src/engine`, is driven by the Electron main process over IPC, and is also driven by a CLI for tests. The React renderer only renders events.

**Tech Stack:** Electron 33, TypeScript, React 18, Vite (electron-vite), vitest, js-yaml, better-sqlite3, marked.

Spec: `docs/superpowers/specs/2026-11-13-aitm-desk-design.md`
Repo: `github.com/careychou/aitm-desk` (local `~/projects/aitm-desk`)

## File structure
```
src/engine/types.ts              shared types (Message, ToolCall, AgentEvent, ToolDef)
src/engine/adapter/sse.ts        SSE line parser
src/engine/adapter/openai.ts     streaming client -> Delta stream
src/engine/adapter/assemble.ts   delta -> AssistantMessage accumulator
src/engine/registry/frontmatter.ts  YAML frontmatter split
src/engine/registry/registry.ts  skills/agents/instructions discovery
src/engine/prompt.ts             system prompt builder
src/engine/tools/*.ts            shell, read_file, write_file, edit_file, glob, grep, skill, task, read_agent, list_agents, ask_user
src/engine/tools/index.ts        tool registry + agent tools: mapping
src/engine/semaphore.ts          concurrency limiter
src/engine/loop.ts               AgentLoop (parallel tool execution)
src/engine/manager.ts            AgentManager (spawn/read/cancel tree, notifications)
src/engine/engine.ts             facade: createEngine(config, hooks)
src/cli/index.ts                 headless runner
src/main/{index.ts,store.ts,settings.ts,ipc.ts}   Electron main
src/preload/index.ts             contextBridge API
src/renderer/**                  React UI
tests/**                         vitest
```

## Tasks (each one: write test → see it fail → implement → see it pass → commit)
- [ ] **T1 Scaffold:** package.json, tsconfig, electron-vite config, vitest, .gitignore, README. Commit.
- [ ] **T2 SSE + assemble:** tests feed chunk fixtures (the Claude whole-args tool call and the GLM `reasoning_content` stream captured 2026-11-13) and expect assembled `{content, reasoning, tool_calls[]}`.
- [ ] **T3 OpenAI adapter:** a test against a local http server fixture covers streaming, a 401 error message, and abort.
- [ ] **T4 Frontmatter + registry:** fixtures with a good skill, a bad YAML skill (gives a warning, no throw), cwd overriding home by name, agents with `tools:`, and instruction order.
- [ ] **T5 Tools core:** tests for shell (exit code, timeout, tail truncation), read_file range, edit_file uniqueness error, glob, grep.
- [ ] **T6 Prompt builder:** the test asserts that skill name and description appear but the skill body does not.
- [ ] **T7 Semaphore + AgentLoop:** a fake adapter scripts 2 tool calls in one turn and the test checks they run concurrently (overlap timing), plus max turns, abort, and bad JSON args → a tool error.
- [ ] **T8 AgentManager + task/read_agent/list_agents:** sync returns the final text. Parallel task calls overlap. Background returns an id; read_agent(wait) returns the result, and a notification reaches the parent. Depth limit 2. Cancel cascades.
- [ ] **T9 Engine facade + CLI:** the CLI streams to stdout and auto-approves with `--yes`. Live smoke test against the proxy (Claude and GLM, one skill load).
- [ ] **T10 Electron main:** settings (safeStorage key), SQLite store, IPC (send, stop, approve, answer, list sessions, models).
- [ ] **T11 Renderer:** sidebar, empty state, chat stream, tool and sub-agent cards, approval and ask cards, agents tray, settings modal.
- [ ] **T12 Build + push:** `npm run build`, launch the app to confirm the window renders, create `careychou/aitm-desk` (private), push.
