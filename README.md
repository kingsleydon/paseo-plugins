# paseo-recap

A [Paseo](https://github.com/getpaseo/paseo) plugin that shows a short "where things stand" recap
for every agent — goal, current state, next action — pinned outside the conversation timeline.
Provider-agnostic: works with Claude, Codex, OMP, Pi, OpenCode, and custom providers.

See [docs/design.md](docs/design.md) for the design and a comparison with Claude Code, Codex, OMP,
and other agent products.

> Paseo plugins are trusted, unsandboxed code that runs on the daemon host. Recaps send recent
> conversation text (user and assistant messages only, no tool output) to the model you use for
> Paseo metadata generation.

## How it works

- Like Claude Code, the first recap comes after 3 of your messages; after that, one follows every
  completed turn, 10 seconds after it ends (Claude Code waits ~3 min and recaps every 2 turns). It is under 40 words, built
  from the last 8 exchanges by default (user and assistant text only). If you reply within those 10 seconds,
  that turn is skipped. A new turn aborts any generation in flight and marks the recap as out of date.
- Like Claude Code, the recap appears as a muted line in the conversation after the turn, with the
  next action below it. A **Recap** pill above the composer shows its age; tap it to regenerate or
  see earlier recaps. `/recap` creates one on demand.
- Recaps never enter the agent's context. The conversation line is display-only and kept in the
  daemon's memory, so it disappears after a daemon restart. Recaps themselves are stored in
  `$PASEO_HOME/plugin-data/paseo-recap/recaps.json` (latest + 4 previous per agent, pruned after
  30 days, removed when the agent is archived).
- Skipped automatically: canceled or failed turns, pending permissions or questions, context
  compaction, subagents themselves, and providers whose plan usage is ≥ 90%. A parent is recapped
  even while its subagents run, unless **Wait for subagents** is on (up to 10 min, as in Claude Code). See [docs/design.md §5.12](docs/design.md#512-edge-cases-compared) for how
  each case compares with Claude Code, Codex, and OMP.

### Settings

**Settings → Plugins → paseo-recap → Recap**: automatic recaps on/off, every N turns (1–50), wait
after a turn (0–3600 s), first recap after N messages (1–50), recent exchanges to read (1–100),
recapping and waiting for subagents, and the model (same as the agent, Paseo's metadata model, or any
Claude, Codex, or OpenCode model id). Numbers and model ids are typed in and checked as you type.

### Model

Generation runs a local CLI with your existing login. By default the agent's own provider goes first
(a Codex agent is recapped by Codex), then Paseo's `agents.metadataGeneration.providers`, then
`claude` (`haiku`) and `codex` (`gpt-6-luna`):

| Provider | Invocation |
|---|---|
| `claude` | `claude -p --json-schema … --tools "" --no-session-persistence --setting-sources ""`, thinking disabled |
| `codex` | `codex exec --ephemeral --sandbox read-only --output-schema … --disable hooks`, low reasoning effort |
| `opencode` | `opencode run --pure --agent plan --format json`, session deleted afterwards |

Each call runs in a temporary directory, without tools, and leaves no session behind. At most two run
at once. Measured: Claude Haiku ~3 s and ~$0.002 per recap; Codex GPT-6-Luna ~10 s.

## Requirements

- Paseo ≥ 0.10.3 with plugins enabled (`"pluginsEnabled": true` in `~/.paseo/config.json`)
- `claude`, `codex`, or `opencode` CLI on the daemon's `PATH`, logged in

## Development

```bash
npm install
npm run typecheck
npm test
RECAP_E2E=1 npx vitest run test/generators.real.e2e.test.ts   # real CLIs, costs a few cents
paseo plugin install "$PWD"
paseo plugin reload paseo-recap   # after changes
paseo plugin logs paseo-recap
```

## Status

Feature-complete for the design in [docs/design.md](docs/design.md); not yet verified inside a
running Paseo (see §7 there).
