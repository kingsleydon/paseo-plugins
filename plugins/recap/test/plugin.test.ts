import type { PluginHooks, PluginServerContext } from "@getpaseo/plugin/server";
import { expect, it } from "vitest";
import contribute from "../index.server";

it("registers and releases the Paseo 0.16 lifecycle hooks", () => {
  const hooks = new Set<keyof PluginHooks>();
  function unsupported(): never {
    throw new Error("Unexpected API call while registering Recap");
  }
  const server: PluginServerContext = {
    addHook(name) {
      hooks.add(name);
      return () => { hooks.delete(name); };
    },
    handle() {},
    registerSettings: () => ({ read: unsupported, subscribe: unsupported }),
    registerProvider: unsupported,
    registerUsageSource: unsupported,
    registerWorktreeManager: unsupported,
    on: unsupported,
    before: unsupported,
  };

  const dispose = contribute(server);
  try {
    expect([...hooks]).toEqual([
      "agent.turn.before",
      "agent.turn.after",
      "agent.permission.before",
      "agent.permission.after",
      "agent.archive.after",
    ]);
  } finally {
    dispose();
  }
  expect(hooks.size).toBe(0);
});
