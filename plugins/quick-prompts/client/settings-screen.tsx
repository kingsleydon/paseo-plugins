import { usePaseo, useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal, TextInput as ModalTextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import {
  LABEL_MAX_LENGTH,
  MAX_PROMPTS,
  QuickPromptSchema,
  quickPromptsSettings,
  type PromptDisplay,
  type QuickPrompt,
} from "../shared/prompts";
import { createAutosave, draftKey, orphanedDrafts, type Autosave, type AutosaveState, type Field } from "./autosave";
import { movePrompt, setDisplay, settingsContract, type SettingsDoc } from "./edits";
import { followPromptChanges } from "./follow";
import { exportPrompts, importPrompts, parseImport } from "./transfer";

type Settings = SettingsState<typeof quickPromptsSettings.schema>;
type Theme = PluginSurfaceProps["theme"];

const DISPLAY_OPTIONS: ReadonlyArray<{ label: string; value: PromptDisplay }> = [
  { label: "Separate pills", value: "pills" },
  { label: "One menu pill", value: "menu" },
];

const FIND_PROMPTS_PROMPT =
  "Look through my past Paseo agent sessions using the Paseo tools (list my agents and read their " +
  "activity) and find the follow-up messages I send most often. Suggest the 5 most useful quick prompts " +
  "for me. For each one give a short label (40 characters or fewer) and the full prompt text, written so " +
  "it works for any task. Do not change anything; just list them so I can add them in Quick prompts.";

/** The first validation message for one field, or `null` when it would save. */
function fieldError(field: Field, value: string): string | null {
  return QuickPromptSchema.shape[field].safeParse(value).error?.issues[0]?.message ?? null;
}

const LINE_HEIGHT = 20;
/** The prompt input grows with its text up to this many lines, then scrolls. */
const MAX_LINES = 5;

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      intro: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 18 },
      caption: { color: theme.colors.foregroundMuted, fontSize: 12 },
      message: { color: theme.colors.foreground },
      status: { color: theme.colors.foregroundMuted, fontSize: 13 },
      statusError: { color: theme.colors.statusDanger, fontSize: 13 },
      editor: { paddingHorizontal: compact ? 12 : 16, paddingVertical: 8 },
      row: { paddingHorizontal: compact ? 12 : 16, paddingVertical: 8, gap: 6 },
      line: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 6 },
      labelColumn: compact ? { flex: 1 } : { width: 160 },
      textColumn: compact ? {} : { flex: 1 },
      field: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      },
      input: { padding: 0, color: theme.colors.foreground, fontSize: 14, lineHeight: LINE_HEIGHT },
      error: { color: theme.colors.statusDanger, fontSize: 12, marginTop: 2 },
      actions: { flexDirection: "row" as const, gap: 2, paddingTop: 3 },
      iconButton: {
        width: 28,
        height: 28,
        borderRadius: 6,
        alignItems: "center" as const,
        justifyContent: "center" as const,
      },
      addButton: {
        height: 34,
        paddingHorizontal: 12,
        borderRadius: 6,
        justifyContent: "center" as const,
        backgroundColor: theme.colors.accent,
      },
      addText: { color: theme.colors.accentForeground, fontSize: 13 },
      secondaryButton: {
        height: 34,
        paddingHorizontal: 12,
        borderRadius: 6,
        justifyContent: "center" as const,
        borderWidth: 1,
        borderColor: theme.colors.border,
      },
      dangerText: { color: theme.colors.statusDanger, fontSize: 13 },
      modalActions: { flexDirection: "row" as const, justifyContent: "flex-end" as const, gap: 8 },
      disabled: { opacity: 0.4 },
      tipPrompt: { color: theme.colors.foreground, fontSize: 13, lineHeight: 18 },
    }),
    [theme, compact],
  );
}

type Styles = ReturnType<typeof useStyles>;

function IconButton({
  icon,
  accessibilityLabel,
  color,
  disabled,
  busy,
  styles,
  onPress,
}: {
  icon: string;
  accessibilityLabel: string;
  color: string;
  disabled?: boolean;
  busy?: boolean;
  styles: Styles;
  onPress(): void;
}) {
  const inactive = Boolean(disabled || busy);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: inactive, busy: Boolean(busy) }}
      disabled={inactive}
      hitSlop={6}
      onPress={onPress}
      style={disabled ? [styles.iconButton, styles.disabled] : styles.iconButton}
    >
      {busy ? <ActivityIndicator size="small" color={color} /> : <Icon name={icon} size={16} color={color} />}
    </Pressable>
  );
}

/** A bordered input with its validation error underneath when there is one. */
function CompactInput({
  field,
  value,
  error,
  accessibilityLabel,
  style,
  theme,
  styles,
  onChangeText,
  onBlur,
}: {
  field: Field;
  value: string;
  error: string | null;
  accessibilityLabel: string;
  style: StyleProp<ViewStyle>;
  theme: Theme;
  styles: Styles;
  onChangeText(text: string): void;
  onBlur?(): void;
}) {
  const multiline = field === "text";
  // The input has no padding of its own, so its content height is the height of its text.
  const [contentHeight, setContentHeight] = useState(LINE_HEIGHT);
  const maxHeight = LINE_HEIGHT * MAX_LINES;
  const height = multiline ? Math.min(Math.max(contentHeight, LINE_HEIGHT), maxHeight) : LINE_HEIGHT;
  return (
    <View style={style}>
      <View style={styles.field}>
        <TextInput
          multiline={multiline}
          scrollEnabled={multiline && contentHeight > maxHeight}
          accessibilityLabel={accessibilityLabel}
          value={value}
          placeholder={multiline ? "Prompt sent to the agent" : "Label"}
          placeholderTextColor={theme.colors.foregroundMuted}
          onChangeText={onChangeText}
          onBlur={onBlur}
          onContentSizeChange={multiline ? (event) => setContentHeight(event.nativeEvent.contentSize.height) : undefined}
          style={[styles.input, { height }]}
        />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

/** One line on wide layouts; on compact ones the label and actions, then the prompt underneath. */
function PromptRow({
  compact,
  label,
  text,
  actions,
  styles,
}: {
  compact: boolean;
  label: ReactNode;
  text: ReactNode;
  actions: ReactNode;
  styles: Styles;
}) {
  if (compact) {
    return (
      <View style={styles.row}>
        <View style={styles.line}>
          {label}
          {actions}
        </View>
        {text}
      </View>
    );
  }
  return (
    <View style={[styles.row, styles.line]}>
      {label}
      {text}
      {actions}
    </View>
  );
}

function PromptEditor({
  prompt,
  index,
  count,
  compact,
  state,
  store,
  theme,
  styles,
}: {
  prompt: QuickPrompt;
  index: number;
  count: number;
  compact: boolean;
  state: AutosaveState;
  store: Autosave;
  theme: Theme;
  styles: Styles;
}) {
  const name = prompt.label || `quick prompt ${index + 1}`;
  const input = (field: Field, accessibilityLabel: string) => {
    const draft = state.drafts.get(draftKey(prompt.id, field));
    return (
      <CompactInput
        field={field}
        value={draft?.text ?? prompt[field]}
        error={draft?.showError ? fieldError(field, draft.text) : null}
        accessibilityLabel={accessibilityLabel}
        style={field === "label" ? styles.labelColumn : styles.textColumn}
        theme={theme}
        styles={styles}
        onChangeText={(text) => store.setDraft(prompt.id, field, text)}
        onBlur={() => store.submit(prompt.id, field)}
      />
    );
  };
  return (
    <PromptRow
      compact={compact}
      styles={styles}
      label={input("label", `Label for ${name}`)}
      text={input("text", `Prompt for ${name}`)}
      actions={
        <View style={styles.actions}>
          <IconButton
            icon="ArrowUp"
            accessibilityLabel={`Move ${name} up`}
            color={theme.colors.foreground}
            disabled={index === 0}
            styles={styles}
            onPress={() => void store.save(movePrompt(prompt.id, -1))}
          />
          <IconButton
            icon="ArrowDown"
            accessibilityLabel={`Move ${name} down`}
            color={theme.colors.foreground}
            disabled={index === count - 1}
            styles={styles}
            onPress={() => void store.save(movePrompt(prompt.id, 1))}
          />
          <IconButton
            icon="Trash2"
            accessibilityLabel={`Delete ${name}`}
            color={theme.colors.statusDanger}
            busy={state.deleting.has(prompt.id)}
            styles={styles}
            onPress={() => void store.remove(prompt.id)}
          />
        </View>
      }
    />
  );
}

function NewPromptRow({
  count,
  compact,
  state,
  store,
  theme,
  styles,
}: {
  count: number;
  compact: boolean;
  state: AutosaveState;
  store: Autosave;
  theme: Theme;
  styles: Styles;
}) {
  const { label, text, showErrors } = state.newPrompt;
  const disabled = state.adding || count >= MAX_PROMPTS;
  return (
    <PromptRow
      compact={compact}
      styles={styles}
      label={
        <CompactInput
          field="label"
          value={label}
          error={showErrors ? fieldError("label", label) : null}
          accessibilityLabel="Label for the new quick prompt"
          style={styles.labelColumn}
          theme={theme}
          styles={styles}
          onChangeText={(value) => store.setNewPrompt("label", value)}
        />
      }
      text={
        <CompactInput
          field="text"
          value={text}
          error={showErrors ? fieldError("text", text) : null}
          accessibilityLabel="Prompt for the new quick prompt"
          style={styles.textColumn}
          theme={theme}
          styles={styles}
          onChangeText={(value) => store.setNewPrompt("text", value)}
        />
      }
      actions={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add quick prompt"
          accessibilityState={{ disabled, busy: state.adding }}
          disabled={disabled}
          onPress={() => void store.add()}
          style={disabled ? [styles.addButton, styles.disabled] : styles.addButton}
        >
          <Text style={styles.addText}>{state.adding ? "Adding…" : "Add"}</Text>
        </Pressable>
      }
    />
  );
}

/** Text typed into prompts that were deleted on another device, kept until copied or dismissed. */
function UnsavedEdits({ state, store, styles }: { state: AutosaveState; store: Autosave; styles: Styles }) {
  const toast = useToast();
  const orphans = orphanedDrafts(state);
  if (orphans.length === 0) return null;
  const promptIds = [...new Set(orphans.map(({ promptId }) => promptId))];
  const text = promptIds
    .map((promptId) =>
      orphans
        .filter((draft) => draft.promptId === promptId)
        .map((draft) => `${draft.field === "label" ? "Label" : "Prompt"}: ${draft.text}`)
        .join("\n"),
    )
    .join("\n\n");
  const copy = async (): Promise<void> => {
    try {
      await copyText(text);
      toast.show("Copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the text and use Copy.");
    }
  };
  return (
    <SettingsCard>
      <SettingsAction
        label="Unsaved edits"
        hint="These prompts were deleted on another device before your edits were saved."
        actionLabel="Copy"
        onPress={() => void copy()}
      />
      <View style={styles.editor}>
        <Text selectable style={styles.tipPrompt}>
          {text}
        </Text>
      </View>
      <SettingsAction label="Discard these edits" actionLabel="Dismiss" onPress={() => store.dismissOrphans()} />
    </SettingsCard>
  );
}

/** Copies the prompts as text, and adds or replaces prompts from text copied on another host. */
function TransferPrompts({
  state,
  store,
  theme,
  styles,
}: {
  state: AutosaveState;
  store: Autosave;
  theme: Theme;
  styles: Styles;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // State updates land on the next render, so a second press in the same frame would save twice.
  const busy = useRef(false);
  const copy = async (): Promise<void> => {
    try {
      await copyText(exportPrompts(state.doc.values));
      toast.show("Copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Try again.");
    }
  };
  const runImport = async (replace: boolean): Promise<void> => {
    if (busy.current) return;
    const parsed = parseImport(text);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    busy.current = true;
    setImporting(true);
    const edit = importPrompts(parsed.prompts, replace);
    const result = await store.save(edit);
    busy.current = false;
    setImporting(false);
    if (result === "saved") {
      setText("");
      setOpen(false);
      toast.show(replace ? "Prompts replaced" : "Prompts added", { variant: "success" });
    } else if (result === "unchanged") {
      // Adding would go over the maximum, or every prompt is already saved.
      setError(
        edit(store.getState().doc.values)
          ? "These prompts are already saved."
          : `That would be more than ${MAX_PROMPTS} quick prompts. Use Replace all, or delete some first.`,
      );
    }
  };
  const disabled = importing || text.trim() === "";
  return (
    <SettingsCard>
      <SettingsAction
        label="Export"
        hint="Copy your quick prompts to import on another host."
        actionLabel="Copy"
        disabled={state.doc.values.prompts.length === 0}
        onPress={() => void copy()}
      />
      <SettingsAction
        label="Import"
        hint="Add or replace prompts with ones copied on another host."
        actionLabel="Import…"
        onPress={() => {
          setError(null);
          setOpen(true);
        }}
      />
      <Modal title="Import quick prompts" open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <Text style={styles.intro}>
            Paste the text copied with Export. Add puts the prompts after yours and skips ones already saved; Replace
            all deletes your prompts first.
          </Text>
          <View>
            <View style={styles.field}>
              <ModalTextInput
                multiline
                accessibilityLabel="Quick prompts to import"
                value={text}
                placeholder="Paste prompts copied with Export"
                placeholderTextColor={theme.colors.foregroundMuted}
                onChangeText={(value) => {
                  setText(value);
                  setError(null);
                }}
                style={[styles.input, { height: LINE_HEIGHT * MAX_LINES }]}
              />
            </View>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
          <View style={styles.modalActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled, busy: importing }}
              disabled={disabled}
              onPress={() => void runImport(true)}
              style={disabled ? [styles.secondaryButton, styles.disabled] : styles.secondaryButton}
            >
              <Text style={styles.dangerText}>Replace all</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled, busy: importing }}
              disabled={disabled}
              onPress={() => void runImport(false)}
              style={disabled ? [styles.addButton, styles.disabled] : styles.addButton}
            >
              <Text style={styles.addText}>{importing ? "Importing…" : "Add"}</Text>
            </Pressable>
          </View>
        </Modal.Content>
      </Modal>
    </SettingsCard>
  );
}

function FindPromptsTip({ styles }: { styles: Styles }) {
  const toast = useToast();
  const copy = async (): Promise<void> => {
    try {
      await copyText(FIND_PROMPTS_PROMPT);
      toast.show("Copied", { variant: "success" });
    } catch {
      toast.error("Could not copy. Select the text and use Copy.");
    }
  };
  return (
    <SettingsCard>
      <SettingsAction
        label="Not sure what to add?"
        hint="Ask an agent to look through your past sessions and suggest your most useful quick prompts."
        actionLabel="Copy prompt"
        onPress={() => void copy()}
      />
      <View style={styles.editor}>
        <Text selectable style={styles.tipPrompt}>
          {FIND_PROMPTS_PROMPT}
        </Text>
      </View>
    </SettingsCard>
  );
}

/** A failed or unreadable settings read, with a way to read again or reset. */
function LoadProblem({ settings, styles, onReload }: { settings: Settings; styles: Styles; onReload(): void }) {
  const toast = useToast();
  if (settings.status !== "error" && settings.status !== "invalid") return null;
  const reset = async (): Promise<void> => {
    if (!(await settings.reset())) toast.error("Could not reset quick prompts. Try again.");
  };
  return (
    <>
      <Text style={styles.message}>{settings.error}</Text>
      <SettingsCard>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={onReload} />
        {settings.status === "invalid" ? (
          <SettingsAction
            label="Delete the saved quick prompts"
            hint="The stored data cannot be read."
            actionLabel={settings.saving ? "Resetting…" : "Reset"}
            disabled={settings.saving}
            onPress={() => void reset()}
          />
        ) : null}
      </SettingsCard>
    </>
  );
}

function PromptLibrary({
  initial,
  settings,
  theme,
  layout,
}: { initial: SettingsDoc; settings: Settings } & PluginSurfaceProps) {
  const styles = useStyles(theme, layout.compact);
  const toast = useToast();
  const paseo = usePaseo();
  // The store outlives renders; it reaches the current RPCs and toast through this ref.
  const write = useRpc(settingsContract.write);
  const read = useRpc(settingsContract.read);
  const host = useRef({ write, read, toast });
  host.current = { write, read, toast };
  const [store] = useState(() =>
    createAutosave(initial, {
      io: { write: (input) => host.current.write(input), read: () => host.current.read({}) },
      onProblem(problem, error) {
        if (problem === "stale") {
          host.current.toast.error("Quick prompts changed elsewhere, so this change was not saved.");
          return;
        }
        console.error("[paseo-quick-prompts] failed to save quick prompts", error);
        host.current.toast.error("Could not save quick prompts. Try again.");
      },
    }),
  );
  const state = useSyncExternalStore(store.subscribe, store.getState);

  // Read again whenever any client saves.
  useEffect(() => {
    const lifetime = new AbortController();
    followPromptChanges(paseo, lifetime.signal, () => store.refresh());
    return () => lifetime.abort();
  }, [paseo, store]);

  // Closing the screen saves what can be saved and says when something could not be.
  useEffect(
    () => () => {
      if (store.flush() > 0) host.current.toast.error("Some quick prompt edits could not be saved.");
    },
    [store],
  );

  const prompts = state.doc.values.prompts;
  const status = state.saving ? "Saving…" : state.last === "saved" ? "Saved" : state.last === "failed" ? "Not saved" : null;

  return (
    <SettingsSection
      title="Quick prompts"
      trailing={
        status ? <Text style={state.last === "failed" && !state.saving ? styles.statusError : styles.status}>{status}</Text> : undefined
      }
    >
      <Text style={styles.intro}>
        Quick prompts appear above every agent's composer, as separate pills or in one Prompts menu. Choosing one
        sends the prompt to that agent as your message. Changes save automatically.
      </Text>
      <LoadProblem
        settings={settings}
        styles={styles}
        onReload={() => {
          void settings.reload();
          store.refresh();
        }}
      />
      <UnsavedEdits state={state} store={store} styles={styles} />
      <SettingsCard>
        {prompts.map((prompt, index) => (
          <PromptEditor
            key={prompt.id}
            prompt={prompt}
            index={index}
            count={prompts.length}
            compact={layout.compact}
            state={state}
            store={store}
            theme={theme}
            styles={styles}
          />
        ))}
        <NewPromptRow
          count={prompts.length}
          compact={layout.compact}
          state={state}
          store={store}
          theme={theme}
          styles={styles}
        />
      </SettingsCard>
      <Text style={styles.caption}>
        {prompts.length === 0 ? "No quick prompts yet." : `${prompts.length} of ${MAX_PROMPTS} quick prompts.`} Labels
        can be up to {LABEL_MAX_LENGTH} characters.
      </Text>
      <SettingsCard>
        <SettingsSelect
          label="Show prompts as"
          hint="Separate pills show one pill per prompt; one menu pill keeps them in a single menu."
          value={state.doc.values.display}
          options={DISPLAY_OPTIONS}
          onValueChange={(display) => void store.save(setDisplay(display))}
        />
      </SettingsCard>
      <TransferPrompts state={state} store={store} theme={theme} styles={styles} />
      <FindPromptsTip styles={styles} />
    </SettingsSection>
  );
}

export function QuickPromptsSettingsScreen(props: PluginSurfaceProps) {
  const settings = useSettings(quickPromptsSettings);
  const styles = useStyles(props.theme, props.layout.compact);
  // The editor starts from the first successful read and then stays mounted, so a later failed
  // read does not take typed text with it.
  const initial = useRef<SettingsDoc | null>(null);
  if (!initial.current && settings.status === "ready") {
    initial.current = { values: settings.values, revision: settings.revision };
  }
  if (initial.current) return <PromptLibrary initial={initial.current} settings={settings} {...props} />;
  if (settings.status === "loading") return <Text style={styles.message}>Loading quick prompts…</Text>;
  return (
    <SettingsSection title="Quick prompts">
      <LoadProblem settings={settings} styles={styles} onReload={() => void settings.reload()} />
    </SettingsSection>
  );
}
