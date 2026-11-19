// Content shaping for the context-lens view: caps, search text, windowing.
import { CAPS } from "./model-io.js";

// Cap a string, returning { text, truncated } with an honest flag on hit.
export function capText(value, cap) {
  if (typeof value !== "string") return { text: "", truncated: false };
  if (value.length <= cap) return { text: value, truncated: false };
  return { text: value.slice(0, cap) + "…[truncated]", truncated: true };
}

// Flattened plain text of a message for search + previews.
export function messageText(msg) {
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text ?? "";
        if (part?.type === "thinking") return part.thinking ?? "";
        if (part?.type === "tool_use") return `tool_use:${part.name}`;
        if (part?.type === "tool_result") return "tool_result";
        return "";
      })
      .join("\n");
  }
  return "";
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export { clampInt };
