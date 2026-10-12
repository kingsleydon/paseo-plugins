import type { PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { recapGetRpc, recapRegenerateRpc, type RecapView, type StoredRecap } from "../shared/recap";
import { relativeTime } from "./format";

const GENERATING_POLL_MS = 2_000;

function recapQueryKey(agentId: string) {
  return ["paseo-recap", "recap", agentId] as const;
}

type Theme = PluginHostProps["theme"];

// Sizes follow Paseo's own controls: 15 px content text, 14 px secondary text, 32 px small and
// 28 px extra-small buttons.
function useRecapStyles(theme: Theme) {
  return useMemo(() => {
    const button = {
      minHeight: 32,
      paddingHorizontal: 12,
      borderRadius: 12,
      flexDirection: "row" as const,
      alignItems: "center" as const,
      justifyContent: "center" as const,
      gap: 8,
    };
    return {
      summary: { color: theme.colors.foreground, fontSize: 15, lineHeight: 21 },
      summaryMuted: { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 },
      next: { color: theme.colors.foreground, fontSize: 14, lineHeight: 20 },
      nextLabel: { color: theme.colors.foregroundMuted },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 14, lineHeight: 20 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      button: { ...button, backgroundColor: theme.colors.surface2 },
      ghostButton: { ...button, minHeight: 28, gap: 6, backgroundColor: "transparent" },
      metaText: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 12 },
      // Ghost buttons have no background; outdent them so their labels line up with the card edge.
      actions: { flexDirection: "row" as const, alignItems: "center" as const, marginRight: -button.paddingHorizontal },
      buttonText: { color: theme.colors.foreground, fontSize: 14 },
      ghostButtonText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      pressed: { opacity: 0.85 },
      disabled: { opacity: 0.5 },
      earlier: { gap: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border },
    };
  }, [theme]);
}

function recapAge(recap: StoredRecap, now: number): string {
  const age = relativeTime(recap.generatedAt, now);
  return age === "now" ? "Just now" : `${age} ago`;
}

/** Summary, next action, and metadata of one recap. Plain text only: model output is untrusted. */
function RecapBody({
  theme,
  recap,
  muted = false,
  actions = null,
}: {
  theme: Theme;
  recap: StoredRecap;
  muted?: boolean;
  /** Quiet buttons shown at the end of the metadata line. */
  actions?: ReactNode;
}) {
  const styles = useRecapStyles(theme);
  return (
    <>
      <Text style={muted ? styles.summaryMuted : styles.summary} selectable>
        {recap.summary}
      </Text>
      {recap.nextAction && !muted ? (
        <Text style={styles.next} selectable>
          <Text style={styles.nextLabel}>Next: </Text>
          {recap.nextAction}
        </Text>
      ) : null}
      <View style={styles.row}>
        <Text style={styles.metaText}>
          {recap.stale && !muted ? "Out of date · " : ""}
          {recapAge(recap, Date.now())}
          {` · ${recap.generator.model ?? recap.generator.provider}`}
          {recap.trigger === "manual" ? " · manual" : ""}
        </Text>
        {actions}
      </View>
    </>
  );
}

/** What the card needs from the pills that open it. */
export interface RecapPopoverSource {
  /** The pill's latest view of an agent's recap, so the card opens at its full size. */
  cachedView(agentId: string): RecapView | undefined;
  /** Reports a manual recap request, so the pill can show its progress. */
  track<T>(agentId: string, request: Promise<T>): Promise<T>;
}

export function makeRecapPopover(source: RecapPopoverSource) {
  return function RecapPopover(props: PluginButtonContentProps) {
    if (props.context !== "agent") return null;
    return <RecapCard {...props} agentId={props.agentId} source={source} />;
  };
}

function RecapCard({
  theme,
  layout,
  agentId,
  source,
}: PluginButtonContentProps & { agentId: string; source: RecapPopoverSource }) {
  const getRecap = useRpc(recapGetRpc);
  const regenerateRecap = useRpc(recapRegenerateRpc);
  const queryClient = useQueryClient();
  const [showEarlier, setShowEarlier] = useState(false);
  const styles = useRecapStyles(theme);
  const query = useQuery({
    queryKey: recapQueryKey(agentId),
    queryFn: () => getRecap({ agentId }),
    // Paseo sizes a popover to its first render; starting from the pill's data avoids opening at
    // the size of a loading spinner and clipping the recap that arrives a moment later.
    initialData: () => source.cachedView(agentId),
    refetchInterval: (current) =>
      current.state.data?.state === "generating" ? GENERATING_POLL_MS : false,
  });
  const regenerate = useMutation({
    // The RPC resolves only after generation finishes; `regenerate.isPending` shows progress here.
    mutationFn: () => source.track(agentId, regenerateRecap({ agentId })),
    onSettled: (view) => {
      if (view) queryClient.setQueryData(recapQueryKey(agentId), view);
      else void query.refetch();
    },
  });

  const view = query.data;
  const recap = view?.recap ?? null;
  const previous = view?.previous ?? [];
  const generating = view?.state === "generating" || regenerate.isPending;
  const error = query.error || regenerate.error ? "Could not load the recap." : (view?.error ?? null);

  const generateButton = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={recap ? "Regenerate recap" : "Generate recap"}
      accessibilityState={{ disabled: generating, busy: generating }}
      disabled={generating}
      onPress={() => regenerate.mutate()}
      style={({ pressed }) => [
        recap ? styles.ghostButton : styles.button,
        pressed && styles.pressed,
        generating && styles.disabled,
      ]}
    >
      {generating ? (
        <ActivityIndicator size={recap ? 12 : "small"} color={theme.colors.foregroundMuted} />
      ) : recap ? (
        <Icon name="RefreshCw" size={12} color={theme.colors.foregroundMuted} />
      ) : null}
      <Text style={recap ? styles.ghostButtonText : styles.buttonText}>
        {generating ? "Generating…" : recap ? "Regenerate" : "Generate"}
      </Text>
    </Pressable>
  );
  const earlierButton =
    previous.length > 0 ? (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: showEarlier }}
        onPress={() => setShowEarlier((value) => !value)}
        style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
      >
        <Text style={styles.ghostButtonText}>{showEarlier ? "Hide earlier" : `Earlier (${previous.length})`}</Text>
      </Pressable>
    ) : null;

  return (
    <View style={{ gap: 12, maxWidth: layout.compact ? undefined : 400 }}>
      {query.isPending ? <ActivityIndicator color={theme.colors.foregroundMuted} /> : null}
      {recap ? (
        // With a recap shown, regenerating is secondary: quiet buttons on the metadata line.
        <RecapBody
          theme={theme}
          recap={recap}
          actions={
            <View style={styles.actions}>
              {generateButton}
              {earlierButton}
            </View>
          }
        />
      ) : (
        // Without one, Generate is the card's main action.
        <>
          {!query.isPending && !generating ? (
            <Text style={styles.meta}>No recap yet. One appears after this agent's next turn, or generate it now.</Text>
          ) : null}
          <View style={styles.row}>{generateButton}</View>
        </>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {showEarlier ? (
        <View style={styles.earlier}>
          {previous.map((item) => (
            <View key={item.generatedAt} style={{ gap: 4 }}>
              <RecapBody theme={theme} recap={item} muted />
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
