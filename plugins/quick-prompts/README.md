# paseo-quick-prompts

**Saved prompts as one-tap pills above every agent's composer in [Paseo](https://github.com/getpaseo/paseo).**

Save the messages you send often, like "Review the uncommitted changes" or "Run the tests and fix
failures". Each one becomes a pill above every agent's composer; tapping it sends the prompt to that
agent as a normal user message. The **Quick prompts** composer control lists them too and inserts
the one you choose into the composer, so you can edit it before sending.

## Screenshots

![Review diff, Status, Continue, and Commit + PR pills above an agent's composer](assets/pills.png)

![The single Prompts menu pill open, listing the saved prompts and Manage prompts](assets/menu.png)

![The Quick prompts settings screen with four prompt rows, Show prompts as, and the prompt-ideas tip](assets/settings.png)

<p align="center"><img src="assets/settings-light.png" width="320" alt="The Quick prompts settings screen in the light theme on a narrow window"></p>

## Features

- **One pill per prompt** on every agent with a workspace, in the order you set, or **one menu
  pill** (Prompts) that lists them all with a **Manage prompts** shortcut.
- **Composer control.** A **Quick prompts** control in every composer (a running agent's, a new
  agent's, and the New workspace screen's) opens a searchable list of the prompts. Choosing one
  inserts its text at the cursor without sending it and puts the cursor back in the composer. With
  no prompts saved it is an **Add quick prompt** action that opens the settings screen. Paseo shows
  it in the composer toolbar when there is room and in the composer's overflow sheet otherwise
  (always on phones).
- **Settings screen** under **Settings → Plugins → paseo-quick-prompts → Quick prompts** to add, edit, reorder, and delete
  prompts and choose how they appear. Changes save automatically.
- **Export and import.** Copy your prompts as text and paste them into Quick prompts on another
  host, adding them to its prompts or replacing them.
- **Prompt ideas.** A copyable prompt on the settings screen asks an agent to read your Paseo agent
  history and suggest the quick prompts you would use most.
- **Shared per host.** Prompts are stored on the daemon and every connected app sees the same list;
  pills update live when it changes.
- **Empty state.** With no prompts saved, each agent shows an **Add quick prompt** pill that opens
  the settings screen.

## Requirements

- Paseo **0.16.0** or later, with plugins enabled (**Settings → Plugins → Enable plugins**, or
  `"pluginsEnabled": true` in `~/.paseo/config.json`)

## Install

```bash
paseo plugin install npm:paseo-quick-prompts
```

You can also paste `npm:paseo-quick-prompts` into **Settings → Plugins → Plugin source**, or install
the latest source with `paseo plugin install github:kingsleydon/paseo-plugins:plugins/quick-prompts`.

## Settings

| Field | Limit | Description |
|---|---|---|
| Label | 1–40 characters | Text on the pill |
| Prompt | 1–10,000 characters | Message sent to the agent |

Up to 20 prompts. Leading and trailing whitespace is trimmed when you save.

Each prompt is one compact row: label, prompt text (which grows to five lines, then scrolls), and
move up, move down, and delete buttons. Moving, deleting, and **Show prompts as** save right away.
An edited label or prompt saves when the field loses focus, if it is valid; an invalid value shows
an error under the field and is not saved. New prompts go in the last row and are saved with
**Add**. The section header shows **Saving…**, **Saved**, or **Not saved** for the latest save.

Saves go to the host one at a time, each applied to the latest prompts. If another app saved in the
meantime, the change is applied to its prompts and saved again once; when it no longer applies, a
toast says so and the latest prompts are shown. Text you are typing is never replaced by another
app's save. If another app deletes a prompt you were editing, your text stays in an **Unsaved
edits** card with **Copy** and **Dismiss**.

**Show prompts as** is **Separate pills** (default) or **One menu pill**. Settings saved before this
option existed keep separate pills.

**Export → Copy** copies the prompts' labels and text as JSON. **Import → Import…** opens a dialog
to paste that text. **Add** puts the prompts after the saved ones, skipping any whose label and prompt
are already saved; an import that would go over 20 prompts is not saved. **Replace all** replaces the
saved prompts with the pasted ones. **Show prompts as** is not exported or changed by an import.

## How it works

- The settings document (`prompts`, host scope) is registered by the daemon entry and stored by Paseo.
- The app entry follows the agent directory with an owned list subscription, loading every page of
  agents, and re-reads the prompts whenever any client saves them, then keeps one composer pill per
  prompt (or one menu pill) on each non-archived agent that has a workspace. Prompt changes update
  existing pills in place; a reorder of separate pills or a display switch re-registers that agent's
  pills. A failed observation starts again after 1, 5, 15, and 60 seconds, then stops.
- A pill press or menu choice calls `paseo.agents.ref(agentId).send(text)`. Paseo shows the pill as busy until the
  send settles and reports failures in a toast. A prompt is not sent to the same agent again while its
  previous send is pending.

- The composer control is registered once with `addComposerItem`. It reads the prompts with
  `useSettings`, filters them by label and text as you search, and on a choice calls the composer's
  `insertText(text)` and then `focus()`. It never sends; Paseo shows a failure (for example a locked
  New workspace composer) in a toast.

Not supported: pills in the new-agent composer, and sending straight from the composer control
(Paseo's composer API does not say which agent a composer belongs to).

## Development

```bash
npm install
npm run typecheck
npm test
paseo plugin install "$PWD"
paseo plugin reload paseo-quick-prompts   # after changes
paseo plugin logs paseo-quick-prompts
```

| Path | Contents |
|---|---|
| `index.server.ts` | Daemon entry: registers the settings document |
| `index.client.tsx` | App entry: settings screen, composer control, and composer pills |
| `client/pills.ts` | Keeps each agent's pills in sync with the saved prompts |
| `client/composer-item.tsx` | The Quick prompts composer control |
| `client/composer-control.ts` | What the composer control lists, searches, and inserts |
| `client/follow.ts` | Follows the agent directory and settings changes |
| `client/settings-screen.tsx` | Autosaving editor for the prompts and display option, export and import, and the prompt-ideas tip |
| `client/autosave.ts` | Save queue for the settings screen: latest values, typed drafts, the new-prompt form, conflict retry |
| `client/edits.ts` | Prompt edits applied to the latest values |
| `client/transfer.ts` | Export text, and parsing and applying an import |
| `shared/prompts.ts` | Settings schema and limits |
| `assets/` | Screenshots for this README and the plugin listing (`media` in `paseo-plugin.json`) |

## Releasing

Title PRs `fix(quick-prompts): ...` or `feat(quick-prompts): ...`, then merge the release PR that
release-please opens. It bumps the version, updates [`CHANGELOG.md`](CHANGELOG.md), tags
`quick-prompts-v<version>`, creates the GitHub Release, and publishes to npm. See the
[repository README](../../README.md#releasing) for details.

## License

[MIT](LICENSE)
