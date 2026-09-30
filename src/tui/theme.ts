import { loadSettings } from "../config/settings.js";
/**
 * One place for every colour and glyph the interface draws.
 *
 * The reason this exists is that the TUI had colour literals scattered through
 * three files, which made "make it customisable" mean hunting for hex-free
 * strings across a component tree. With a theme object, customisation is a
 * config file and a reload, and the default is still the default.
 *
 * Colours are named by what they mean, not by hue. `accent` is not "blue" —
 * someone who cannot use blue on their terminal needs to change one field, and
 * renaming the fields by hue is what stops them doing that.
 */

export interface Theme {
  /** Brand and focus colour: the prompt, the selected row, headings. */
  accent: string;
  /** A working tool call. */
  running: string;
  /** A tool call that succeeded. */
  ok: string;
  /** A failure, and a compiler verdict. */
  error: string;
  /** A warning: something the user should notice but that is not a failure. */
  warn: string;
  /** Code fences, inline code. */
  code: string;
  /** A link, and a URL the setup screen tells someone to visit. */
  url: string;
  /**
   * The model's own text.
   *
   * Optional on purpose: undefined means "the terminal's default", which is the
   * right answer for body text. Making it a required string would force a colour
   * onto every sentence, and a theme that has to paint everything cannot be
   * turned down to nothing.
   */
  assistant?: string | undefined;
  /** What the user typed. */
  user: string;
  /** Secondary text, the horizontal rule width. */
  rule: string;
}

export const DEFAULT_THEME: Theme = {
  accent: "cyan",
  running: "yellow",
  ok: "green",
  error: "red",
  warn: "yellow",
  code: "magenta",
  url: "blue",
  assistant: undefined,
  user: "blue",
  rule: "─",
};

export type ThemeName = "default" | "mono" | "warm" | "high-contrast";

/**
 * Built-in themes.
 *
 * `mono` drops colour entirely for a terminal that renders 256 colours badly or
 * a preference for no colour at all. `high-contrast` is for the case where the
 * default's dim text is too dim to read — it is the single most common complaint
 * about a TUI, and it is fixed by a theme rather than by a bug report.
 */
export const THEMES: Record<ThemeName, Theme> = {
  default: DEFAULT_THEME,
  mono: {
    accent: "white",
    running: "white",
    ok: "white",
    error: "white",
    warn: "white",
    code: "white",
    url: "white",
    assistant: undefined,
    user: "white",
    rule: "─",
  },
  warm: {
    accent: "yellow",
    running: "yellow",
    ok: "green",
    error: "red",
    warn: "yellow",
    code: "red",
    url: "yellow",
    assistant: undefined,
    user: "green",
    rule: "─",
  },
  "high-contrast": {
    accent: "cyanBright",
    running: "yellowBright",
    ok: "greenBright",
    error: "redBright",
    warn: "yellowBright",
    code: "magentaBright",
    url: "blueBright",
    assistant: undefined,
    user: "blueBright",
    rule: "━",
  },
};

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

/**
 * The theme in force, read once at startup from `ui.theme` in the config.
 *
 * Read at module load rather than per render because every component imports
 * these constants, and a theme that changed mid-frame would repaint half the
 * screen. A config edit therefore needs a restart, which is the honest cost of
 * a module-level constant and is what every TUI with a theme does.
 *
 * A load failure falls back to the default rather than propagating: a colour
 * preference is not a reason for jaa not to start.
 */
function configuredThemeName(): string {
  try {
    const name = loadSettings().ui?.theme;
    // Resolved, not passed through: an unknown name draws the default palette,
    // and reporting that name back would say "chartreuse" over default colours.
    // The screen should never claim a theme it is not drawing.
    return themeByName(name) === DEFAULT_THEME && name !== "default" ? "default" : (name ?? "default");
  } catch {
    return "default";
  }
}

export const ACTIVE_THEME_NAME = configuredThemeName();

/** The theme in force. */
export const THEME = themeByName(ACTIVE_THEME_NAME);

export const ACCENT = THEME.accent;
export const DIM = true;
export const RULE = THEME.rule.repeat(Math.min(40, Math.max(10, (process.stdout.columns ?? 80) - 4)));

/**
 * The colour for a transcript row kind, from the theme.
 *
 * Named by the row, not by the hue, for the same reason the fields are: a theme
 * that can change "the compiler said something" independently of "the tool
 * failed" is more useful than one that only moves the palette around.
 */
export function colorFor(kind: string): string | undefined {
  switch (kind) {
    case "user":
      return THEME.user;
    case "toolCall":
      return THEME.running;
    case "error":
    case "diagnostic":
      return THEME.error;
    case "status":
      return THEME.ok;
    case "code":
      return THEME.code;
    case "url":
      return THEME.url;
    case "warn":
      return THEME.warn;
    case "assistant":
    case "compact":
    case "notice":
    case "toolResult":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Resolve a theme by name, falling back to the default.
 *
 * Falling back rather than throwing: a typo in a config file must not stop jaa
 * from starting. The cost of getting it wrong is the default colours, which is
 * a smaller mistake than a program that refuses to run.
 */
export function themeByName(name: string | undefined): Theme {
  if (name === undefined) return DEFAULT_THEME;
  const found = THEMES[name as ThemeName];
  return found ?? DEFAULT_THEME;
}
