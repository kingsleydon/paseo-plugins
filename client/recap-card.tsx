import type { PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { recapGetRpc, recapRegenerateRpc, type StoredRecap } from "../shared/recap";
import { relativeTime } from "./format";

const GENERATING_POLL_MS = 2_000;

export function recapQueryKey(agentId: string) {
  return ["paseo-recap", "recap", agentId] as const;
}

type Theme = PluginHostProps["theme"];

// Sizes follow Paseo's own controls: 15 px content text, 14 px secondary text, 32 px small buttons.
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
      ghostButton: { ...button, backgroundColor: "transparent" },
      buttonText: { color: theme.colors.foreground, fontSize: 14 },
      ghostButtonText: { color: theme.colors.foregroundMuted, fontSize: 14 },
      pressed: { opacity: 0.85 },
      disabled: { opacity: 0.5 },
      earlier: { gap: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: theme.colors.border },
    };
  }, [theme]);
}

export function recapAge(recap: StoredRecap, now: number): string {
  const age = relativeTime(recap.generatedAt, now);
  return age === "now" ? "Just now" : `${age} ago`;
}

/** Summary, next action, and metadata of one recap. Plain text only: model output is untrusted. */
export function RecapBody({
  theme,
  recap,
  muted = false,
}: {
  theme: Theme;
  recap: StoredRecap;
  muted?: boolean;
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
      <Text style={styles.meta}>
        {recap.stale && !muted ? "Out of date · " : ""}
        {recapAge(recap, Date.now())}
        {` · ${recap.generator.model ?? recap.generator.provider}`}
        {recap.trigger === "manual" ? " · manual" : ""}
      </Text>
    </>
  );
}

/** Lets the card report a manual recap request, so the pill can show its progress. */
export type TrackRecap = <T>(agentId: string, request: Promise<T>) => Promise<T>;

export function makeRecapPopover(track: TrackRecap) {
  return function RecapPopover(props: PluginButtonContentProps) {
    if (props.context !== "agent") return null;
    return <RecapCard {...props} agentId={props.agentId} track={track} />;
  };
}

function RecapCard({
  theme,
  layout,
  agentId,
  track,
}: PluginButtonContentProps & { agentId: string; track: TrackRecap }) {
  const getRecap = useRpc(recapGetRpc);
  const regenerateRecap = useRpc(recapRegenerateRpc);
  const queryClient = useQueryClient();
  const [showEarlier, setShowEarlier] = useState(false);
  const styles = useRecapStyles(theme);
  const query = useQuery({
    queryKey: recapQueryKey(agentId),
    queryFn: () => getRecap({ agentId }),
    refetchInterval: (current) =>
      current.state.data?.state === "generating" ? GENERATING_POLL_MS : false,
  });
  const regenerate = useMutation({
    // The RPC resolves only after generation finishes; `regenerate.isPending` shows progress here.
    mutationFn: () => track(agentId, regenerateRecap({ agentId })),
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

  return (
    <View style={{ gap: 12, maxWidth: layout.compact ? undefined : 400 }}>
      {query.isPending ? <ActivityIndicator color={theme.colors.foregroundMuted} /> : null}
      {recap ? (
        <RecapBody theme={theme} recap={recap} />
      ) : !query.isPending && !generating ? (
        <Text style={styles.meta}>No recap yet. One appears after this agent's next turn, or generate it now.</Text>
      ) : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={recap ? "Regenerate recap" : "Generate recap"}
          accessibilityState={{ disabled: generating, busy: generating }}
          disabled={generating}
          onPress={() => regenerate.mutate()}
          style={({ pressed }) => [styles.button, pressed && styles.pressed, generating && styles.disabled]}
        >
          {generating ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
          <Text style={styles.buttonText}>{generating ? "Generating…" : recap ? "Regenerate" : "Generate"}</Text>
        </Pressable>
        {previous.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showEarlier }}
            onPress={() => setShowEarlier((value) => !value)}
            style={({ pressed }) => [styles.ghostButton, pressed && styles.pressed]}
          >
            <Text style={styles.ghostButtonText}>
              {showEarlier ? "Hide earlier" : `Earlier (${previous.length})`}
            </Text>
          </Pressable>
        ) : null}
      </View>
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
