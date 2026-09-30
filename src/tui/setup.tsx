import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { backToProviders, choose, confirmKey, detectSetup, initialSetupState, moveCursor, skip } from "./setup-state.js";
import type { SetupState } from "./setup-state.js";
import { formatModelSize } from "./local-models.js";
import { ACCENT, ACTIVE_THEME_NAME, RULE, THEME_NAMES, colorFor } from "./theme.js";

/**
 * The first-run screen.
 *
 * One question, asked in the order that answers itself:
 *
 *   1. **Do you have a local model?** If Ollama is running with something pulled,
 *      that is the answer needing no key, no account and no money, so it is
 *      offered first and is the first row on screen.
 *   2. **Otherwise, which provider?** Each row carries the URL to get a key,
 *      because "paste your API key" without saying where to obtain one is a dead
 *      end for anyone who has not already set one up.
 *   3. **The key.** A single masked bar. Esc goes back and clears it, so a key
 *      pasted for the wrong provider is never stored against the right one.
 *
 * Nothing is written until the final Enter, and the screen says what it wrote.
 */
export function SetupScreen({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [state, setState] = useState<SetupState>(initialSetupState);

  useEffect(() => {
    let live = true;
    void detectSetup().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  useInput((raw, key) => {
    if (key.ctrl && raw === "c") {
      skip(state);
      onDone();
      return;
    }
    if (state.step === "enter-key") {
      if (key.escape) {
        setState(backToProviders(state));
        return;
      }
      if (key.return) {
        setState(confirmKey(state));
        return;
      }
      if (key.backspace || key.delete) {
        setState({ ...state, key: state.key.slice(0, -1), error: undefined });
        return;
      }
      if (raw !== "") setState({ ...state, key: state.key + raw, error: undefined });
      return;
    }
    if (key.upArrow) {
      setState(moveCursor(state, -1));
      return;
    }
    if (key.downArrow) {
      setState(moveCursor(state, 1));
      return;
    }
    if (key.return) {
      const next = choose(state);
      setState(next);
      if (next.step === "done") onDone();
      return;
    }
    if (key.escape || raw === "q") {
      skip(state);
      onDone();
    }
  });

  if (state.step === "loading") {
    return (
      <Box flexDirection="column">
        <Text dimColor>looking for a local model …</Text>
      </Box>
    );
  }

  if (state.step === "choose-local") {
    return (
      <Box flexDirection="column">
        <Banner />
        <Text>
          <Text color={ACCENT} bold>
            {"  "}
            local models found
          </Text>
          <Text dimColor> — no key needed</Text>
        </Text>
        <List
          rows={state.local.map((model) => ({
            key: model.name,
            label: model.name,
            note: formatModelSize(model.sizeBytes),
          }))}
          cursor={state.cursor}
          empty="none"
        />
        <Footer hint="↑/↓ choose · Enter use this · Ctrl+C skip" />
      </Box>
    );
  }

  if (state.step === "choose-provider") {
    return (
      <Box flexDirection="column">
        <Banner />
        <Text>
          <Text color={ACCENT} bold>
            {"  "}
            pick a provider
          </Text>
          <Text dimColor> — or run `ollama pull llama3.2` and come back</Text>
        </Text>
        <List
          rows={state.providers.map((provider) => ({
            key: provider.id,
            label: provider.label,
            note: provider.id,
          }))}
          cursor={state.cursor}
          empty="no providers found"
        />
        <KeyUrl url={state.providers[state.cursor]?.keyUrl} />
        <Footer hint="↑/↓ choose · Enter continue · Ctrl+C skip" />
      </Box>
    );
  }

  if (state.step === "enter-key") {
    const provider = state.pending;
    return (
      <Box flexDirection="column">
        <Banner />
        <Text>
          <Text color={ACCENT} bold>
            {"  "}
            {provider?.label ?? "provider"}
          </Text>
          <Text dimColor> key</Text>
        </Text>
        <KeyUrl url={provider?.keyUrl} />
        <Box marginTop={1}>
          <Text color={ACCENT}>{"  "}</Text>
          <Text>{state.key === "" ? "" : "•".repeat(Math.min(state.key.length, 48))}</Text>
          <Text inverse>{" "}</Text>
        </Box>
        {state.error !== undefined ? (
          <Box marginTop={1}>
            <Text color="red">{"  " + state.error}</Text>
          </Box>
        ) : null}
        <Footer hint="Enter save · Esc back · Ctrl+C skip" masked />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Banner />
      <Text dimColor>{"  " + (state.message || "nothing to do")}</Text>
    </Box>
  );
}

function Banner(): React.JSX.Element {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text>
        <Text color={ACCENT} bold>
          {"  "}
          jaa
        </Text>
        <Text dimColor> — just an ai</Text>
      </Text>
      <Text dimColor>{"  " + RULE}</Text>
    </Box>
  );
}

interface Row {
  key: string;
  label: string;
  note: string;
}

function List({ rows, cursor, empty }: { rows: Row[]; cursor: number; empty: string }): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <Box marginTop={1}>
        <Text dimColor>{"  " + empty}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((row, index) => {
        const focused = index === cursor;
        return (
          <Text key={row.key} {...(focused ? { color: ACCENT } : { dimColor: true })}>
            {focused ? "  ▸ " : "    "}
            {row.label}
            {row.note === "" ? "" : <Text dimColor>{`  ${row.note}`}</Text>}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * Where to get the key, under the provider it belongs to.
 *
 * Shown rather than linked because a terminal link is not clickable, and a
 * name that has to be memorised and typed elsewhere is the part people get
 * wrong.
 */
function KeyUrl({ url }: { url: string | undefined }): React.JSX.Element | null {
  if (url === undefined) return null;
  return (
    <Box marginTop={1}>
      <Text dimColor>{"    get a key at  "}</Text>
      <Text {...(colorFor("url") !== undefined ? { color: colorFor("url") as string } : {})}>{url}</Text>
    </Box>
  );
}

function Footer({ hint, masked = false }: { hint: string; masked?: boolean }): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Text dimColor>{"  " + RULE}</Text>
      <Text dimColor>{"  " + hint}</Text>
      {masked ? <Text dimColor>{"  stored in your keyring, never printed, never sent anywhere but the provider"}</Text> : null}
      <Text dimColor>{"  theme: " + ACTIVE_THEME_NAME} +`n        {"  ·  jaa config set ui.theme <" + THEME_NAMES.join("|") + ">"}</Text>
    </Box>
  );
}
