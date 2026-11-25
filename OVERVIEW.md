Switch models mid-session across any ready provider in Paseo while preserving conversation context, recent edit diffs, error traces, interrupted reasoning, drafts, and workspace state with minimal disruption.

For models on the same provider, Model Switch updates the running agent in place. For models on a different provider, it compiles recent verbatim turns, failed command outputs, edit diffs, active plans, and workspace git state from a serialized incremental turn cache, saves a complete transcript atomically, creates a successor agent in the same workspace with accurate permission mode and provider-option mapping (including OpenCode `auto_accept`), silently injects the briefing and (when history was condensed) a pre-approved multi-hop transcript search tool through Paseo's `agent.open.before` hook, transfers unsent drafts and plugin attachments, closes the popover before focusing the new tab, and safely skips archiving when active subagents or background tasks exist.

## Usage

- Click the compact `⇄` pill (or switch to native Composer Toolbar mode, switch-only badge, or hidden mode in settings) to search providers, pin favorites, pick thinking effort levels, add an optional handoff note, or switch back in one click.
- Run `/m <provider/model[@thinking] | back> [--force] [--note="..."] [follow-up]` or `/switch ...` from the composer. Supports multi-slash OpenCode model IDs and restores previous thinking levels on `/m back`.
- Expand the inline banner at the top of a continued session to inspect multi-hop lineage breadcrumbs, search saved transcripts in a bounded scroll view, or switch back in one click.

## Configuration and storage

Settings live under Settings -> Plugins -> Model Switch and control composer trigger style, auto-archiving, mode mapping, verbatim turn count, context character budget, git diff/patch inclusion, recent edit/error highlight retention, and inline banner visibility.

Session transcripts, switch records (auto-pruned to the latest 200 chains), and pinned/recent preferences are stored atomically under `~/.paseo/plugin-data/model-switch/` on the daemon host. Requires Paseo daemon `>=0.17.4`.
