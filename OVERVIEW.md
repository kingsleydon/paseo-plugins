Recap writes a short note on where each agent stands, like the session recap in Claude Code. After an agent finishes a turn, a muted line appears in the conversation with the goal, what is done, and the next step. You can glance at any agent and pick up where it left off without scrolling back.

Recaps work with every provider Paseo runs, including Claude, Codex, OpenCode, OMP, Pi, and custom agents. The recap line is display only and never becomes part of the agent's context.

## Setup

Recaps are written by a command line tool on the host running the Paseo daemon. At least one of `claude`, `codex`, or `opencode` must be on the daemon's `PATH` and logged in. Recaps use that existing login, so they count toward the same plan or API usage.

## What you get

- **Recap line.** About 40 words after a completed turn, with a **Next** step when one was agreed or asked.
- **Recap pill.** A pill above the composer on every agent shows how old the latest recap is. Tap it to read the recap, generate one now, regenerate it, or see the previous four. The `/paseo-recap` command does the same. Claude agents keep their own `/recap` from Claude Code.
- **Automatic timing.** The first recap comes after your third message, then one after each completed turn once the agent has been quiet for 10 seconds. Replying sooner skips that turn.

Recaps are skipped for canceled or failed turns, while a permission request is pending, during context compaction, and for providers at 90% or more of their usage limit. Agents started by other agents are not recapped automatically, but you can generate one from their pill.

## Settings

Open **Settings → Plugins → paseo-recap → Recap**.

- **Generate recaps automatically.** Turns automatic recaps on or off. The pill and `/paseo-recap` always work.
- **Every N turns**, **Wait after a turn**, and **Start after** control when automatic recaps run.
- **Recent exchanges to read.** How many of your messages and the replies a recap reads, from 1 to 100. The default is 8.
- **Recap subagents** and **Wait for subagents.** Recap agents started by other agents, and hold a parent's recap while its subagents run, for up to 10 minutes.
- **Recap model.** Recaps pick a model the way Paseo's metadata generation does: the models set in Paseo's metadata generation settings, then Paseo's small models that are installed, such as Claude Haiku. By default an agent whose own provider has one of those small models is recapped by it first. You can also choose any Claude, Codex, or OpenCode model by name. The settings page lists the exact models that will run.

## Data and permissions

A recap reads only the text of recent user and assistant messages, short error messages from those turns (the first 300 characters of each), the agent's title, and its current to-do item. It never reads tool output, file contents, or reasoning. That text goes to one model at a time, through its command line tool.

With **Same as agent** or **Metadata model**, a model that is unavailable or fails is followed by the next one: the agent's own provider first (for Same as agent, when it has a small model), then the models in Paseo's metadata generation settings, then Paseo's small models that are installed (Claude Haiku, GPT-5.4 mini, MiniMax M3, Nemotron 3 Super). Any of those providers can therefore receive the conversation text. Unlike Paseo's own metadata generation, a recap never falls back to the agent's large model. Choosing Claude, Codex, or OpenCode sends recaps only to that provider, with no fallback.

Claude runs with no tools, MCP servers, or user settings. Codex runs in a read-only sandbox with your own Codex configuration, which includes any MCP servers you have set up there. OpenCode runs its read-only plan agent. Each run uses a temporary folder. Claude and Codex runs are not saved as sessions. OpenCode always saves one, and the plugin deletes it right after the run; if that deletion fails, the session stays in OpenCode.

Recaps are saved with owner-only permissions in the Paseo data folder, kept for 30 days, and deleted when the agent is archived.

## Limits

- Recap lines in the conversation live in the daemon's memory and disappear after a daemon restart. The saved recap and the pill remain.
- A recap reads recent messages, not the whole session. Decisions made long ago appear only if they come up again or are part of the agent's title.
- Models sometimes go slightly over the 40 word target.
