# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

This is the personal pi coding agent config directory (`~/.pi/`). Pi is a TypeScript-based AI coding agent with an extension system, skills, agents, and themes.

## Key Commands

```bash
pi                          # Default session (auto-loads custom-footer)
pi-breakdown                # Launch pi with breakdown extension (alias in .zshrc)
pi -e ~/.pi/work-extensions/<name>.ts   # Load any work extension on-demand
pi update                   # Update pi to latest version
pi install <source>         # Install and register an extension permanently
pi list                     # List installed extensions
```

## Folder Structure

```
~/.pi/
├── agent/                  # Pi agent config (PI_CODING_AGENT_DIR)
│   ├── extensions/         # Auto-loaded by pi on every session
│   │   ├── custom-footer-auto.ts
│   │   └── filechanges/
│   ├── agents/             # Agent persona definitions (.md files)
│   │   ├── pi-pi/          # Meta-agent for building pi components
│   │   ├── agent-chain.yaml
│   │   └── teams.yaml
│   ├── skills/             # Auto-discovered skills
│   ├── themes/             # purple.json
│   ├── sessions/           # Session history per project (auto-generated)
│   ├── settings.json       # Default provider, model, theme, extensions
│   └── damage-control-rules.yaml  # Bash command safety rules
├── work-extensions/        # Symlink → ~/agency-tools/extensions/ (on-demand)
├── personal-extensions/    # Personal extensions (on-demand)
├── breakdown-logs/         # Debug logs from breakdown pipeline runs
└── browser-profile/        # Chromium profile for browser automation
```

## Extension System

**Two types of extensions:**
- **Auto-loaded** (`agent/extensions/`) — loaded every session, registered in `settings.json`
- **On-demand** (`work-extensions/` or `personal-extensions/`) — loaded via `-e` flag

**Key rule:** Pi auto-discovers ALL `.ts` files in `agent/extensions/`. Helper/lib files must go inside a subfolder as `index.ts` pattern:
```
agent/extensions/my-extension/
    index.ts        ← entry point (exports factory function)
    lib.ts          ← helpers (not auto-loaded)
    package.json    ← only if npm deps needed
```

Extensions that render UI on startup (widgets, status panels) should stay **on-demand** to avoid disrupting normal sessions.

## Work Extensions (`~/agency-tools/extensions/`)

These extensions have shared lib files and require `@composio/core` for Gmail/Slack:

- `breakdown.ts` — `/breakdown <file>` — pipeline that converts PRD/intake docs into task breakdowns. Uses 4-5 sequential agents (Classifier → Flow Analyst → Feature Extractor → Task Generator → Consolidator). Output files are written to the same directory as the input file.
- `morning-coffee.ts` — Email digest from Gmail via Composio
- `slack-reply.ts` — Slack reply helper via Composio

Shared dependencies between extensions: `themeMap.ts` (UI theming), `breakdown-lib.ts`, `morning-coffee-lib.ts`, `slack-reply-lib.ts`.

## Agent System (`agent/agents/`)

Agents are `.md` files with frontmatter (`name`, `model`, `tools`, `skills`) and a system prompt body.

**Predefined agents:** `planner`, `builder`, `reviewer`, `documenter`, `scout`, `red-team`, `plan-reviewer`, `bowser` (Playwright)

**Agent chains** (`agent-chain.yaml`) — sequential multi-agent pipelines (e.g. `plan-build-review`)

**Teams** (`teams.yaml`) — named groups of agents for coordinated work

**Pi-Pi** (`agents/pi-pi/`) — meta-agent that builds pi components. Has domain experts (cli-expert, ext-expert, skill-expert, etc.) queried in parallel via `query_experts` tool.

## Settings

`agent/settings.json` — default provider is `bedrock`, default model is `zai.glm-5`, theme is `purple`.

The `extensions` array supports glob patterns and `!pattern` exclusions.

## Skills

Skills live in `agent/skills/` and are auto-discovered. Each skill is a directory with a `SKILL.md`. The superpowers skills (brainstorming, systematic-debugging, etc.) follow the standard pi skill format.
