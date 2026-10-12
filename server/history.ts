import { SETTING_RANGES } from "../shared/recap";
import type { AgentTimelineItem } from "./paseo-types";

/** Most exchanges a recap can read; the `historyExchanges` setting picks how many, up to this. */
export const HISTORY_EXCHANGES_LIMIT = SETTING_RANGES.historyExchanges.max;
/** Timeline items a recap reads; everything else is dropped before holding a timeline in memory. */
const RECAP_ITEM_TYPES: ReadonlySet<AgentTimelineItem["type"]> = new Set([
  "user_message",
  "assistant_message",
  "error",
  "compaction",
  "todo",
]);

const OMITTED_HISTORY = "[Earlier exchanges omitted]\n\n";
const EXCERPT_MARKER = "\n[... excerpted ...]\n";
const ERROR_MAX_CHARS = 300;

export interface Exchange {
  user: string;
  assistant: string;
  errors: string[];
}

/** Labeled, budgeted text of the last `maxExchanges` exchanges; empty when there is nothing to recap. */
export function buildRecapHistory(
  timeline: readonly AgentTimelineItem[],
  maxHistoryBytes: number,
  maxExchanges: number,
): string {
  return formatHistory(collectExchanges(timeline).slice(-maxExchanges), maxHistoryBytes);
}

/**
 * Keeps only what a recap can read: the text items of the last `HISTORY_EXCHANGES_LIMIT` exchanges
 * plus the latest todo list. Turn-ended events carry the whole conversation, including tool output,
 * which is too much to hold for every agent.
 */
export function trimForRecap(timeline: readonly AgentTimelineItem[]): AgentTimelineItem[] {
  let seen = 0;
  let start = 0;
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item?.type === "user_message" && item.text.trim() !== "" && ++seen === HISTORY_EXCHANGES_LIMIT) {
      start = index;
      break;
    }
  }
  const kept = timeline.slice(start).filter((item) => RECAP_ITEM_TYPES.has(item.type));
  if (kept.some((item) => item.type === "todo")) return kept;
  const latestTodo = timeline.findLast((item) => item.type === "todo");
  return latestTodo ? [latestTodo, ...kept] : kept;
}

/** True while the provider is compacting context; a recap would describe a moving target. */
export function isCompacting(timeline: readonly AgentTimelineItem[]): boolean {
  const last = timeline.findLast((item) => item.type === "compaction");
  return last?.type === "compaction" && last.status === "loading";
}

export function countUserTurns(timeline: readonly AgentTimelineItem[]): number {
  let count = 0;
  for (const item of timeline) {
    if (item.type === "user_message" && item.text.trim() !== "") count++;
  }
  return count;
}

/**
 * Groups visible text into exchanges. Tool calls, reasoning, notifications, compaction markers,
 * and plugin rows are ignored: they are noisy, large, and provider-specific.
 */
export function collectExchanges(timeline: readonly AgentTimelineItem[]): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: Exchange | null = null;
  for (const item of timeline) {
    if (item.type === "user_message") {
      const text = item.text.trim();
      if (text === "") continue;
      current = { user: text, assistant: "", errors: [] };
      exchanges.push(current);
      continue;
    }
    if (current === null) continue;
    if (item.type === "assistant_message") {
      // Providers may stream one reply as several items; join them verbatim.
      current.assistant += item.text;
    } else if (item.type === "error") {
      current.errors.push(truncateChars(item.message.trim(), ERROR_MAX_CHARS));
    }
  }
  for (const exchange of exchanges) exchange.assistant = exchange.assistant.trim();
  return exchanges;
}

export function latestActiveTask(timeline: readonly AgentTimelineItem[]): string | null {
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item?.type !== "todo") continue;
    const active =
      item.items.find((task) => task.status === "in_progress") ??
      item.items.find((task) => !task.completed && task.status !== "completed");
    if (!active) return null;
    const text = (active.activeForm ?? active.text).trim();
    return text === "" ? null : text;
  }
  return null;
}

function exchangeFields(exchange: Exchange): Array<[label: string, text: string]> {
  const fields: Array<[string, string]> = [["User", exchange.user]];
  if (exchange.assistant !== "") fields.push(["Assistant", exchange.assistant]);
  if (exchange.errors.length > 0) fields.push(["Error", exchange.errors.join("\n")]);
  return fields;
}

function formatBlock(exchange: Exchange): string {
  return exchangeFields(exchange)
    .map(([label, text]) => `${label}: ${text}`)
    .join("\n\n");
}

/**
 * Fits exchanges into `maxBytes`: first drop the oldest exchanges, then excerpt every field,
 * keeping the newest answer and any newer unanswered request.
 */
export function formatHistory(exchanges: readonly Exchange[], maxBytes: number): string {
  const latest = exchanges.at(-1);
  if (!latest) return "";
  const blocks = exchanges.map(formatBlock);
  const separatorBytes = 2;
  let bytes = blocks.reduce((sum, block) => sum + byteLength(block), 0);
  bytes += separatorBytes * (blocks.length - 1);
  if (bytes <= maxBytes) return blocks.join("\n\n");

  const retained = latest.assistant === "" ? 2 : 1;
  const oldestRetained = Math.max(0, exchanges.length - retained);
  const omissionBytes = byteLength(OMITTED_HISTORY);
  let start = 0;
  while (bytes > maxBytes - omissionBytes && start < oldestRetained) {
    bytes -= byteLength(blocks[start] ?? "") + separatorBytes;
    start++;
  }
  const omission = start > 0 ? OMITTED_HISTORY : "";
  const budget = maxBytes - byteLength(omission);
  if (bytes <= budget) return omission + blocks.slice(start).join("\n\n");

  const fields = exchanges.slice(start).flatMap(exchangeFields);
  const overhead =
    fields.reduce((sum, [label]) => sum + byteLength(label) + 2, 0) +
    separatorBytes * (fields.length - 1);
  let remaining = Math.max(0, budget - overhead);
  const excerpts = fields.map(([label, text], index) => {
    const share = Math.floor(remaining / (fields.length - index));
    // Reserve room for later fields without wasting it on short ones.
    const reserved = fields
      .slice(index + 1)
      .reduce((sum, [, later]) => sum + Math.min(byteLength(later), share), 0);
    const excerpt = excerptBytes(text, Math.max(0, remaining - reserved));
    remaining -= byteLength(excerpt);
    return `${label}: ${excerpt}`;
  });
  return omission + excerpts.join("\n\n");
}

/** Keeps the head and tail of `text` within `maxBytes`, marking the cut. */
export function excerptBytes(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  const markerBytes = byteLength(EXCERPT_MARKER);
  if (maxBytes <= markerBytes) return sliceBytes(text, maxBytes, "head");
  const half = Math.floor((maxBytes - markerBytes) / 2);
  return sliceBytes(text, half, "head") + EXCERPT_MARKER + sliceBytes(text, half, "tail");
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function sliceBytes(text: string, maxBytes: number, side: "head" | "tail"): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.length <= maxBytes) return text;
  const slice =
    side === "head" ? encoded.subarray(0, maxBytes) : encoded.subarray(encoded.length - maxBytes);
  // A cut through a multi-byte character decodes to U+FFFD; drop the partial character.
  return slice.toString("utf8").replace(/^�+|�+$/g, "");
}

function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}
