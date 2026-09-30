import React from "react";
import { Box, Text } from "ink";
import { formatTokens, gauge, gaugeTone } from "./render.js";
import { THEME } from "./theme.js";

/**
 * The splash: the first thing someone sees, and the first chance to lie.
 *
 * Every value on it is read from the live app. The gauge is the real context
 * ratio, the model is the resolved model, memory is the real token count in the
 * prompt. Nothing here says 64% because a screenshot said 64%.
 *
 * The frame is drawn as text rather than with an Ink `Box` border, because the
 * status labels belong *in* the top and bottom rows and a Box border cannot hold
 * content. Hand-drawing it costs a padding calculation and buys a screen that
 * looks deliberate instead of decorated.
 */

/** Block glyphs, one entry per row, top to bottom. Single-width cells only. */
const GLYPHS: Record<string, readonly string[]> = {
  // The J's stem is three cells wide, matching the A's stroke weight. A narrower
  // stem renders as a hairline next to a bold A and the wordmark stops reading
  // as letters.
  J: ["   ███", "   ███", "   ███", "   ███", "   ███", "█████", " ████"],
  A: [" ██████", "██   ██", "██   ██", "███████", "██   ██", "██   ██", "██   ██"],
};

/** The wordmark, as glyph keys. Three letters, so the two `A`s are separate. */
const WORD = ["J", "A", "A"] as const;

/** Columns of space between glyphs. */
const GLYPH_GAP = 2;

/**
 * The wordmark, one string per row, every row the same width.
 *
 * Exported for tests. A splash is the sort of thing that breaks by one space and
 * nobody notices until it is on someone's screen, and that failure is invisible
 * to every other gate in this project.
 */
export function logoLines(): string[] {
  const height = Math.max(...WORD.map((key) => (GLYPHS[key] ?? []).length));
  const glyphWidth = Math.max(...WORD.map((key) => (GLYPHS[key]?.[0] ?? "").length));
  const width = WORD.length * glyphWidth + (WORD.length - 1) * GLYPH_GAP;
  const rows: string[] = [];
  for (let row = 0; row < height; row += 1) {
    let line = "";
    WORD.forEach((key, index) => {
      line += GLYPHS[key]?.[row] ?? "";
      if (index < WORD.length - 1) line += " ".repeat(GLYPH_GAP);
    });
    rows.push(line.padEnd(width, " "));
  }
  return rows;
}

/** The logo's width in columns. */
export const LOGO_WIDTH = logoLines()[0]?.length ?? 0;

/** Below this the logo does not fit and the plain wordmark takes over. */
export const LOGO_MIN_WIDTH = 56;

const MIN_FRAME = 44;
const MAX_FRAME = 74;

/** Pad to `width` with spaces, never truncating. */
function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * A framed status row: label, rule, label.
 *
 * `left`/`right` are the corner glyphs, so the top row can open `┌…┐` while the
 * bottom closes `└…┘`. Passing one glyph for both is how a frame ends up with
 * `┌` on the right-hand side, which is exactly as wrong as it looks.
 */
function statusRow(
  leftCorner: string,
  left: string,
  right: string,
  rightCorner: string,
  width: number,
): React.JSX.Element {
  // Corners, then a space, the label, a space, the rule, a space, the label, a
  // space, the corner. If the labels alone will not fit, the rule collapses to
  // nothing: a status you cannot read is worse than a border you cannot see.
  const room = width - left.length - right.length - 6;
  return (
    <Text>
      <Text dimColor>{leftCorner}</Text>
      <Text color={THEME.accent}>{" " + left + " "}</Text>
      <Text dimColor>{THEME.rule.repeat(Math.max(0, room))}</Text>
      <Text color={THEME.accent}>{" " + right + " "}</Text>
      <Text dimColor>{rightCorner}</Text>
    </Text>
  );
}

export interface SplashProps {
  /** Columns available, normally `process.stdout.columns`. */
  columns: number;
  /** True while a turn is running, so the top-left label is honest. */
  busy: boolean;
  /** The resolved model name, or undefined if none could be resolved. */
  model?: string | undefined;
  /** Tokens in the prompt, against the budget, for the gauge. */
  contextTokens: number;
  budget: number;
  /** A short label for where this session is, e.g. the working directory. */
  workspace: string;
}

/**
 * One row of the logo, shaded by depth.
 *
 * The reference look is a bright top fading to a darker bottom. In a terminal the
 * honest way to get that is a dim ramp down the rows, not a drop shadow: an
 * offset shadow behind letters this dense doubles every stroke and the word stops
 * being readable, which is the one thing a wordmark has to be.
 */
function logoShade(index: number, total: number): boolean {
  return index >= Math.ceil(total * 0.6);
}

/**
 * The splash screen.
 *
 * Renders nothing at all when the terminal is too narrow to hold a frame. That is
 * a real case - 30 columns is a split pane - and a splash that wraps there turns
 * the whole session into a column of ragged fragments.
 */
export function Splash(props: SplashProps): React.JSX.Element {
  const available = Number.isFinite(props.columns) ? Math.max(0, Math.floor(props.columns)) : 80;
  if (available < MIN_FRAME) return <Text> </Text>;

  const inner = Math.min(MAX_FRAME, available);
  const ratio = props.budget > 0 ? props.contextTokens / props.budget : 0;
  const safe = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const tone = gaugeTone(ratio);
  const state = props.busy ? "BUSY" : "READY";
  const modelLabel = props.model === undefined ? "MODEL: NONE" : "MODEL: ACTIVE";
  const barColor = tone === "ok" ? THEME.ok : tone === "warn" ? THEME.warn : THEME.error;
  const bar = `┌${"█".repeat(Math.round(safe * 10)).padEnd(10, "░")}┐`;

  const body: { text: string; color?: string | undefined; dim?: boolean }[] = [];

  if (available >= LOGO_MIN_WIDTH) {
    const rows = logoLines();
    // Centred, because a logo pinned to the left margin with 40 empty columns
    // to its right reads as an accident of layout rather than as a composition.
    const indent = " ".repeat(Math.max(0, Math.floor((inner - 2 - LOGO_WIDTH) / 2)));
    rows.forEach((line, index) => {
      body.push({ text: indent + line, color: THEME.accent, dim: logoShade(index, rows.length) });
    });
  } else {
    body.push({ text: "  J A A", color: THEME.accent });
  }

  body.push({ text: "" });
  body.push({ text: `  ${THEME.rule}${THEME.rule}[ JUST-AN-AI ]${THEME.rule}${THEME.rule}`, color: THEME.accent });
  body.push({ text: "  AI CODING AGENT" });
  body.push({ text: `  ${bar} ${Math.round(safe * 100)}%  ${formatTokens(props.contextTokens)}/${formatTokens(props.budget)}`, color: barColor });

  const bodyWidth = inner - 2;

  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      <Text>{statusRow("┌", `STATUS: ${state}`, modelLabel, "┐", inner)}</Text>
      {body.map((row, index) => (
        <Text key={index}>
          <Text dimColor>{"│"}</Text>
          <Text
            {...(row.color !== undefined ? { color: row.color } : {})}
            {...(row.dim === true ? { dimColor: true } : {})}
          >
            {pad(row.text, bodyWidth)}
          </Text>
          <Text dimColor>{"│"}</Text>
        </Text>
      ))}
      <Text>{statusRow("└", `STATUS: ${props.workspace}`, `MEMORY: ${formatTokens(props.contextTokens)}`, "┘", inner)}</Text>
    </Box>
  );
}

/** The gauge string, for tests that want to assert the splash reports real use. */
export function splashGauge(props: Pick<SplashProps, "contextTokens" | "budget">, width = 10): string {
  const ratio = props.budget > 0 ? props.contextTokens / props.budget : 0;
  return gauge(ratio, width);
}
