# AITM Desk

A lightweight, Copilot-style macOS desktop agent for **your own models**. You get a chat UI with a main agent plus **sync, parallel and background sub-agents**, and tools that can write and **run code**. It loads skills and agents the same way GitHub Copilot does, from `<folder>/.github/` and `~/.copilot/`.

![screenshot](docs/screenshot.png)

## Features
- Works with any **OpenAI-compatible** `/v1/chat/completions` endpoint that supports streaming and tool calling. The default is `http://127.0.0.1:4141/v1` (heb-model-proxy). The proxy handles the Anthropic translation, so Claude and the OpenAI-style models all work through one adapter.
- **Skills** (`skills/*/SKILL.md`) are loaded on demand: the system prompt lists only each skill's name and description, and the model calls the `skill` tool to load the full body.
- **Agents** (`agents/*.agent.md`): the `task` tool runs one as a sub-agent with fresh context, using the agent body as its system prompt and its `tools:` list as a whitelist.
- **Sub-agents**: several `task` calls in one turn run in parallel. `mode: "background"` returns at once and the result comes back through `read_agent`. Delegation is limited to depth 2, model calls are capped by a concurrency limit, and Stop cancels the whole agent tree.
- **Tools**: `shell`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `skill`, `task`, `read_agent`, `list_agents`, `ask_user`.
- **Approval prompts** before shell commands and file writes (allow once, allow for the session, or deny).
- **Working folders**: the sidebar groups chats by folder, Copilot-style. Choose the folder when you start a new chat. Skills and agents load from that folder's `.github/` plus `~/.copilot/`.
- **Fork from any turn**: hover a turn and click *⑂ Fork from here*. You get a new chat with the history up to that point, filed under the chat it came from, and forks can be forked again.
- **Model thinking**: a Copilot-style *Thinking / Thought* block that streams the model's reasoning, then collapses to a one-line peek. Each chat picks its own effort (💭 off / low / medium / high) under its chat box; Settings sets the default for new chats. The app sends `include_reasoning` and `reasoning_effort`, and reads `reasoning_content` / `reasoning`, inline `<think>` tags, and Gemini thought parts. For Claude, the proxy has to turn on Anthropic adaptive thinking with summarized display.
- **Share a session**: click *⇪ Share* under the chat box or ⇪ on a chat in the sidebar. Export all turns or pick specific ones, optionally including tool calls and thinking. You get a Markdown file (default location `~/Documents/AITM Desk/shares/`) or a clipboard copy.
- **Memory from shared sessions**: *＋ Memory* attaches one or more exported `.md` files to a chat. Their content goes into the main agent's system prompt as prior context (capped at about 60k characters per file), so the agent picks up where the earlier session left off. Memories are saved per chat and carry over to forks.
- **Organize chats**: every chat has a ⋯ menu (or right-click) with Rename (double-click works too), Pin, Move up/down, Share, Compact and Delete.
- **Bookmarks**: a pinned section at the top of the sidebar. Use ＋ to create bookmark folders (nested is fine), and pin chats into them from the chat's ⋯ menu. Pins and folders can be reordered or moved between folders. Deleting a folder moves its pins up a level.
- **Compact history** (*⇲ Compact* under the chat box, which also shows the estimated context size): the model groups earlier turns into **related-topic clusters**, even when they aren't next to each other (it falls back to keyword overlap). Tick whole clusters or single turns to **summarize**; unticked turns are **dropped** from the agent's context. The last N turns stay word-for-word. The chat view keeps every turn and shows an expandable "Compacted" marker with the summary. Settings → *Long chats* can suggest compacting or auto-compact past a token threshold.
- **Sessions** are saved in SQLite (`node:sqlite`) under `~/Library/Application Support/aitm-desk/`.

## Run
```bash
npm install
npm run build && npm start      # desktop app
npm run dev                     # hot-reload dev mode
npm test                        # vitest (engine, tools, registry, adapter)
```

### Headless CLI (same engine)
```bash
npm run cli -- --models
npm run cli -- --cwd ~/projects/aitm --model anthropic/claude-sonnet-5 -p "load st-common and summarize it"
npm run cli -- --yes -p "..."   # auto-approve shell and file writes
```

The API key comes from Settings in the app. Otherwise it falls back to `AITM_API_KEY`, then to the `api_key` in `~/heb-model-proxy/models.json`. The base URL comes from `AITM_BASE_URL`.

## Layout
```
src/engine/    headless agent engine (adapter, registry, tools, loop, manager, session)
src/cli/       terminal runner
src/main/      Electron main: settings (safeStorage), SQLite store, IPC
src/preload/   contextBridge API
src/renderer/  React UI
docs/          design spec + implementation plan
```
