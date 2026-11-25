# paseo-model-switch

Seamless mid-session model switching plugin for [Paseo](https://paseo.sh), supporting both same-provider hot-swaps and cross-provider session continuation (`antigravity`, `codex`, `opencode`, `claude`, `copilot`, `pi`, etc.) with minimal user disruption.

## Install

Requires Paseo daemon `>=0.17.4` with plugins enabled.

```bash
paseo plugin install github:shinelinxx/paseo-model-switch
```

## Features

- **Unified Entry Points**:
  - Compact composer pill (`⇄ 切` / `⇄ ×N`), configurable in **Settings → Plugins → Model Switch** (`compact`, `toolbar`, `when-switched`, `hidden`).
  - Desktop auto-focused search popover with **Enter-to-switch**, provider filter chips, pinned favorites, recent models, inline thinking-effort chips, optional handoff notes, and a one-tap switch-back shortcut.
  - Slash commands `/m` and `/switch`, plus `⌘K` Command Center entry.
- **Same-Provider vs Cross-Provider Routing**:
  - **Same provider**: updates the active agent in place via `composer.setModel()` / `setThinking()`.
  - **Cross provider**: extracts the full timeline via a serialized incremental cache, compiles a CJK-aware budgeted briefing (prioritizing edits, failed command traces, active plans, interrupted reasoning on `--force`, and workspace git state), silently injects context via `agent.open.before` (`appendSystemPrompt`), conditionally attaches a pre-approved multi-hop transcript search tool (`read_previous_session_context`), transfers unsent drafts & plugin attachments, focuses the new tab, and safely skips archiving when active subagents or background tasks exist.
  - **Empty session fast path**: switching providers on a fresh 0-turn tab skips synthetic briefings and banners for zero noise.
- **Accurate Mode & Option Mapping**:
  - Semantically maps `plan`, `auto`, `accept-edits`, and `full-access` across providers, including bidirectional sync with OpenCode's `build` + `auto_accept` option.
- **Multi-Hop Lineage & Inline Banner**:
  - Collapsible top banner with multi-hop breadcrumbs (`#1 → #2`), bounded scrollable transcript search, and one-click switch-back restoring the previous thinking level.

## Slash Command Cheat Sheet

```text
/m codex/gpt-6.2-sol                          # Switch to specific provider/model
/m codex/gpt-6.2-sol@xhigh                    # Switch with explicit thinking level
/m opencode/tencent/deepseek/deepseek-flash   # Multi-slash OpenCode model IDs
/m back                                       # Switch back (restores previous thinking level)
/m back@low                                   # Switch back with overridden thinking level
/m codex/gpt-6.2-sol 继续排查 auth.ts 报错      # Switch and send follow-up prompt in one step
/m --force --note="只审查不改文件" codex         # Stop running turn & inject silent handoff note
```

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-model-switch --id model-switch
paseo plugin reload model-switch
```

## License

MIT
