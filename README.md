# Reverie

> Bicameral memory for AI-assisted development.

A CLI + MCP server that bootstraps persistent project context for any AI agent — Claude Code, Copilot, ChatGPT, Cursor, and beyond. Agents read the project's "other voice" at session start, write back what they learn, and the codex grows session over session.

A SeaBear Studios product · [seabear.dev/reverie](https://seabear.dev/reverie)

> Previously known as **codexCLI**. See the [CHANGELOG](CHANGELOG.md) for the rebrand provenance and migration notes.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Installation](#installation)
- [Environment Variables](#environment-variables)
- [Usage](#usage)
  - [Storing Data](#storing-data)
  - [Retrieving Data](#retrieving-data)
  - [Running Commands](#running-commands)
  - [Searching](#searching)
  - [Aliases](#aliases)
  - [Copying Data](#copying-data)
  - [Renaming](#renaming)
  - [Editing Data](#editing-data)
  - [Removing Data](#removing-data)
  - [Context (Knowledge Summary)](#context-knowledge-summary)
  - [Run Confirmation](#run-confirmation)
  - [Interpolation](#interpolation)
    - [Conditional Interpolation](#conditional-interpolation)
    - [Exec Interpolation](#exec-interpolation)
  - [Encryption](#encryption)
  - [Configuration](#configuration)
  - [Project-Scoped Data](#project-scoped-data)
  - [Data Management](#data-management)
  - [Staleness Detection](#staleness-detection)
  - [Schema Validation](#schema-validation)
  - [Shell Wrapper](#shell-wrapper)
  - [Shell Tab-Completion](#shell-tab-completion)
  - [Scripting Tips](#scripting-tips)
  - [Debugging](#debugging)
- [Command Reference](#command-reference)
- [MCP Server (AI Agent Integration)](#mcp-server-ai-agent-integration)
- [Documentation](#documentation)
- [Development](#development)
- [License](#license)

## Overview

Reverie is a command-line tool and AI agent knowledge base. It stores structured information using hierarchical dot notation (similar to JSON) and exposes it to AI agents via MCP. The goal: make AI agents more effective by giving them persistent, shared project context across sessions.

## Features

- **Hierarchical Data Storage**: Store data using intuitive dot notation paths (e.g., `server.production.ip`)
- **Command Runner**: Execute stored shell commands with dry-run, composition (`:`) and chaining (`&&`), and optional per-entry confirmation
- **Interpolation**: Reference stored values with `${key}`, execute stored commands with `$(key)`, and use conditional defaults `${key:-fallback}` — all resolved at read time
- **Aliases**: Create shortcuts to frequently accessed paths
- **Encryption**: Password-protect sensitive values
- **Search**: Find entries by searching keys or values
- **Tree Visualization**: Display nested data in a tree-like structure
- **Clipboard Integration**: Copy values directly to clipboard (macOS, Linux, Windows)
- **Inline Editing**: Open entries in `$EDITOR` / `$VISUAL` for quick edits
- **JSON Output**: Machine-readable `--json` flag on `get` and `find` for scripting
- **Stdin Piping**: Pipe values into `set` from other commands
- **Project-Scoped Data**: Opt-in `.codexcli/` per project — project entries take precedence, fall through to global
- **Smart Init**: `rvr init` scans your codebase, populates `.codexcli/` with project/commands/files/deps/conventions/context entries, generates `CLAUDE.md`, and seeds the three-file knowledge convention
- **Auto-Backup**: Automatic timestamped backups with configurable rotation (`max_backups` setting)
- **File Locking**: Advisory locking prevents data corruption from concurrent access
- **Shell Tab-Completion**: Full tab-completion for Bash and Zsh (commands, flags, keys, aliases)
- **Staleness Detection**: Track when entries were last updated, find stale knowledge (`rvr stale`), inline `[untracked]` / `[Nd]` warnings on `get` and `context` output
- **Schema Validation**: Check entries against recommended namespaces (`rvr lint`), customizable via `_schema.namespaces`
- **MCP Server**: 19 tools for any MCP-compatible AI agent (Claude Code, Copilot, ChatGPT, etc.) via the Model Context Protocol
- **Telemetry & Audit**: Track usage patterns with scope-aware telemetry (`rvr stats`) and full audit log with before/after diffs, hit/miss tracking, and per-entry metrics (`rvr audit --detailed`). Includes [net token savings with self-calibrating exploration cost estimates](docs/token-savings.md), miss-path tracking, and per-agent breakdown.
- **Cross-Session Handoff**: `codex_context` surfaces a top banner from `context.next_session` so the next session reads where things stand before any other work (auto-staled past 7 days)
- **Project-Resolution Guardrail**: writes refuse with a structured `PROJECT_UNRESOLVED` error when no `.codexcli/` resolves and no explicit scope is given — prevents project-shaped data from silently landing in the global store
- **Bootstrap Size Budget**: `codex_context` sheds entries by priority when the projected response exceeds `bootstrap_max_response_bytes` (default 50KB) — `files.*` first, then `arch.*`, then large `context.*` largest-first, with a one-line trimmed-notice listing what was dropped. `tier:"full"` opts out
- **Write-Amp Guard**: `codex_set` warns on the 3rd+ write of the same key in a session within 30 minutes — informational, the write still succeeds. Helps agents notice when a key is being used as scratch space rather than a stable seed

## Installation

### Homebrew (macOS / Linux)

```bash
brew tap seabearDEV/reverie
brew install rvr
```

### Download Binary

Download the latest release for your platform from [GitHub Releases](https://github.com/seabearDEV/reverie/releases/latest).

```bash
# macOS (Apple Silicon)
curl -fsSL https://github.com/seabearDEV/reverie/releases/latest/download/rvr-macos-arm64 -o rvr
chmod +x rvr && sudo mv rvr /usr/local/bin/

# macOS (Intel)
curl -fsSL https://github.com/seabearDEV/reverie/releases/latest/download/rvr-macos-x64 -o rvr
chmod +x rvr && sudo mv rvr /usr/local/bin/

# Linux (x64)
curl -fsSL https://github.com/seabearDEV/reverie/releases/latest/download/rvr-linux-x64 -o rvr
chmod +x rvr && sudo mv rvr /usr/local/bin/

# Linux (ARM64)
curl -fsSL https://github.com/seabearDEV/reverie/releases/latest/download/rvr-linux-arm64 -o rvr
chmod +x rvr && sudo mv rvr /usr/local/bin/

# Windows (x64) — download from:
# https://github.com/seabearDEV/reverie/releases/latest/download/rvr-win-x64.exe

# First run will prompt to install shell completions
rvr
```

### Install from Source

> **Note:** Installing from source registers the development binary `rvr-dev` (not `rvr`). All examples in this README use `rvr`, but substitute `rvr-dev` if you installed from source. The production `rvr` binary is available via Homebrew or the GitHub Releases download above.

Ensure npm's global binaries are in your PATH by adding the following to your shell profile (`.bashrc`, `.zshrc`, or equivalent):

```bash
export PATH="$(npm config get prefix)/bin:$PATH"
```

```bash
git clone https://github.com/seabearDEV/reverie.git
cd reverie
npm install
npm run build
npm install -g .
```

If `rvr-dev` is not found after installing, verify that npm's global bin directory is in your PATH:

```bash
echo $PATH | grep -o "$(npm config get prefix)/bin"
```

## Environment Variables

Reverie honors a small set of environment variables for deployment-time configuration. All are optional — sensible defaults work for most users. (For interactive UI preferences like color and pager, see [Configuration](#configuration) under Usage.)

| Variable | Purpose | Default |
| --- | --- | --- |
| `CODEX_DATA_DIR` | Override the global data directory. Must be an absolute path. All global state lives here: the entry store (`store/`), config, audit log, telemetry. | `~/.codexcli` |
| `CODEX_PROJECT` | Explicit path to a `.codexcli/` directory, a legacy `.codexcli.json` file, or a containing directory. Fails closed if the path doesn't resolve — no `cwd` walk-up fallback. | unset (walk up from `cwd`) |
| `CODEX_PROJECT_DIR` | MCP-server launcher hint — the directory the server should treat as the project root. Equivalent to passing `--cwd <dir>`. Applied via `setProjectRootOverride` (no `process.chdir`), so it works whether the server is run as a binary or imported. | unset |
| `CODEX_NO_PROJECT` | Disable project-file lookup entirely. Set to any non-empty value (e.g. `1`) and `findProjectFile()` returns `null` regardless of `cwd` or `CODEX_PROJECT`. | unset |
| `CODEX_AGENT_NAME` | Identifier recorded in the audit and telemetry logs for the calling agent. Used by `rvr stats` and `rvr audit` to break down activity per agent (Claude, Cursor, Copilot, etc.). | unset |
| `CODEX_DISABLE_LOCKING` | **Test-only.** When set to `1`, `withFileLock` falls back to running its closure without acquiring the file lock if lock acquisition fails. The default (production) behavior since v1.11 is to fail closed and propagate the lock error. Production code should never set this — there are no known production environments where lock acquisition is expected to fail. Tests that intentionally exercise contended-lock scenarios use this opt-out instead. | unset |

### Notes

- **`CODEX_DATA_DIR` must be absolute.** Relative paths (`./mydata`, `~/foo`) are rejected with a hard error rather than silently resolved against `process.cwd()`. Pass an expanded absolute path.
- **Verify your data directory** at any time with `rvr info` — the `Data` line shows the resolved path and is annotated with `(CODEX_DATA_DIR)` when the env var is set.
- **Pin the project root** for the MCP server in `.claude.json` by setting `"env": { "CODEX_PROJECT": "<repo path>" }` in the reverie MCP block. This is more deterministic than relying on `cwd` walk-up.

## Usage

### Storing Data

```bash
# Set a simple entry
rvr set mykey "my value"

# Set a nested entry using dot notation
rvr set server.production.ip 192.168.1.100

# Set with an alias
rvr set server.production.ip 192.168.1.100 -a ip

# Overwrite without confirmation
rvr set server.production.ip 10.0.0.1 -f

# Read value interactively (avoids shell expansion of $, !, etc.)
rvr set secret.token -p

# Same, but with visible input
rvr set secret.token -p --show

# Encrypt a value
rvr set api.key sk-secret-123 -e

# Mark an entry as requiring confirmation before running
rvr set commands.deploy "./deploy.sh" --confirm

# Remove the confirmation requirement from an entry
rvr set commands.deploy --no-confirm

# Batch set multiple key=value pairs
rvr set a=1 b=2 c=3

# Pipe a value from stdin
echo "my value" | rvr set mykey

# Pipe from another command
curl -s https://api.example.com/token | rvr set api.token
```

After setting an entry, you'll be asked interactively whether it should require confirmation to run. Use `--confirm` or `--no-confirm` to skip the prompt.

### Retrieving Data

When inside a project directory (one with a `.codexcli/` store), `get` shows project entries by default. Use `-G` for global entries or `-A` for both. Outside a project, `get` shows global entries. Looking up a specific key always falls through from project to global automatically.

```bash
# List keys in the current scope
rvr get

# List keys with values
rvr get -v

# Get a specific entry (leaf values always show their value)
rvr get server.production.ip

# List keys in a namespace
rvr get server

# List keys in a namespace with values
rvr get server -v

# Show global entries only (when inside a project)
rvr get -G

# Show entries from all scopes with section headers
rvr get -A

# Limit key depth (1 = top-level, 2 = two levels, etc.)
rvr get -k 1
rvr get -k 2 -v           # two levels with values

# Display as a tree structure (keys only by default)
rvr get --tree
rvr get --tree --values   # tree with values
rvr get --tree -k 2       # tree limited to 2 levels

# Output plain text without colors (for scripting)
rvr get server.production.ip -p

# Show stored value before interpolation
rvr get paths.myproject --source

# Decrypt an encrypted value
rvr get api.key -d

# Copy value to clipboard
rvr get server.ip -c

# Output as JSON (for scripting)
rvr get server --json

# List all aliases
rvr alias list
```

### Running Commands

Commands run immediately by default. Entries marked with `--confirm` at set time will prompt before executing. Use `-y` to skip the prompt.

```bash
# Execute a stored command (runs immediately unless marked --confirm)
rvr run deploy.cmd

# Skip the confirmation prompt (for entries marked --confirm)
rvr run deploy.cmd -y

# Dry run (print without executing)
rvr run deploy.cmd --dry

# Chain multiple commands with &&
rvr run nav.project commands.list -y
# → cd /path/to/project && ls -l

# Compose a command from fragments using :
rvr run commands.cd:paths.project -y
# → cd /path/to/project

# Combine composition and chaining
rvr run commands.cd:paths.project commands.list -y
# → cd /path/to/project && ls -l

# Multiple colon-separated segments
rvr run commands.scp:files.config:targets.prod -y
# → scp ./config.yml admin@prod:/etc/app/

# Decrypt and run an encrypted command
rvr run secret.script -d -y

# Capture output for piping (instead of inheriting stdio)
rvr run cmd.echo --capture | tr a-z A-Z

# Stored command chain (macro) — value is space-separated key refs
rvr set macros.deploy "commands.build commands.test commands.deploy"
rvr run macros.deploy --chain -y
# → npm run build && npm test && ./deploy.sh
```

### Searching

```bash
# Search keys and values
rvr find 192.168

# Search data entries only (skip aliases)
rvr find prod -e

# Search aliases only
rvr find ip -a

# Show results as a tree
rvr find server -t

# Output as JSON (for scripting)
rvr find prod --json

# Search with regex
rvr find "prod.*ip" --regex

# Search keys only (skip value matching)
rvr find "server" --keys

# Search values only (skip key matching)
rvr find "10.0" --values
```

### Aliases

Aliases are shortcuts to frequently used key paths. Managed via the `alias` subcommand:

```bash
# Create an alias
rvr alias set ip server.production.ip

# List all aliases
rvr alias list

# Remove an alias
rvr alias remove ip

# Rename an alias
rvr alias rename ip sip

# Use an alias anywhere you'd use a key
rvr get ip
rvr run ip

# Create an alias inline when setting an entry
rvr set server.production.ip 192.168.1.100 -a ip

# Remove an entry and its alias
rvr remove server.production.ip
```

### Copying Data

Copy an entry (or an entire subtree) to a new key:

```bash
# Copy a single entry
rvr copy server.ip server.ip.backup

# Copy an entire subtree
rvr copy server server.backup

# Overwrite destination without confirmation
rvr cp server.ip server.ip.backup -f
```

### Renaming

Rename entry keys or aliases without re-creating them:

```bash
# Rename an entry key (moves the value, updates aliases)
rvr rename server.old server.new

# Rename an alias
rvr alias rename oldalias newalias

# Rename a key and set a new alias on it
rvr rename server.old server.new --set-alias sn
```

### Editing Data

Open a stored value in your `$EDITOR` (or `$VISUAL`) for inline editing:

```bash
# Edit an entry in your default editor
rvr edit server.production.ip

# Edit an encrypted entry (decrypts before editing, re-encrypts on save)
rvr edit api.key --decrypt
```

### Removing Data

Removing an entry prompts for confirmation. Use `-f` to skip.

```bash
# Remove an entry (prompts for confirmation)
rvr remove server.old

# Remove without confirmation
rvr remove server.old -f

# Remove an alias only (keep the entry)
rvr alias remove myalias
```

### Interpolation

Reference stored values inside other values with `${key}` syntax. References are resolved at read time.

```bash
# Store a base path
rvr set paths.github "/Users/me/Projects/github.com"

# Reference it in another entry
rvr set paths.myproject 'cd ${paths.github}/myproject'

# Resolves at read time
rvr get paths.myproject
# → cd /Users/me/Projects/github.com/myproject

# Works with run too
rvr run paths.myproject -y

# Use --source to see the raw stored value
rvr get paths.myproject --source

# Use --prompt (-p) when setting to avoid shell expansion of ${}
rvr set paths.myproject -p
```

#### Conditional Interpolation

Use bash-style modifiers for fallback values and required-key checks:

```bash
# Default value — use fallback when key is not found
rvr set greeting 'Hello, ${user.name:-stranger}!'
rvr get greeting
# → Hello, stranger!    (if user.name doesn't exist)
# → Hello, Alice!       (if user.name is "Alice")

# Required value — throw a custom error when key is not found
rvr set deploy.cmd 'ssh ${deploy.host:?deploy.host must be set first}'
rvr run deploy.cmd
# → Error: deploy.host must be set first

# Nested defaults — the fallback can itself contain ${} references
rvr set url '${api.url:-${api.default_url}}/endpoint'

# Empty default — resolves to empty string when key is missing
rvr set optional '${maybe.key:-}'
```

#### Exec Interpolation

Use `$(key)` to execute a stored command and substitute its stdout. The key must reference a stored string value containing a shell command.

```bash
# Store a command
rvr set system.user "whoami"

# Reference it with $(key) — executes the command and substitutes the output
rvr set paths.home '/Users/$(system.user)'

rvr get paths.home
# → /Users/kh

# See the raw value without executing
rvr get paths.home --source
# → /Users/$(system.user)

# Aliases work too
rvr set system.user -a user
rvr set paths.home '/Users/$(user)'
```

Exec interpolation supports:

- **Recursion**: stored commands can contain `${key}` or `$(key)` references that resolve before execution
- **Caching**: the same key is only executed once per interpolation pass
- **Circular detection**: `$(a)` → `$(b)` → `$(a)` throws an error
- **Timeout**: commands are killed after 10 seconds
- **Cross-type references**: `${key}` values can contain `$(key)` and vice versa

### Encryption

```bash
# Encrypt a value (prompts for password twice)
rvr set api.key sk-secret-123 -e

# Encrypted values show as [encrypted]
rvr get api.key
# → api.key: [encrypted]

# Decrypt to view
rvr get api.key -d

# Decrypt and copy to clipboard
rvr get api.key -d -c

# Decrypt and run
rvr run secret.deploy -d -y

# Clear terminal after setting sensitive data
rvr set api.key -p -e -c
```

### Configuration

```bash
# Show all settings
rvr config

# Get a specific setting
rvr config get theme

# Change a setting
rvr config set theme dark
rvr config set colors false

# Show version, stats, and storage paths
rvr info

# Show usage examples
rvr config examples
```

Available settings:

| Setting            | Values                       | Description                                                    |
|--------------------|------------------------------|----------------------------------------------------------------|
| `colors`           | `true` / `false`             | Enable/disable colored output                                  |
| `theme`            | `default` / `dark` / `light` | UI theme                                                       |
| `max_backups`      | integer (default: `10`)      | Number of auto-backups to keep (`0` to disable)                |
| `import_max_bytes` | integer (default: `52428800` / 50 MB) | Reject import files larger than this (bytes) to prevent OOM |

### Project-Scoped Data

Reverie supports per-project knowledge stores that live alongside your code. The `.codexcli/` directory is designed to be committed to version control, creating a shared knowledge base that persists across sessions, team members, and AI agents. As of v1.10.0, each entry is its own JSON file inside the directory (`.codexcli/arch.storage.json`, `.codexcli/commands.build.json`, etc.) — this eliminates merge conflict churn when multiple devs add different entries on parallel branches. Use CLI or MCP tools to edit; hand-editing the wrapper files is unsupported.

```bash
# Initialize a project — scans codebase, creates .codexcli/ and CLAUDE.md
rvr init

# Preview what init would create
rvr init --dry-run

# Init without CLAUDE.md generation
rvr init --no-claude

# Init without codebase scan (empty .codexcli/)
rvr init --no-scan

# Store project knowledge
rvr set commands.build "npm run build"
rvr set commands.test "npm test"
rvr set arch.api "REST endpoints in src/routes/, validated by Zod schemas"
rvr set conventions.errors "Always use AppError class from src/utils/errors.ts"
rvr set context.auth "JWT tokens expire after 1h, refresh via /api/refresh"

# get shows project entries only (when inside a project)
rvr get

# Single-key lookups fall through to global transparently
rvr get paths.github    # not in project → found in global

# Use -G to see global entries only
rvr get -G

# Use -A to see both scopes with section headers
rvr get -A

# Use -G to explicitly write to global while inside a project
rvr set server.ip 192.168.1.100 -G

# Remove the project store
rvr init --remove
```

**Scope flags:** The `-G` / `--global` flag is available on `set`, `get`, `run`, `find`, `copy`, `edit`, `rename`, and `remove`. Data management commands (`export`, `import`, `reset`) also support `-P` / `--project`.

#### Recommended Schema

> **Deep dive:** See the [Schema Guide](docs/schema-guide.md) for the full rationale behind the file structure, what makes a good entry, and a walkthrough of the Reverie project's own `.codexcli/` as a reference implementation.

When using Reverie as a project knowledge base (especially with AI agents via MCP), we recommend organizing entries under these namespaces:

| Namespace | Purpose | Examples |
|---|---|---|
| `project.*` | Basic metadata | `project.name`, `project.stack`, `project.description` |
| `commands.*` | Build, test, deploy commands | `commands.build`, `commands.test`, `commands.deploy.staging` |
| `arch.*` | Architecture and design decisions | `arch.storage`, `arch.api`, `arch.auth` |
| `conventions.*` | Coding patterns, naming, style | `conventions.types`, `conventions.errors`, `conventions.testing` |
| `context.*` | Non-obvious gotchas, edge cases | `context.migration`, `context.legacy`, `context.performance` |
| `files.*` | Key file paths and their roles | `files.entry`, `files.config`, `files.routes` |
| `deps.*` | Notable dependencies and why | `deps.commander`, `deps.vitest`, `deps.zod` |

Keep values concise — one sentence or a short command. Use multiple keys under the same namespace for detail. Don't store things easily derived from `package.json` or the code itself; store insights, decisions, and context that would otherwise be lost.

#### AI Agent Workflow

When an AI agent connects via MCP, the recommended workflow is:

1. Call `codex_context` as your **first** tool call to bootstrap session knowledge. Pick the right tier for the task:
   - `tier:"essential"` — answering questions, small fixes, single-file edits
   - omit / `tier:"standard"` — multi-file changes, bug fixes, new features (default)
   - `tier:"full"` — refactoring subsystems, changing architecture, onboarding to the codebase
2. Check relevant namespaces (`arch`, `conventions`, `context`, `files`) before exploring the codebase
3. Record non-obvious discoveries with `codex_set` as you work
4. Update stale entries when you find they no longer match the code

Agent usage is tracked automatically — run `rvr stats` to see bootstrap rate, write-back rate, and namespace coverage trends.

#### The Knowledge Flywheel

Every AI session has the same problem: the agent starts from zero, spends thousands of tokens exploring the codebase, and all that understanding vanishes when the session ends. Reverie turns that into a compounding asset.

Here's how it works in practice:

1. **You run `rvr init`** in a new project. The CLI scans the codebase in milliseconds and creates a skeleton `.codexcli/` with project metadata, commands, file paths, dependencies, and conventions it can detect from the filesystem.

2. **First AI session begins.** The agent calls `codex_context`, sees the skeleton, and recognizes it's a fresh project (`context.initialized: scaffold`). Before starting your task, it reads the actual source code — entry points, core modules, config files — and populates the deep knowledge: architecture decisions in `arch.*`, non-obvious gotchas in `context.*`, and rich file descriptions in `files.*`. This deep analysis runs once.

3. **Every session after that** — whether it's Claude, Copilot, Cursor, ChatGPT, or any other MCP-compatible agent — bootstraps the full knowledge base in a single `codex_context` call. No re-exploration. No wasted tokens.

4. **The flywheel accelerates.** Agent A discovers a database migration gotcha on Monday and stores it in `context.migration`. Agent B (different tool, different session) hits the same area on Tuesday and benefits immediately — it already knows about the gotcha. Agent B discovers an API pattern and stores it in `arch.api`. Agent C benefits on Wednesday.

The knowledge base grows with every session. The token cost per session drops. `rvr stats` shows you the trend: bootstrap rate, hit rate, estimated tokens saved, per-namespace coverage. The more you use it, the more efficient every agent becomes.

Because the knowledge lives in `.codexcli/` (plain JSON files committed to your repo), it works across machines, across team members, and across AI tools. No vendor lock-in, no cloud dependency, no API keys. Just files that get smarter over time.

### Data Management

All data (entries, aliases, confirm metadata) is stored in a directory with one JSON file per entry plus `_aliases.json` and `_confirm.json` sidecars — `~/.codexcli/store/` for global data, `.codexcli/` for project-scoped data. Pre-v1.10.0 unified `.codexcli.json` / `data.json` files are automatically migrated on first access and the old file is renamed to `.backup`.

```bash
# Export data to a timestamped file
rvr data export entries

# Export to a specific file
rvr data export aliases -o my-aliases.json

# Export with pretty-printed JSON
rvr data export entries --pretty

# Export confirm metadata
rvr data export confirm

# Export everything to a single file (roundtrips with `data import all`)
rvr data export all -o backup.json

# Legacy behavior: write per-section files (entries/aliases/confirm)
rvr data export all -o backup.json --split

# Export only global data (when a project file exists)
rvr data export entries -G

# Import data from a file (replaces existing)
rvr data import entries backup.json

# Import and merge with existing data
rvr data import entries backup.json --merge

# Preview changes without importing
rvr data import entries backup.json --merge --preview

# Reset data to empty state (prompts first)
rvr data reset entries

# Reset without confirmation
rvr data reset all -f
```

> **Auto-backup:** Before destructive operations (`data reset`, non-merge `data import`), Reverie automatically creates a timestamped backup in `~/.codexcli/.backups/`. The last 10 backups are kept by default — configure with `rvr config set max_backups <n>` (set to `0` to disable rotation).

### Context (Knowledge Summary)

Get a compact summary of stored project knowledge — the same view AI agents get via `codex_context`:

```bash
# Show project knowledge (standard tier — excludes arch.*)
rvr context

# Show only essential entries (project/commands/conventions)
rvr context --tier essential

# Show everything
rvr context --tier full

# Output as JSON
rvr context --json

# Plain text without colors
rvr context -p
```

### Run Confirmation

Mark commands that should prompt before executing:

```bash
# Require confirmation before running
rvr confirm set commands.deploy

# List keys requiring confirmation
rvr confirm list

# Remove confirmation requirement
rvr confirm remove commands.deploy

# Skip confirmation at run time with -y
rvr run commands.deploy -y
```

### Staleness Detection

Track when entries were last updated and find stale knowledge that may need refreshing.

```bash
# Show entries not updated in 30 days (default)
rvr stale

# Show entries not updated in 7 days
rvr stale 7

# Output as JSON
rvr stale --json
```

Timestamps are tracked automatically when entries are set, copied, or renamed.

Staleness is also surfaced inline — `rvr get` and `codex_context` (MCP) append tags to stale or untracked entries:

- `[untracked]` — entry has no update timestamp (predates staleness tracking). Most suspect.
- `[47d]` — entry hasn't been updated in 47 days. Verify before trusting version numbers, URLs, or commands.

The CLI `get` command prints a yellow warning for stale/untracked entries. Fresh entries show no tag.

### Schema Validation

Check entries against the recommended namespace schema to keep your knowledge base organized.

```bash
# Check for entries outside recommended namespaces
rvr lint

# Output as JSON
rvr lint --json

# Check global store only
rvr lint -G
```

Default namespaces: `project`, `commands`, `arch`, `conventions`, `context`, `files`, `deps`, `system`. Add custom namespaces in `.codexcli/`:

```json
{
  "_schema": { "namespaces": ["myapp", "infra"] }
}
```

### Shell Wrapper

By default, `rvr run` executes commands in a child process. This means shell builtins like `cd`, `export`, and `alias` have no effect on your current shell.

After running `rvr config completions install`, a shell wrapper function is added to your shell profile that fixes this. When you use `rvr run` (or `rvr r`), the wrapper:

1. Calls the real `rvr` binary with `--source`, which outputs the raw command to stdout instead of executing it
2. Captures that output and `eval`s it in your current shell

All other `rvr` commands pass through to the binary unchanged.

```bash
# Store a navigation command
rvr set paths.myproject 'cd ~/Projects/my-project'

# This actually changes your directory (with the wrapper installed)
rvr r paths.myproject -y

# Without the wrapper, cd would run in a child process and have no effect
```

The wrapper is installed automatically by `rvr config completions install`. If you already have completions installed, run it again to add the wrapper, then `source` your shell profile.

### Shell Tab-Completion

Reverie supports tab-completion for Bash and Zsh, including commands, flags, stored keys, alias names, and more.

#### Quick Setup

```bash
rvr config completions install
```

This appends a completion loader and shell wrapper to your `~/.zshrc` or `~/.bashrc` and tells you to restart your shell (or `source` the file).

#### Manual Setup

If you prefer to set it up yourself:

```bash
# Zsh - add to ~/.zshrc
eval "$(rvr config completions zsh)"

# Bash - add to ~/.bashrc or ~/.bash_profile
eval "$(rvr config completions bash)"
```

#### What Gets Completed

| Context | Completions |
|---|---|
| `rvr <TAB>` | All commands (`set`, `get`, `run`, `find`, `edit`, `copy`, `remove`, `rename`, `alias`, `confirm`, `context`, `info`, `init`, `stale`, `lint`, `stats`, `audit`, `config`, `data`) |
| `rvr get <TAB>` | Flags + stored data keys + aliases + namespace prefixes |
| `rvr run <TAB>` | Flags + stored data keys + aliases |
| `rvr run cd:<TAB>` | Data keys + aliases (completes the segment after `:`) |
| `rvr set <TAB>` | Flags + namespace prefixes (one level at a time) |
| `rvr alias <TAB>` | Subcommands (`set`, `remove`, `list`, `rename`) |
| `rvr confirm <TAB>` | Subcommands (`set`, `remove`, `list`) |
| `rvr config <TAB>` | Subcommands (`set`, `get`, `info`, `examples`, `completions`) |
| `rvr config set <TAB>` | Config keys (`colors`, `theme`, `max_backups`) |
| `rvr data <TAB>` | Subcommands (`export`, `import`, `reset`) |
| `rvr data export <TAB>` | `entries`, `aliases`, `confirm`, `all` |

### Scripting Tips

```bash
# Use raw output in other commands
ssh $(rvr get server.ip -r)

# Decrypt and copy to clipboard
rvr get api.key -d -c

# Decrypt and run without prompt
rvr run deploy.cmd -d -y

# Preview a command with interpolation
rvr run paths.myproject --dry -y
```

### Debugging

```bash
rvr --debug get server.production
```

## Command Reference

| Command | Alias | Signature | Description |
|---|---|---|---|
| `set` | `s` | `<key> [value]` | Set an entry (value optional with `-a`; supports `key=val` batch) |
| `get` | `g` | `[key]` | List keys (default) or retrieve entries with `-v` |
| `run` | `r` | `<keys...>` | Execute stored command(s) (`:` compose, `&&` chain) |
| `find` | `f` | `<term>` | Find entries by key or value (also: `search`) |
| `edit` | `e` | `<key>` | Open an entry's value in `$EDITOR` |
| `copy` | `cp` | `<source> <dest>` | Copy an entry to a new key |
| `remove` | `rm` | `<key>` | Remove an entry and its alias |
| `rename` | `rn` | `<old> <new>` | Rename an entry key or alias |
| `context` | | `[--tier <tier>]` | Show compact knowledge summary (essential, standard, full) |
| `info` | | | Show version, stats, and storage paths |
| `alias` | | `<subcommand>` | Manage key aliases (set, remove, list, rename) |
| `confirm` | | `<subcommand>` | Manage run confirmation (set, remove, list) |
| `init` | | | Initialize project (`.codexcli/` + codebase scan + `CLAUDE.md`) |
| `stale` | | `[days]` | Show entries not updated in N days (default 30) |
| `lint` | | | Check entries against namespace schema (`--json`) |
| `stats` | | | View MCP usage telemetry and trends (`--period`, `--detailed`, `--json`) |
| `audit` | | `[key]` | Query audit log with before/after diffs (`--detailed`, `--cli`, `--mcp`, `--hits`, `--misses`, `--redundant`) |
| `config` | | `<subcommand>` | View or change configuration settings |
| `data` | | `<subcommand>` | Manage stored data (export, import, reset) |

**Alias subcommands:** `set <name> <path>`, `remove <name>`, `list`, `rename <old> <new>`

**Confirm subcommands:** `set <key>`, `remove <key>`, `list`

**Config subcommands:** `set <key> <value>`, `get [key]`, `info`, `examples`, `completions <bash\|zsh\|install>`

**Data subcommands:** `export <type>`, `import <type> <file>`, `reset <type>`

**Scope flags:** `-G` / `--global` targets the global store. `-A` / `--all` on `get` shows both scopes with section headers.

## MCP Server (AI Agent Integration)

Reverie includes a built-in [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server, allowing any MCP-compatible AI agent to read and write your Reverie data store as a native tool. Works with Claude Code, Claude Desktop, GitHub Copilot, ChatGPT, and any other client that supports MCP.

### Setup

#### Claude Code

**Homebrew / binary install (global):**

```bash
claude mcp add reverie -- rvr mcp-server
```

**Per-project** (recommended — enables project-scoped data):

```bash
claude mcp add reverie --scope project -- rvr mcp-server --cwd .
```

The `--scope project` makes the registration per-project in Claude Code, and `--cwd .` tells the MCP server to use the project root for `.codexcli/` detection. You can also use the `CODEX_PROJECT_DIR` environment variable instead of `--cwd`.

**npm global install** (`npm install -g .`) — dev mode:

```bash
claude mcp add reverie -- rvr-dev mcp-server
```

**From source** (development):

```bash
claude mcp add reverie -- node /absolute/path/to/dist/mcp-server.js
```

> The standalone `rvr-dev-mcp` command also still works for npm installs.

#### Claude Desktop

**Homebrew / binary install:**

```json
{
  "mcpServers": {
    "reverie": {
      "command": "rvr",
      "args": ["mcp-server"]
    }
  }
}
```

**npm global install** (dev mode):

```json
{
  "mcpServers": {
    "reverie": {
      "command": "rvr-dev",
      "args": ["mcp-server"]
    }
  }
}
```

**From source:**

```json
{
  "mcpServers": {
    "reverie": {
      "command": "node",
      "args": ["/absolute/path/to/dist/mcp-server.js"]
    }
  }
}
```

### Available Tools

| Tool | Description |
|---|---|
| `codex_set` | Store project knowledge as a key-value entry (dot notation, optional alias, optional encryption) |
| `codex_get` | Retrieve stored knowledge by dot-notation key, or list all entries (staleness tags on stale/untracked entries, optional decrypt) |
| `codex_remove` | Remove a stored entry or alias by key |
| `codex_copy` | Copy an entry to a new key (optional force to overwrite) |
| `codex_rename` | Rename an entry key or alias (re-points aliases, migrates confirm metadata) |
| `codex_search` | Search stored knowledge by keyword (keys, values, or both) |
| `codex_alias_set` | Create or update an alias for a dot-notation path |
| `codex_alias_remove` | Remove an alias |
| `codex_alias_list` | List all defined aliases |
| `codex_run` | Execute a stored shell command by key (dry-run, interpolation, confirmation prompts) |
| `codex_config_get` | Get one or all configuration settings |
| `codex_config_set` | Set a configuration setting (colors, theme, max_backups) |
| `codex_export` | Export data and/or aliases as JSON text |
| `codex_import` | Import data and/or aliases from a JSON string (merge, replace, or preview) |
| `codex_reset` | Reset data and/or aliases to empty state |
| `codex_context` | Compact summary of stored project knowledge (use at session start; supports tiers: essential, standard, full; staleness tags on stale/untracked entries) |
| `codex_stale` | Find entries not updated recently (threshold in days, default 30) |
| `codex_stats` | View usage telemetry and [token savings](docs/token-savings.md) (hit rate, exploration cost avoided, per-namespace breakdown, trends) |
| `codex_audit` | Query the audit log of data mutations (before/after diffs, agent identity, scope, success/fail) |

All data-touching tools accept an optional `scope` parameter (`"project"` or `"global"`). When listing entries (no key), `codex_get` defaults to project-only if a `.codexcli/` exists — pass `all: true` to see both scopes. Single-key lookups fall through from project to global automatically.

### LLM Instructions

When an AI agent connects via MCP, Reverie sends built-in instructions that guide how the agent interacts with the data store (schema, scope, tool tips, effective usage patterns). These defaults are immutable and stay up to date as features are added.

To add project-specific guidance, set `system.llm.instructions` — your text is **appended** to the defaults as a `PROJECT CONTEXT` section, not a replacement:

```bash
# Add project-specific instructions for AI agents
rvr set system.llm.instructions "This is a monorepo. Always check arch.modules before modifying shared code. Never store secrets, even encrypted."

# View the effective instructions (defaults + your additions)
rvr config llm-instructions

# View just the built-in defaults
rvr config llm-instructions --default

# Remove your custom additions (reverts to defaults only)
rvr rm system.llm.instructions
```

### Verifying the MCP Server

```bash
# Binary / Homebrew install:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | rvr mcp-server

# From source:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}' | node dist/mcp-server.js
```

A successful response will include `"serverInfo":{"name":"reverie"}` in the JSON output.

## Documentation

| Document | Description |
|---|---|
| [Schema Guide](docs/schema-guide.md) | How to structure your `.codexcli/` store — namespaces, file anatomy, good vs bad entries, reference examples |
| [Token Savings](docs/token-savings.md) | How Reverie measures AI agent efficiency — every metric explained, estimation methodology, limitations |
| [Roadmap](docs/ROADMAP.md) | Completed features, upcoming milestones, long-term vision |
| [Dogfooding](docs/dogfooding.md) | How Reverie found and fixed its own bugs using its own MCP tools |

## Development

```bash
npm install        # Install dependencies
npm run build      # Build the project
npm test           # Run all tests
npm run test:watch # Run tests in watch mode
npm run dev:watch  # Watch mode — recompiles on file changes
npm run lint       # Run ESLint
```

## License

This project is licensed under the MIT License - see the LICENSE file for details.
