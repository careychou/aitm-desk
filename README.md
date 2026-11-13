# AITM Desk

**A lightweight, Copilot-style desktop agent for _your own_ models.**

AITM Desk is a small macOS app that gives you a GitHub Copilot–like chat experience — a main agent that can call tools, load skills, and delegate to sub-agents — but pointed at **any OpenAI-compatible model endpoint** you control (a local proxy, vLLM, Ollama, LiteLLM, a cloud gateway, …). No repo, git or PR features: just a prompt box, an agent, and your working folder.

It reads skills and agents from the same places Copilot does — `<folder>/.github/` and `~/.copilot/` — so an existing skill/agent library works out of the box.

![AITM Desk: parallel sub-agents, skills, thinking blocks](docs/screenshot.png)

## Download

Grab the latest build from **[Releases](https://github.com/careychou/aitm-desk/releases)**:

| File | What |
|---|---|
| `AITM-Desk-<version>-arm64.dmg` | Installer for Apple Silicon Macs (drag to Applications) |
| `AITM-Desk-<version>-arm64.zip` | Same app, zipped |

> **The app is not code-signed.** macOS will say it "is damaged" or "can't be opened". After copying it to Applications, run once:
> ```bash
> xattr -cr "/Applications/AITM Desk.app"
> ```
> Or right-click the app → **Open**. Intel Macs: build from source (below).

On first launch open **⚙ Settings** and set your model endpoint's **Base URL** and **API key**, then click *Test connection*.

## Main features

### Agent
- **Any OpenAI-compatible model** — streaming `/v1/chat/completions` with tool calling. The model list comes from `/v1/models`; switch models per chat.
- **Tools** — `shell`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`, `skill`, `task`, `read_agent`, `list_agents`, `ask_user`. Independent tool calls run in parallel.
- **Approvals** — shell commands and file writes ask first: *allow once*, *allow for this chat*, or *deny*.
- **Sub-agents** — the `task` tool runs a sub-agent with fresh context. Several `task` calls in one turn run **in parallel**; `mode: "background"` returns immediately and the result is fetched later with `read_agent` (the main agent is woken when it finishes). Nested delegation is capped at depth 2; Stop cancels the whole tree.
- **Model thinking** — a Copilot-style *Thinking → Thought* block streams the model's reasoning and collapses to a one-line peek. Per-chat effort: 💭 off / low / medium / high. Reads `reasoning_content` / `reasoning`, inline `<think>` tags, and Gemini thought parts.

### Skills & agents (Copilot-compatible)
- **Skills**: `skills/<name>/SKILL.md` with YAML front-matter (`name`, `description`). Only names + descriptions go into the prompt; the model loads a skill's full body on demand with the `skill` tool.
- **Agents**: `agents/<name>.agent.md` (`name`, `description`, `tools`). The body becomes the sub-agent's system prompt and `tools:` its whitelist (aliases like `read`, `search`, `edit`, `execute`, `agent` are understood).
- Loaded from the chat's working folder (`.github/`) **plus** your personal `~/.copilot/`; also picks up `copilot-instructions.md` from both.

### Chats & organization
- **Working folders** — the sidebar groups chats by folder, Copilot-style. Pick the folder when starting a chat; skills/agents reload per folder.
- **Fork from any turn** — hover a turn → *⑂ Fork from here*. The fork gets the history up to that point and is filed **under the chat it came from** (forks of forks nest).
- **Drag & drop** — drag chats to reorder them (within the same folder/level), drag a chat onto **Bookmarks** or a bookmark folder to pin it, and drag pins/folders to reorder or nest them.
- **Rename & delete** — double-click to rename, or use the ⋯ menu / right-click.
- **Bookmarks** — a pinned section at the top of the sidebar with nestable folders.

### Attachments
- **Paste, drop or 📎** — paste screenshots/files (⌘V), drag files anywhere onto the window, or pick them with 📎. Chips show the size before → after and estimated tokens.
- **Images** (PNG, JPEG, GIF, WebP, HEIC, TIFF, BMP): downscaled to a max edge (default 1568 px) and re-encoded (JPEG q82, stepping down until ≤ 1.5 MB). They are sent as `image_url` parts and look the same to the model at a fraction of the size.
- **Documents**: PDF (text per page; scanned PDFs fall back to a page image), Word/RTF/ODT/HTML (via macOS `textutil`), PowerPoint (slide text), Excel (sheet rows), and any plain-text or code file. Text is whitespace-normalized and long files are trimmed head + tail (default 80k chars).
- **Request-size guard**: images are re-sent only for the last N prompts (default 4; older ones become a note), and the oldest images are dropped if a request would exceed the cap (default 20 MB, safely under Vertex's 30 MB). All limits are in Settings → *Attachments*.

### Memory & context
- **Share a session** — export **all turns or selected turns** to Markdown (optionally with tool calls and thinking), save to a file or copy to clipboard.
- **Attach exports as memory** — *＋ Memory* attaches one or more exported `.md` files to a chat; the agent starts with them as prior context. Great for handing work between sessions or people.
- **Smart compaction**: *⇲ Compact* (which also shows the estimated context size) has two modes. **Keep the last N turns** word-for-word and summarize everything before them, or **Choose turns** and set each turn to **Keep · Summarize · Drop**. You can set a turn singly, or set a whole **related-topic cluster** at once (clusters can be non-adjacent when a long chat pivoted and came back). Kept turns can be anywhere in the chat, so an important early instruction stays verbatim. Forks made after a compaction still line up with the right turns. Long chats can be flagged or auto-compacted past a token threshold (Settings → *Long chats*).

### Under the hood
- Electron + React UI over a **headless TypeScript engine** (also usable from a CLI).
- Sessions, forks and bookmarks are stored locally in SQLite (`node:sqlite`) at `~/.aitm-desk/aitm.db`, with settings in `~/.aitm-desk/settings.json`. Set `AITM_HOME` to use another folder. The API key is encrypted with the macOS Keychain (`safeStorage`). Builds before 0.3 kept these files in `~/Library/Application Support/aitm-desk/`; they are copied over on first launch and the originals are left in place as a backup.
- No telemetry. The only network calls go to the model endpoint you configure.

## Model endpoint notes

Any endpoint that speaks the OpenAI Chat Completions API with streaming + tools works. Defaults: `http://127.0.0.1:4141/v1` (override in Settings or with `AITM_BASE_URL` / `AITM_API_KEY`).

For thinking blocks the app sends `reasoning_effort` and a non-standard `include_reasoning: true` hint. Models that already stream `reasoning_content` (DeepSeek, GLM, gpt-oss, Qwen…) just work. For Anthropic Claude behind an OpenAI-style proxy, the proxy must enable Claude's (adaptive, summarized) extended thinking and map it to `reasoning_content`.

## Build from source

Requires Node 22.5+ (for `node:sqlite`) — tested with Node 25.

```bash
git clone https://github.com/careychou/aitm-desk.git
cd aitm-desk
npm install
npm run dev            # hot-reload dev mode
npm test               # vitest: engine, tools, registry, adapter, compaction, export
npm run dist           # → dist/AITM Desk-<version>-arm64.dmg / .zip
npm run dist:dir       # → dist/mac-arm64/AITM Desk.app (fast, unpacked)
```

### Headless CLI (same engine)
```bash
npm run cli -- --models
npm run cli -- --cwd ~/my-project --model my-model -p "list the skills you have"
npm run cli -- --yes -p "..."   # auto-approve shell and file writes
```

## Project layout
```
src/engine/    headless agent engine: adapter, registry, tools, loop, sub-agent manager, session, compaction
src/cli/       terminal runner
src/main/      Electron main: settings (safeStorage), SQLite store, IPC
src/preload/   contextBridge API
src/renderer/  React UI
src/shared/    fork/tree, export helpers shared by main + renderer
docs/          design spec + implementation plan
```

## Status

Early, personal project (v0.1). macOS / Apple Silicon is the only packaged target. Issues and PRs welcome.

## License

[MIT](LICENSE)
