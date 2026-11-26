import { describe, expect, it, vi } from "vitest";
import { createAutosave, orphanedDrafts, type SettingsIo } from "../client/autosave";
import { movePrompt, setDisplay, setSendRightAway, updatePrompt, type SettingsDoc } from "../client/edits";
import { quickPromptsSettings, type QuickPromptsSettings } from "../shared/prompts";

const prompt = (id: string, label = `Label ${id}`, text = `Text ${id}`) => ({ id, label, text });
const values = (...ids: string[]): QuickPromptsSettings => ({ prompts: ids.map((id) => prompt(id)), display: "pills", sendRightAway: true });
/** Like Paseo, a revision is a hash of the content, so the same values always have the same revision. */
const doc = (settings: QuickPromptsSettings): SettingsDoc => ({ values: settings, revision: JSON.stringify(settings) });
/** Lets every queued promise callback run. */
const idle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A host that applies each request when it arrives. While `hold` is on, responses wait for
 * `release()`, which models a slow connection.
 */
function setup(initial: QuickPromptsSettings) {
  const host = {
    stored: doc(initial),
    writes: 0,
    failWrites: new Set<number>(),
    failReads: false,
    hold: false,
    held: [] as Array<() => void>,
    problems: [] as string[],
    /** Another client saves. */
    other(settings: QuickPromptsSettings) {
      host.stored = doc(settings);
    },
    release() {
      host.hold = false;
      for (const respond of host.held.splice(0)) respond();
    },
  };
  const respond = <T>(value: T): Promise<T> =>
    host.hold ? new Promise((resolve) => host.held.push(() => resolve(value))) : Promise.resolve(value);
  const io: SettingsIo = {
    async write({ revision, values: written }) {
      host.writes += 1;
      if (host.failWrites.has(host.writes)) throw new Error("offline");
      if (revision !== host.stored.revision) return respond({ status: "conflict", error: "Settings changed" });
      host.stored = doc(quickPromptsSettings.schema.parse(written));
      return respond({ status: "saved", ...host.stored });
    },
    read: async () => {
      if (host.failReads) throw new Error("offline");
      return respond({ status: "ready", ...host.stored });
    },
  };
  const store = createAutosave(doc(initial), { io, onProblem: (problem) => host.problems.push(problem) });
  return { host, store, state: () => store.getState() };
}

describe("createAutosave", () => {
  it("follows another client back to values it had before, whose revision repeats", async () => {
    const { host, store, state } = setup(values("a"));
    await store.save(setDisplay("menu"));
    expect(state().doc.values.display).toBe("menu");
    await store.save(setSendRightAway(false));
    expect(state().doc.values).toMatchObject({ display: "menu", sendRightAway: false });
    expect(host.stored.values).toMatchObject({ display: "menu", sendRightAway: false });

    host.other(values("a"));
    store.refresh();
    await idle();
    expect(state().doc).toEqual(doc(values("a")));
  });

  it("reads the latest values instead of showing an older save response", async () => {
    const { host, store, state } = setup(values("a"));
    const shown: SettingsDoc[] = [];
    store.subscribe(() => shown.push(state().doc));
    host.hold = true;
    const saved = store.save(setDisplay("menu"));
    await idle();
    host.other({ ...host.stored.values, prompts: [prompt("a"), prompt("b")] });
    store.refresh();
    host.release();

    expect(await saved).toBe("saved");
    await idle();
    expect(state().doc).toEqual(host.stored);
    expect(shown.some(({ values: shownValues }) => shownValues.prompts.length === 1 && shownValues.display === "menu")).toBe(false);
  });

  it("re-applies an edit to newer values after a conflict, and gives up after one retry", async () => {
    const { host, store, state } = setup(values("a", "b"));
    host.other(values("a", "b", "c"));
    expect(await store.save(updatePrompt("b", "text", "Mine"))).toBe("saved");
    expect(host.stored.values.prompts).toEqual([prompt("a"), prompt("b", "Label b", "Mine"), prompt("c")]);

    host.other(values("a"));
    expect(await store.save(movePrompt("b", -1))).toBe("stale");
    expect(state().doc).toEqual(doc(values("a")));
    expect(host.problems).toEqual(["stale"]);
  });

  it("keeps the values it read when the retry after a conflict fails", async () => {
    const { host, store, state } = setup(values("a"));
    host.other(values("a", "b"));
    host.failWrites.add(2);
    expect(await store.save(setDisplay("menu"))).toBe("failed");
    expect(state().doc).toEqual(doc(values("a", "b")));
    expect(host.problems).toEqual(["failed"]);
  });

  it("shows how the latest save ended", async () => {
    const { host, store, state } = setup(values("a"));
    await store.save(setDisplay("menu"));
    expect(state().last).toBe("saved");
    host.failWrites.add(2);
    await store.save(setDisplay("pills"));
    expect(state().last).toBe("failed");
    await store.save(setDisplay("pills"));
    expect(state().last).toBe("saved");
  });
});

describe("drafts", () => {
  it("save an edit back to the original value made while the first edit is still saving", async () => {
    const { host, store, state } = setup(values("a"));
    host.hold = true;
    store.setDraft("a", "label", "B");
    store.submit("a", "label");
    await idle();
    store.setDraft("a", "label", "Label a");
    store.submit("a", "label");
    host.release();
    await idle();
    expect(host.stored.values.prompts[0]?.label).toBe("Label a");
    expect(state().drafts.size).toBe(0);
  });

  it("are cleared only by the response to their latest save, not an earlier save of the same text", async () => {
    const { host, store, state } = setup(values("a"));
    host.hold = true;
    store.setDraft("a", "label", "X");
    store.submit("a", "label");
    await idle();
    store.setDraft("a", "label", "Y");
    store.submit("a", "label");
    store.setDraft("a", "label", "X");
    store.submit("a", "label");
    host.failWrites.add(3);
    host.release();
    await idle();
    expect(host.stored.values.prompts[0]?.label).toBe("Y");
    expect(state().drafts.get("a:label")).toEqual({ promptId: "a", field: "label", text: "X", pending: null, showError: false });
  });

  it("stay through a failed read", async () => {
    const { host, store, state } = setup(values("a"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    store.setDraft("a", "text", "Typing");
    host.failReads = true;
    store.refresh();
    await idle();
    expect(state().drafts.get("a:text")?.text).toBe("Typing");
    expect(state().doc).toEqual(doc(values("a")));
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("send a field once when it loses focus and the screen then closes", async () => {
    const { host, store, state } = setup(values("a"));
    host.hold = true;
    store.setDraft("a", "text", "New text");
    store.submit("a", "text");
    expect(store.flush()).toBe(0);
    await idle();
    // Another client edits the same field after this save lands; a second send would undo it.
    host.other({ ...host.stored.values, prompts: [prompt("a", "Label a", "Their text")] });
    store.refresh();
    host.release();
    await idle();
    expect(host.writes).toBe(1);
    expect(state().doc.values.prompts[0]?.text).toBe("Their text");
    expect(state().drafts.size).toBe(0);
  });

  it("keep typed text, valid or not, when another client deletes the prompt", async () => {
    const { host, store, state } = setup(values("a", "b"));
    store.setDraft("a", "label", "x".repeat(41));
    store.submit("a", "label");
    store.setDraft("b", "text", "Mine");
    host.other(values());
    store.submit("b", "text");
    store.refresh();
    await idle();
    expect(orphanedDrafts(state()).map(({ promptId, text }) => [promptId, text])).toEqual([
      ["a", "x".repeat(41)],
      ["b", "Mine"],
    ]);
    expect(store.flush()).toBe(2);

    store.dismissOrphans();
    expect(state().drafts.size).toBe(0);
  });

  it("go with a prompt deleted here only once the delete succeeds", async () => {
    const { host, store, state } = setup(values("a", "b"));
    store.setDraft("a", "text", "Mine");
    host.failWrites.add(1);
    expect(await store.remove("a")).toBe("failed");
    expect(state().drafts.size).toBe(1);

    // A later deletion on another device still shows the text.
    host.other(values("b"));
    store.refresh();
    await idle();
    expect(orphanedDrafts(state())).toHaveLength(1);

    store.setDraft("b", "text", "Gone with it");
    expect(await store.remove("b")).toBe("saved");
    expect([...state().drafts.values()].map(({ promptId }) => promptId)).toEqual(["a"]);
  });

  it("stay while another client's save arrives during typing", async () => {
    const { host, store, state } = setup(values("a"));
    store.setDraft("a", "text", "Typing");
    host.other({ ...values("a"), display: "menu" });
    store.refresh();
    await idle();
    expect(state().doc.values.display).toBe("menu");
    expect(state().drafts.get("a:text")?.text).toBe("Typing");
    expect(host.writes).toBe(0);
  });
});

describe("new prompt form", () => {
  it("adds once and keeps text typed while the add is in flight", async () => {
    const { host, store, state } = setup(values("a"));
    store.setNewPrompt("label", "Docs");
    store.setNewPrompt("text", "Update the docs.");
    host.hold = true;
    const added = store.add();
    expect(await store.add()).toBe("unchanged");
    await idle();
    store.setNewPrompt("text", "Update the docs and the README.");
    host.release();

    expect(await added).toBe("saved");
    expect(host.writes).toBe(1);
    expect(host.stored.values.prompts.map(({ label, text }) => [label, text])).toEqual([
      ["Label a", "Text a"],
      ["Docs", "Update the docs."],
    ]);
    expect(state().newPrompt).toEqual({ label: "", text: "Update the docs and the README.", showErrors: false });
  });

  it("shows errors and sends nothing when the prompt cannot be saved", async () => {
    const { host, store, state } = setup(values("a"));
    store.setNewPrompt("label", "Docs");
    expect(await store.add()).toBe("unchanged");
    expect(state().newPrompt).toEqual({ label: "Docs", text: "", showErrors: true });
    expect(host.writes).toBe(0);
  });
});
