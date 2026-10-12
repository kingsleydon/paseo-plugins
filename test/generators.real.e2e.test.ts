import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RecapGenerator } from "../server/generators";
import { resolveCandidates } from "../server/models";
import { runProcess } from "../server/process";
import { buildRecapInput, latestActiveTask } from "../server/history";
import { historyBudget, renderPrompt } from "../server/prompt";
import { recapSettings } from "../shared/recap";

// Calls real CLIs with the user's logins and costs a few cents. Run with RECAP_E2E=1.
const enabled = process.env.RECAP_E2E === "1";

const timeline: AgentTimelineItem[] = [
  { type: "user_message", text: "Add a recap plugin for Paseo that summarizes each agent." },
  { type: "assistant_message", text: "Scaffolded the plugin and wrote docs/design.md comparing Claude Code, Codex, and OMP." },
  { type: "user_message", text: "Create a public GitHub repo for it." },
  { type: "assistant_message", text: "Created kingsleydon/paseo-recap and pushed the initial commit." },
  { type: "user_message", text: "Start implementing M0." },
  {
    type: "assistant_message",
    text: "Implemented the scheduler, history builder, Claude and Codex adapters, store, composer pill, and /recap. 38 tests pass. Not yet installed into a running Paseo daemon.",
  },
  {
    type: "todo",
    items: [{ text: "Install the plugin into Paseo and verify it in the app", completed: false, status: "in_progress" }],
  },
];

describe.skipIf(!enabled)("real recap generation", () => {
  for (const choice of [
    { provider: "claude", model: "haiku" },
    { provider: "codex", model: "gpt-6-luna" },
  ]) {
    it(`generates a valid recap with ${choice.provider}`, async () => {
      const tempRoot = join(tmpdir(), "paseo-recap-e2e");
      await mkdir(tempRoot, { recursive: true });
      const generator = new RecapGenerator({
        runProcess,
        env: process.env,
        tempRoot,
        now: Date.now,
        log: (message, detail) => console.error(message, detail),
      });
      const context = { goal: "paseo-recap plugin", activeTask: latestActiveTask(timeline) };
      const { historyExchanges } = recapSettings.schema.parse({});
      const input = buildRecapInput(timeline, historyBudget(context), historyExchanges);
      const started = Date.now();
      const recap = await generator.generate(
        renderPrompt(input.history, context),
        resolveCandidates(choice, {}),
        new AbortController().signal,
      );
      console.log(choice.provider, `${Date.now() - started} ms`, JSON.stringify(recap));
      expect(recap.summary.length).toBeGreaterThan(20);
      expect(recap.provider).toBe(choice.provider);
    }, 120_000);
  }
});
