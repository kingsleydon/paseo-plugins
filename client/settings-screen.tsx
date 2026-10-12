import { useRpc, useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text } from "react-native";
import {
  isRecapProvider,
  MODEL_ID_PATTERN,
  RECAP_PROVIDERS,
  recapModelPlanRpc,
  recapSettings,
  SETTING_RANGES,
  type GeneratorChoice,
  type GeneratorMode,
  type RecapProvider,
  type RecapSettings,
} from "../shared/recap";
import { describePlan } from "./format";

/** Typing pauses this long before a valid value is saved, so each keystroke is not a save. */
const SAVE_DELAY_MS = 600;

type ReadySettings = Extract<SettingsState<typeof recapSettings.schema>, { status: "ready" }>;
type Save = (patch: Partial<RecapSettings>) => void;

type ModelSource = GeneratorMode | RecapProvider;

const MODEL_SOURCE_OPTIONS: ReadonlyArray<{ label: string; value: ModelSource }> = [
  { label: "Same as agent", value: "auto" },
  { label: "Metadata model", value: "metadata" },
  ...Object.entries(RECAP_PROVIDERS).map(([value, { label }]) => ({ label, value: value as RecapProvider })),
];

const MODE_HINTS: Record<GeneratorMode, string> = {
  auto: "Recaps use the agent's own provider when it has a small model, so the conversation stays with the vendor you chose. Otherwise they pick a model the way Paseo's Metadata generation does.",
  metadata:
    "Recaps pick a model the way Paseo's Metadata generation does: the models set there, then Paseo's small models that are installed.",
};
const CLI_HINT = " Runs the provider's CLI on this computer with your existing login.";

function modelSourceHint(source: ModelSource): string {
  const hint = isRecapProvider(source) ? `Recaps always use ${RECAP_PROVIDERS[source].label}.` : MODE_HINTS[source];
  return hint + CLI_HINT;
}

function modelSource(generator: RecapSettings["generator"]): ModelSource {
  if (typeof generator === "string") return generator;
  return isRecapProvider(generator.provider) ? generator.provider : "auto";
}

/** A provider without a model name uses its small model from Paseo's list, or the CLI default. */
function generatorFor(source: ModelSource): GeneratorMode | GeneratorChoice {
  return isRecapProvider(source) ? { provider: source } : source;
}

/**
 * A text field that saves once its value is valid and typing pauses. Invalid text stays in the
 * field with an explanation and is never saved.
 */
function ValidatedInput({
  label,
  hint,
  initialValue,
  placeholder,
  disabled,
  parse,
  onValid,
}: {
  label: string;
  hint: string;
  initialValue: string;
  placeholder?: string;
  disabled: boolean;
  /** Returns the value to save, or an error message. */
  parse(text: string): { value: string } | { error: string };
  onValid(value: string): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onChangeText = (text: string) => {
    if (timer.current) clearTimeout(timer.current);
    const result = parse(text);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setError(null);
    timer.current = setTimeout(() => onValid(result.value), SAVE_DELAY_MS);
  };
  return (
    <SettingsInput
      label={label}
      hint={hint}
      initialValue={initialValue}
      placeholder={placeholder}
      disabled={disabled}
      error={error}
      onChangeText={onChangeText}
    />
  );
}

function NumberInput({
  setting,
  label,
  hint,
  values,
  disabled,
  save,
}: {
  setting: keyof typeof SETTING_RANGES;
  label: string;
  hint: string;
  values: RecapSettings;
  disabled: boolean;
  save: Save;
}) {
  const { min, max } = SETTING_RANGES[setting];
  const current = values[setting];
  return (
    <ValidatedInput
      label={label}
      hint={`${hint} ${min}–${max}.`}
      initialValue={String(current)}
      disabled={disabled}
      parse={(text) => {
        const trimmed = text.trim();
        const value = Number(trimmed);
        if (!/^\d+$/.test(trimmed) || value < min || value > max) {
          return { error: `Enter a whole number from ${min} to ${max}.` };
        }
        return { value: String(value) };
      }}
      onValid={(value) => {
        if (Number(value) !== current) save({ [setting]: Number(value) });
      }}
    />
  );
}

function RecapSettingsForm({ settings }: { settings: ReadySettings }) {
  const { values } = settings;
  // Debounced saves fire after later renders; always write onto the latest document.
  const latest = useRef(settings);
  latest.current = settings;
  const save: Save = (patch) => {
    const { values: currentValues, revision } = latest.current;
    void latest.current.save({ ...currentValues, ...patch }, revision);
  };
  // Text fields stay editable while saving; locking them would interrupt typing.
  const disabled = settings.saving;
  const autoDisabled = disabled || !values.autoRecap;
  const autoInputDisabled = !values.autoRecap;
  const source = modelSource(values.generator);
  const model = typeof values.generator === "string" ? "" : (values.generator.model ?? "");
  const getModelPlan = useRpc(recapModelPlanRpc);
  const plan = useQuery({
    queryKey: ["paseo-recap", "models", values.generator],
    queryFn: () => getModelPlan({ generator: values.generator }),
  });

  return (
    <>
      <SettingsSection title="Automatic recaps">
        <SettingsCard>
          <SettingsSwitch
            label="Generate recaps automatically"
            hint="/paseo-recap and the pill always work."
            value={values.autoRecap}
            disabled={disabled}
            onValueChange={(autoRecap) => save({ autoRecap })}
          />
          <NumberInput
            setting="turnsBetweenRecaps"
            label="Every N turns"
            hint="Completed turns between recaps; 1 recaps after every turn."
            values={values}
            disabled={autoInputDisabled}
            save={save}
          />
          <NumberInput
            setting="idleDelaySeconds"
            label="Wait after a turn (seconds)"
            hint="If you reply sooner, that turn is not recapped."
            values={values}
            disabled={autoInputDisabled}
            save={save}
          />
          <NumberInput
            setting="minTurns"
            label="Start after (messages)"
            hint="Your messages before a session gets its first recap."
            values={values}
            disabled={autoInputDisabled}
            save={save}
          />
          <SettingsSwitch
            label="Recap subagents"
            hint="Also recap agents that other agents start."
            value={values.includeSubagents}
            disabled={autoDisabled}
            onValueChange={(includeSubagents) => save({ includeSubagents })}
          />
          <SettingsSwitch
            label="Wait for subagents"
            hint="Hold an agent's recap while its subagents run, up to 10 minutes."
            value={values.waitForSubagents}
            disabled={autoDisabled}
            onValueChange={(waitForSubagents) => save({ waitForSubagents })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Recap content">
        <SettingsCard>
          <NumberInput
            setting="historyExchanges"
            label="Recent exchanges to read"
            hint="Each is one of your messages and the reply. Text only, within about 8,000 tokens; the oldest are dropped first."
            values={values}
            disabled={false}
            save={save}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Model">
        <SettingsCard>
          <SettingsSelect
            label="Recap model"
            hint={modelSourceHint(source)}
            value={source}
            options={MODEL_SOURCE_OPTIONS}
            disabled={disabled}
            onValueChange={(next) => save({ generator: generatorFor(next) })}
          />
          {source === "auto" || source === "metadata" ? null : (
            <ValidatedInput
              // Remount per provider so the field shows the newly selected provider's model.
              key={source}
              label="Model name"
              hint="Any model id the CLI accepts. Leave empty for the provider's small model from Paseo's list, or the CLI's default."
              initialValue={model}
              placeholder="Small model"
              disabled={false}
              parse={(text) => {
                const trimmed = text.trim();
                if (trimmed !== "" && (trimmed.length > 200 || !MODEL_ID_PATTERN.test(trimmed))) {
                  return { error: "Use letters, digits, and . _ : / @ + - only, without spaces." };
                }
                return { value: trimmed };
              }}
              onValid={(next) => {
                if (next !== model) {
                  save({ generator: next === "" ? { provider: source } : { provider: source, model: next } });
                }
              }}
            />
          )}
          <SettingsRow
            label="Will use"
            hint={
              plan.data
                ? describePlan(plan.data)
                : plan.isError
                  ? "Could not read Paseo's model settings."
                  : "Checking…"
            }
          />
        </SettingsCard>
      </SettingsSection>
      {settings.saveError ? (
        <SettingsSection title="Error">
          <SettingsCard>
            <SettingsRow label="Could not save settings" error={settings.saveError} />
          </SettingsCard>
        </SettingsSection>
      ) : null}
    </>
  );
}

export function RecapSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(recapSettings);

  if (settings.status === "loading") {
    return <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text>;
  }
  if (settings.status === "error") {
    return <Text style={{ color: theme.colors.statusDanger }}>Could not load settings.</Text>;
  }
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="Recap">
        <SettingsCard>
          <SettingsAction
            label="Stored settings are invalid"
            hint={settings.error}
            actionLabel="Reset to defaults"
            onPress={() => void settings.reset()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <RecapSettingsForm settings={settings} />;
}
