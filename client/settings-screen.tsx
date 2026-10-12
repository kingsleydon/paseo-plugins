import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import {
  recapSettings,
  type GeneratorChoice,
  type GeneratorMode,
  type RecapSettings,
} from "../shared/recap";

const IDLE_DELAY_OPTIONS = [
  { label: "Immediately", value: "0" },
  { label: "10 seconds", value: "10" },
  { label: "30 seconds", value: "30" },
  { label: "1 minute", value: "60" },
  { label: "2 minutes", value: "120" },
  { label: "5 minutes", value: "300" },
  { label: "10 minutes", value: "600" },
] as const;

const FREQUENCY_OPTIONS = [
  { label: "Every turn", value: "1" },
  { label: "Every 2 turns", value: "2" },
  { label: "Every 3 turns", value: "3" },
  { label: "Every 5 turns", value: "5" },
] as const;

const MIN_TURNS_OPTIONS = [
  { label: "1 message", value: "1" },
  { label: "2 messages", value: "2" },
  { label: "3 messages", value: "3" },
  { label: "5 messages", value: "5" },
] as const;

const GENERATOR_OPTIONS = [
  { label: "Auto", value: "auto" },
  { label: "Paseo order", value: "metadata" },
  { label: "Claude Haiku", value: "claude:haiku" },
  { label: "Codex GPT-6-Luna", value: "codex:gpt-6-luna" },
  { label: "Codex default", value: "codex:" },
  { label: "OpenCode default", value: "opencode:" },
] as const;

function generatorValue(generator: RecapSettings["generator"]): string {
  return typeof generator === "string" ? generator : `${generator.provider}:${generator.model ?? ""}`;
}

function parseGenerator(value: string): GeneratorMode | GeneratorChoice {
  if (value === "auto" || value === "metadata") return value;
  const separator = value.indexOf(":");
  const provider = separator < 0 ? value : value.slice(0, separator);
  // OpenCode models are "provider/model"; only the first colon separates our fields.
  const model = separator < 0 ? "" : value.slice(separator + 1);
  return model === "" ? { provider } : { provider, model };
}

/** Keeps a stored value selectable even when it is not one of the presets. */
function withCurrent(
  options: ReadonlyArray<{ label: string; value: string }>,
  value: string,
  label: string,
): Array<{ label: string; value: string }> {
  return options.some((option) => option.value === value) ? [...options] : [...options, { label, value }];
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

  const { values, revision } = settings;
  const update = (patch: Partial<RecapSettings>) => void settings.save({ ...values, ...patch }, revision);
  const disabled = settings.saving;
  const idleValue = String(values.idleDelaySeconds);
  const frequencyValue = String(values.turnsBetweenRecaps);
  const minTurnsValue = String(values.minTurns);
  const generator = generatorValue(values.generator);

  return (
    <>
      <SettingsSection title="Automatic recaps">
        <SettingsCard>
          <SettingsSwitch
            label="Generate recaps automatically"
            hint="Manual /recap always works."
            value={values.autoRecap}
            disabled={disabled}
            onValueChange={(autoRecap) => update({ autoRecap })}
          />
          <SettingsSelect
            label="Frequency"
            hint="Completed turns between recaps."
            value={frequencyValue}
            options={withCurrent(FREQUENCY_OPTIONS, frequencyValue, `Every ${frequencyValue} turns`)}
            disabled={disabled || !values.autoRecap}
            onValueChange={(value) => update({ turnsBetweenRecaps: Number(value) })}
          />
          <SettingsSelect
            label="Wait after a turn ends"
            hint="If you reply sooner, that turn is not recapped."
            value={idleValue}
            options={withCurrent(IDLE_DELAY_OPTIONS, idleValue, `${idleValue} seconds`)}
            disabled={disabled || !values.autoRecap}
            onValueChange={(value) => update({ idleDelaySeconds: Number(value) })}
          />
          <SettingsSelect
            label="Start after"
            hint="User messages before a session gets its first recap."
            value={minTurnsValue}
            options={withCurrent(MIN_TURNS_OPTIONS, minTurnsValue, `${minTurnsValue} messages`)}
            disabled={disabled || !values.autoRecap}
            onValueChange={(value) => update({ minTurns: Number(value) })}
          />
          <SettingsSwitch
            label="Recap subagents"
            value={values.includeSubagents}
            disabled={disabled || !values.autoRecap}
            onValueChange={(includeSubagents) => update({ includeSubagents })}
          />
          <SettingsSwitch
            label="Wait for subagents"
            hint="Hold an agent's recap while its subagents run, up to 10 minutes."
            value={values.waitForSubagents}
            disabled={disabled || !values.autoRecap}
            onValueChange={(waitForSubagents) => update({ waitForSubagents })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Model">
        <SettingsCard>
          <SettingsSelect
            label="Recap model"
            hint="Auto uses the agent's own provider first, then Paseo's metadata model order. Runs the provider's CLI with your existing login."
            value={generator}
            options={withCurrent(GENERATOR_OPTIONS, generator, generator)}
            disabled={disabled}
            onValueChange={(value) => update({ generator: parseGenerator(value) })}
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
