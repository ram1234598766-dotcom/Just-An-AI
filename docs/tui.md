# The jaa TUI

`jaa` with no arguments in a terminal opens this. `jaa chat` is the same thing,
and every option it takes works there.

```
jaa              # chat, if this is a terminal
jaa chat         # the same, explicitly
jaa chat --lsp   # and check every edit with a real compiler
jaa | less       # help, because a pipe is not a terminal
```

## What is on screen

**A status bar** that answers the questions you would otherwise have to ask:
which model is answering, how many turns have run, what the turn has cost in
tokens, and how full the context window is. The context gauge turns yellow at 70%
and red at 90%, because trimming and compaction happen quietly and you should
see them coming.

**Streaming output.** Text appears as it is generated rather than all at once,
when the provider supports it. `runAgentLoop` falls back to a single call when it
does not, so a provider without streaming works exactly as before.

**Code blocks**, boxed and labelled with their language. Fenced blocks only —
four-space-indented text is nearly always a wrapped sentence, not code, and
treating it as code makes ordinary prose unreadable.

**Tool cards.** Each tool call is one row that starts as `◐ running`, then
becomes `✓` or `✗` with how long it took. `Ctrl+R` expands the result. A card is
something you watch, not scroll past, so it stays on one line.

**Compiler verdicts, as their own row.** With `--lsp`, an edit that leaves a
type error shows `⚠` with the compiler's own words, separate from the model's
claim about the same file. This is the one thing the layout exists to make
unmissable: the model saying "done" and the compiler disagreeing.

## Commands

Type `/` to see them. They are handled by jaa and never sent to the model, so
they cost nothing. An unknown `/foo` is reported as an unknown command rather
than forwarded — a leading slash is a clear statement of intent, and quietly
billing a typo is the worst outcome.

| | |
| --- | --- |
| `/help` | commands and key bindings |
| `/rewind` | restore the working tree to an earlier turn |
| `/model` | the model answering right now |
| `/tokens` | token use and the context gauge |
| `/sessions` | the current session id |
| `/clear` | clear the screen, keep the conversation |
| `/new` | clear the screen and start over |
| `/exit` | how to quit |

## Keys

| | |
| --- | --- |
| Enter | send |
| ↑ / ↓ | walk input history |
| ← / → | move the caret |
| Ctrl+W | delete the previous word |
| Ctrl+U | clear the line |
| Ctrl+R | expand or collapse a tool result |
| Ctrl+D | quit |
| Ctrl+C twice | quit |
| Esc Esc | rewind the last edit |

Ctrl+C needs two presses so a stray interrupt during a long turn cannot throw a
conversation away. Any other key disarms it.

## When it does not open

Bare `jaa` prints help instead when stdin or stdout is not a terminal, when
`CI` is set, or when `JAA_NO_TUI` is set. `jaa | less` and `$(jaa)` are requests
for text, and swallowing them would be worse than the help output they replace.

`JAA_TUI=1` forces it on if the probe misjudges your terminal.

## How it is tested

`tests/tui-stream.test.tsx` drives the real component through a streaming
provider, a tool round-trip, every slash command and every key binding.

`tools/tui-render-check.mts` renders through Ink's own renderer into a
TTY-shaped stream with a real column count, which is the closest a headless host
gets to a terminal. A pty would be better and is not available on Windows without
an interactive console — that limit is stated rather than worked around.

`tests/tui-default.test.ts` covers the gate that decides whether bare `jaa` opens
this or prints help, because the failure mode there is a CI job that hangs.
