import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { RecapTimelineData } from "../shared/recap";

/**
 * The recap as a muted line after the turn it summarizes, sized like Paseo's compaction marker.
 * Plain text only: model output is untrusted.
 */
export function RecapLine({ item, theme }: PluginTimelineItemProps<RecapTimelineData>) {
  const styles = useMemo(
    () => ({
      row: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 8, paddingVertical: 8 },
      icon: { height: 20, justifyContent: "center" as const },
      body: { flex: 1, minWidth: 0 },
      text: { color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 },
      label: { color: theme.colors.foreground },
    }),
    [theme],
  );
  const { summary, nextAction } = item.data;
  return (
    <View style={styles.row} accessibilityLabel={`Recap: ${summary}${nextAction ? ` Next: ${nextAction}` : ""}`}>
      <View style={styles.icon}>
        <Icon name="ScrollText" size={14} color={theme.colors.foregroundMuted} />
      </View>
      <View style={styles.body}>
        <Text style={styles.text} selectable>
          {summary}
        </Text>
        {nextAction ? (
          <Text style={styles.text} selectable>
            <Text style={styles.label}>Next: </Text>
            {nextAction}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
