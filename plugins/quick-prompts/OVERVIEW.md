Quick prompts turns the messages you send often into pills above every agent's composer. Tap a pill and its text goes to that agent as your next message, the same as typing it and pressing send. If you prefer a tidier composer, show them all in one **Prompts** pill that opens a menu instead.

To edit a prompt before sending it, open the **Quick prompts** control in the composer and choose one: its text goes into the composer at the cursor, and nothing is sent until you send it. The control works in a running agent's composer, a new agent's composer, and the New workspace screen.

Use it for prompts you repeat across agents, such as "Review the uncommitted changes", "Run the tests and fix failures", or "Summarize what changed and open a PR".

## Settings

Quick prompts needs Paseo 0.16.0 or later, with plugins enabled.

Open **Settings → Plugins → paseo-quick-prompts → Quick prompts** to add, edit, reorder, and delete prompts and to choose how they appear. Each one has a label, shown on the pill or menu item, and the prompt text that is sent. Changes save automatically: deleting, reordering, and the display option save right away, and an edited label or prompt saves when you leave the field. New prompts go in the last row and are added with **Add**. If another device deletes a prompt you were editing, your text stays on the page so you can copy it.

- Up to 20 prompts. Labels can be up to 40 characters.
- **Show prompts as** picks **Separate pills** (the default) or **One menu pill**. Either way, prompts follow the order of the list, on every agent that belongs to a workspace. The menu also has a **Manage prompts** item that opens the settings page.
- With no prompts saved, each agent shows an **Add quick prompt** pill, and the composer control becomes an **Add quick prompt** action; both open the settings page.

To use the same prompts on another Paseo host, press **Export → Copy**, then on the other host's settings page press **Import…**, paste the text, and choose **Add** to put the prompts after the existing ones or **Replace all** to replace them.

The settings page also has a tip with a prompt you can copy and send to an agent, which reads your Paseo agent history and suggests the quick prompts you would use most.

Prompts are stored on the Paseo host and shared by every app connected to it.

## Limits

- Pills appear on existing agents, not in the composer for a new agent; use the composer control there.
- The composer control inserts prompts; it does not send them.
