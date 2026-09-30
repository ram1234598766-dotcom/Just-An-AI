# jaa - plan & progress

> Living tracker. One entry per phase. Gates are run for real and pasted, never assumed.

## North star

A local-first, multi-provider terminal coding agent shipped as the npm package
`jaa-cli` (bin: `jaa`). Bring your own key from any provider, or run fully local
on Ollama. Every phase gates on `npm run lint` + `npm test` + `npm run build`.

**The bar:** jaa must be strictly better than the *union* of Claude Code, OpenAI
Codex CLI, DeepSeek Harness (`dsh`), and opencode taken together -- not better
than any one of them. That means it must adopt every capability any of them
ships well, keep the two advantages it already has, and add the one thing none
of them have.

## The thesis

Three claims define the product. Everything in the roadmap serves one of them.

1. **Provider freedom is table stakes, not a feature.** Claude Code is
   Anthropic-only. Codex is OpenAI-only. opencode and jaa accept any provider.
   jaa keeps this and extends it (OAuth subscription auth, reasoning-effort
   control, OpenAI Responses API, prompt caching).
2. **Compatibility is the real moat.** Every team already has `CLAUDE.md`,
   `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.mcp.json`, and a `config.toml`
   with MCP servers in it. jaa reads all of them, writes all of them, and runs
   as an MCP server inside the others. Switching to jaa must cost zero
   reconfiguration. No competitor does this.
3. **Measured, not claimed.** Phase 10 is a benchmark harness, not a feature.
   "Better" is a number produced by running the same tasks through jaa and the
   reference harnesses. Phases 11-20 are gated on moving that number.

## Competitive position (as of 2026-09-25)

Legend: `yes` = ships today, `partial` = exists but materially behind,
`no` = absent. Sources: vendor docs for each project, cross-checked against a
third-party integration survey (Calyx, Sep 2026) that pins exact versions.

| Capability | Claude Code 2.1.x | Codex 0.151 | DeepSeek dsh | opencode 1.18 | jaa 0.1.0 |
|---|---|---|---|---|---|
| Providers | Anthropic only | OpenAI only | any (plugin) | 75+ | 10 -- **wins** |
| Local models (Ollama) | no | `--oss` only | any | yes | yes -- **wins** |
| Multi-provider routing | no | no | yes | yes | yes -- **wins** |
| MIT / open source | no (CLI only) | Apache-2.0 | MIT | MIT | MIT -- ties |
| Hooks (lifecycle events) | yes (10) | yes (9) | plugin events | yes (7) | **no** |
| OS-level sandbox | Seatbelt/bwrap | Landlock+seccomp | pluggable | Docker | **partial** (Seatbelt/bwrap; none on Windows) |
| Permission model | allow/deny/ask/defer | 3 policies x 3 modes | guard + monotonic deny | rule-based | **yes** (allow/deny/ask, 3 modes, deny-absolute) |
| Multi-agent | subagents + teams + workflows | 6 threads, depth, CSV fan-out | subagents + workflows | sessions | **yes** (pool, worktrees, fan-out, background) -- **wins** |
| Worktree isolation | yes | yes | -- | -- | **yes** |
| Checkpoint / rewind | yes (Esc Esc) | fork + worktree | -- | snapshots | **no** |
| Compaction | summarize ~95% | model-native | plugin | summarize ~90% | **yes** (summarize, pinned, observable) |
| Live LSP in the loop | yes | via MCP | -- | 30+ auto | **yes** (session-per-language, worktree-safe) -- ties |
| Plugin packaging | marketplaces | 90+ plugins | everything-is-plugin | plugin array | **no** |
| Code Mode (TS orchestrator) | -- | -- | yes | -- | **no** |
| Cross-harness config read | CLAUDE.md | AGENTS.md | AGENTS.md | AGENTS.md | AGENTS.md only |
| Cross-harness config write | -- | -- | -- | -- | **no** |
| Headless JSON mode | `-p` | `exec --output json` | SDK / JSON-RPC | `run` | `ask --json` |
| Background / scheduled | durable cron, wakeup | persisted goals, queue | jobs | background bash | **no** |
| TUI depth | strong | strong (Rust) | web UI | strong (Go) | **partial** (basic Ink) |

### What jaa already wins, and must not lose

- **Provider freedom.** 10 providers behind one interface, including the entire
  OpenAI-compatible family via `baseURL`. Neither Claude Code nor Codex can do
  this. This is the exit ramp from any vendor's pricing.
- **Local-first with real tools.** Ollama works end-to-end with native tool
  calls, not just chat. Verified live against `llama3.2:3b`.
- **Auditable from source.** MIT, ~4.4k lines of strict TypeScript, 161 tests.
  Read the whole agent in an afternoon. Claude Code is closed.
- **Eval harness in the box.** `jaa eval` ships with pass@1 / pass@N and token
  accounting. Most competitors measure you externally; jaa measures itself.

### Where jaa was behind, ranked by how much it would cost to lose a user

The list as originally ranked, with the current state of each item. Items 1-5
are closed; the remainder is what still stands between jaa and the bar.

| # | Gap | Phase | State |
|---|---|---|---|
| 1 | No real permission model — one boolean (`allowBash`) | 11 | **closed** — allow/deny/ask/defer, specificity ranking, deny absolute, 55 tests |
| 2 | No OS-level sandbox — `confinePath` validates paths, it does not contain a process | 12 | **closed on macOS + Linux**, with gap **G1** (none on Windows) and **G2** (the runtime confinement gate was never executed — argv is verified, confinement is not) |
| 3 | No hooks | 13 | **closed** — 16 events, 5 handler kinds, crash-to-deny |
| 4 | Multi-agent single-threaded | 15 | **closed** — pool, worktrees, fan-out, background, 3 limits (L1-L3) |
| 5 | No rewind | 14 | **closed** — checkpoint, rewind, fork, 3 known limits |
| 6 | TUI is shallow — no multi-pane, no agent dashboard, no typed tool cards, no themes or keybinds | 20 | **open** — the most visible surface is the least developed, and it is last so it can render everything above it |
| 7 | No plugin packaging — skills and subagents cannot be bundled as one installable unit with hooks and MCP servers | 19 | **open** |
| 8 | LSP is manual — `jaa lsp diagnose` is a one-shot command | 17 | **closed** — long-lived session per language, auto-injected after a mutating call, 4 verified defects |

The order of the original ranking is preserved deliberately: 6-8 were ranked
below the trust and team blockers on purpose, and re-sorting them now that the
top of the list is closed would misrepresent how much each one costs.

## Status board

| # | Phase | Commit | Status |
|---|-------|--------|--------|
| 0 | Repo scaffold + CLI skeleton | `b001053` | **done** |
| 1 | Config + keyring (`~/.jaa`, env precedence, `key/config/setup/doctor`) | `6acc554` | **done** |
| 2 | Provider adapters (openai-compatible, anthropic, gemini, ollama) + router | `a01abfd` | **done** |
| 3 | Agent loop + context budgeting + sessions | `7d59ed4` | **done** |
| 4 | Tools (fs, patch, bash safe/ask, web, git) | `1390502` | **done** |
| 5 | Ink TUI + `-p`/`--json` non-interactive mode | `bf16eb1` | **done** |
| 6 | Skills (SKILL.md loader + autotrigger + GitHub install) | `8f40eaa` | **done** |
| 7 | Subagents + AGENTS.md project memory | `69739e7` | **done** |
| 8 | MCP client/server + LSP diagnostics (protocol-correct) | `cf1c8f9` | **done** |
| 9 | Eval harness + seed tasks + npm packaging polish | `aede7b0` | **done** |
| 10 | Benchmark + parity harness (the measuring stick) | `f8b6928` | **done, unmeasured** (parity blocked, no model) |
| 11 | Permission system (allow/deny/ask/defer + rules) | `09cb41f` | **done** |
| 12 | OS-level sandbox (Seatbelt / bubblewrap) | `de3ce22` | **done on macOS + Linux, none on Windows** (4 open gaps) |
| 13 | Hooks (lifecycle events + blocking decisions) | `e9a81ab` | **done** |
| 14 | Checkpoint, rewind and fork | `e9a81ab` | **done** (3 known limits) |
| 15 | Multi-agent orchestration (parallel + worktrees + background) | `62adbe8` | **done** (3 known limits) |
| 16 | Compaction and persistent memory | `5c825eb` | **done** (2 known limits) |
| 17 | Live code intelligence (LSP in the loop) | `b6d2a37` | **done** (1 known limit, 2 claims retracted) |
| 18 | Compatibility and interop layer | - | planned |
| 19 | Plugin system and registry | - | planned |
| 20 | The TUI, first-run setup, splash, and making it the default | `c1476db`, `4f839ec` | **done** (3 open limits; L1 closed in a real pty) |
| 21 | Streaming on every adapter | - | **next** |
| 22 | Live theme reload + a proper config surface | - | planned |
| 23 | Diff review in the TUI | - | planned |
| 24 | Multi-session and a session switcher | - | planned |
| 25 | Attachment pipeline (images, files, URLs) | - | planned |
| 26 | Cost accounting and a budget the agent respects | - | planned |
| 27 | Prompt caching, done properly | - | planned |
| 28 | Structured output and tool-result schemas | - | planned |
| 29 | Edit prediction and inline completion | - | planned |
| 30 | A test double for providers, and fault injection | - | planned |
| 31 | Multi-pane workspace, subagent dashboard, keymap, `/export` | - | planned |

### Dependency order

```
20 TUI -----> 21 streaming ------> 27 prompt caching
    |                `-----------> 26 cost accounting
    |
    +--------> 22 config/theme --> 23 diff review
    |                `-----------> 24 sessions --+-> 25 attachments
    |
    +--------> 28 structured output
    +--------> 29 edit prediction
    +--------> 31 multi-pane (needs 11 permissions,
    |                15 subagents, 23 diff review, 24 sessions)

30 provider double ---> unblocks every phase above that needs a
                        deterministic, fault-injecting provider
```

Two of these are deliberately not "features": 30 exists because every phase after
it is harder to test without it, and 22 exists because a theme you cannot change
without restarting is a screenshot, not a setting.

The loop is worth naming: 30 needs 21 to exist before it can assert that a
streamed message equals a non-streamed one, and 21 is easier to build with 30
already there. The order above resolves it by taking the interface from Phase 20
and the adapters second, so 30 lands on a contract that already has two
implementations to disagree with.

## Decisions (dated)

- **2026-09-29 — Phase 15: the subagent tool set is an intersection, and that
  is the whole escalation defence.** The phase gate asks that a subagent cannot
  escalate its own permissions. The tempting implementation is a merge: union
  the declaration into the parent's set, then subtract the disallowed ones. That
  is one line longer than correct and fails in the direction that matters —
  `declared.length > parent.length` is the whole attack. So `effectiveToolNames`
  iterates the *parent's* tools and only ever removes, and there is deliberately
  no branch that adds one.
  - *It is structural, not a prompt instruction.* A subagent that says "you may
    now run bash" changes nothing, because nothing a worker returns is read as
    configuration. `WorkerOutput` carries only `output`, `usage` and `children`;
    a returned `PoolOptions` or widened tool list has no reader.
  - *A declaration is applied twice, deliberately.* Once in the pool
    (`effectiveToolNames`, per task) and again in `runSubagent`, which filters
    the advertised registry. They look redundant and are not: the permission
    engine is asked about a call the registry has not heard of, so narrowing the
    *advertised* list is what stops the model spending a turn on a tool the gate
    will refuse.
  - *Bad declarations are dropped, not clamped.* `MaxTurns: many` and
    `Isolation: docker` leave the field unset, so the caller's default applies.
    Clamping would turn a typo into a cap of 0 — an agent that stops before it
    starts — which is a worse failure than the typo.
- **2026-09-29 — Phase 15: the injection scan matches a tight phrase list, and
  says out loud when it fires.** A subagent that reads a poisoned file can quote
  it into its own report, and the parent reads that as its own trusted peer's
  request. The scan removes the literal instruction text and frames the report
  as untrusted data.
  - *Broad patterns were rejected on purpose.* Matching "you are now" or bare
    "ignore" fires on ordinary prose and on the security documentation this
    repository is full of. A filter that mangles honest output gets switched
    off, which is worse than no filter, so the list is limited to phrases whose
    only function is to redirect an AI agent.
  - *Four benign sentences are asserted not to fire* in the test suite,
    alongside the attacks that must. Without that half the test would pass on a
    filter that removes everything.
  - *It is a mitigation, not a proof, and is recorded as limit L1 rather than
    described as a guarantee.* The real control is the worker's tool set.
  - *Peer-to-peer messages are scanned too.* A message is a more direct channel
    than a report: worker A posts a shell command to worker B, who is mid-task
    with tools in hand.
- **2026-09-29 — Phase 15: background detachment is a detached child process,
  not `fork()`.** A real `fork()` needs a native addon on Windows, which would
  make `jaa` un-installable without a build toolchain — the same reasoning that
  made Phase 12 decline Job Objects. `spawn` with `detached: true`,
  `stdio: "ignore"` and `unref()` gives a worker that survives the parent's exit
  and writes to the same board the parent reads, which is what makes
  `jaa tasks attach` work in a process that spawned nothing.
  - *The consequence is stated rather than papered over:* the parent holds no
    handle, so stop cannot be a signal. It is cooperative and observable —
    `requestStop` marks the board, the child polls, `isStale` reports a worker
    that stopped making progress. Recorded as limit L3.
- **2026-09-29 - Phase 17: language servers are launched by unwrapping the npm
  shim, never through a shell.** The obvious fix for "Windows cannot spawn an
  npm-installed language server" is `cmd.exe /d /s /c`, and it is wrong. Measured
  on this host with every argument double-quoted: `&`, `|` and `>` still break
  out of the line, and `%PATH%` **expanded to the real value**. A project
  directory is a path a user typed and may contain any of those, so routing it
  through a shell would mean jaa executes a command the path chose - in a
  codebase whose whole permission story is "do not run a shell where an argv
  suffices". `resolveSpawn` therefore reads the standard npm shim, finds the
  script it would have run, and spawns `process.execPath` against it. `/s` is also
  rejected outright: it breaks every quoted form, including the safe ones.
  - *It refuses rather than falls back.* An unresolvable command, or a batch file
    that is not a recognised npm shim, throws with a message naming the file. A
    shim is a file inside a global install directory, not one jaa controls, so
    guessing what it would execute is not a trade worth making.
- **2026-09-29 - Phase 17: `typescript-language-server` is push-only, and it
  gates that on a capability the LSP specification does not define.** Read out of
  the server's own bundled source: eatures.diagnosticsSupport =
  Boolean(capabilities.textDocument.publishDiagnostics)`, and
  `FileDiagnostics.publishDiagnostics()` returns early when the flag is false. A
  client that omits the key gets a server that handshakes correctly, answers
  `textDocument/diagnostic` with "Unhandled method", and never sends a single
  diagnostic - with no error anywhere. Three further defects hid behind that
  one: notifications were read from `result` rather than `params`; the server
  publishes a URL-encoded, lowercased URI that never matches the one sent; and
  `initialize` omitted `rootUri`, so no `tsconfig.json` was loaded and no file
  belonged to a project. **None of the four is visible to a unit test with a
  stubbed server**, which is why the phase ships a test that runs against the
  real one and asserts both that a real error is reported and that a clean file
  reports nothing.
- **2026-09-29 - Phase 17: TypeScript 7 removed `tsserver`, so the language
  server and the type compiler are resolved separately.** `typescript@7` is the
  native Go port and ships only `tsc`. A project on it therefore has nothing for
  `typescript-language-server` to drive, and the server fails at `initialize`
  with "Could not find a valid TypeScript installation". So the registry resolves
  the server's command *and* a `tsserver` and reports the two failures as two
  different facts with two different fixes, and the repository carries an aliased
  `typescript5@npm:typescript@5.9.3` purely to have something to drive. The
  project's own 	ypescript@^7.0.2 gate is untouched: aliased, dev-only, and
  never on the build path.
- **2026-09-29 - Phase 17: injected diagnostics ride on the tool result, not on
  a message.** A provider requires every tool result to immediately follow the
  assistant message that proposed the call, and an inserted message moves every
  later position along - which is exactly the drift the Phase 14 turn index
  exists to prevent. Same reasoning as `appendHookContext`, and the same
  constraint, so the two features agree by construction.
- **2026-09-29 - Phase 16: compaction runs on the request, never on the loop's
  `history`, because Phase 14 checkpoints are tagged by message position.**
  `runAgentLoop` returns the full untrimmed transcript and every Phase 14
  checkpoint carries the 1-based position of the assistant message that proposed
  a tool call; `restoreMessagesToTurn` and `forkSession` slice on those
  positions. Splicing `history` in place would shift every position after the
  compaction point, so a checkpoint taken before it would resolve to a different
  message after it -- and `jaa rewind` would restore the wrong content having
  reported success. So the loop compacts the outgoing request and leaves the
  saved transcript intact; the on-disk reclaim is a separate, explicit
  `jaa compact`, behind a confirmation.
  - *This costs something real and is stated rather than hidden:* the saved
    session file keeps growing for the life of the conversation. That is the
    trade for `turnIndex` and the saved file agreeing, which is worth more than
    the disk.
  - *The order inside the loop is load-bearing.* Compaction runs on the full
    `history` **before** `trimToBudget`, because `compactIfNeeded` refuses when
    trimming would not drop a message -- so an already-trimmed request made every
    compaction a silent no-op. The first implementation did exactly that, and
    the test that caught it asserts the provider received a compacted request.
- **2026-09-29 - Phase 16: auto-memory is a Markdown file in the repository, and
  it is untrusted on read.** Auto-memory is the one place a model writes something
  that changes what the model is told next time, so the design answers that with
  visibility rather than with a sandbox: `JAA-MEMORY.md`, in the project root,
  checked in, delimited by `<!-- jaa-memory:start -->` / `:end -->` markers,
  readable with `cat` and editable with any editor. No database, no hidden store.
  - *The markers exist so a person can write below the notes.* A heading alone
    cannot express "this part is mine", and without that a `remember` call eats
    whatever the operator wrote under it.
  - *It goes through the Phase 15 injection scan on read.* The file is inside a
    repository, so whoever authored the checkout wrote it. A note that reads like
    an instruction stays on disk -- where the operator can see what tried to get
    in, via `jaa memory list --rejected` -- and is withheld from the system
    prompt. Otherwise "remember this" is a way to plant instructions in every
    future session.
  - *The cap evicts oldest-first and is measured against the whole file*, prose
    and header included. Measuring the entries alone let a file with a long
    preamble sit permanently over the limit and evict everything while still
    being over it.
  - *`remember` is in `MUTATING_TOOLS` but deliberately **not** in
    `NEVER_IMPLICITLY_ALLOWED`*, so a permission mode can allow it -- the file it
    writes is a notes document, not code. It declares no `path`, so the Phase 14
    machinery takes no snapshot: the file is checked in, so `git` restores it.
- **2026-09-29 - Phase 16: a failed summary falls back to trimming, and says
  so.** A summariser that throws must not cost the user the conversation, and a
  summary that comes back *larger* than what it replaced has made the request
  worse. Both fall back to `trimToBudget` and report a `reason` rather than
  silently degrading. A compaction that costs a provider call and saves nothing
  is worse than no compaction, because the user is paying for it either way.
- **2026-09-28 — Credential scanning is enforced, not just intended.**
  The repo is public, so a secret that reaches a commit reaches everyone who
  clones, and deleting the file afterwards does not remove it from history.
  `scripts/check-secrets.mjs` refuses such a commit, wired as two hooks
  (`pre-commit` over staged blobs, `commit-msg` over the message — separate
  because `COMMIT_EDITMSG` still holds the *previous* message at pre-commit
  time) plus a `--all` mode for the working tree.
  - *Fails closed.* A tracked file it cannot read, or a scan that cannot finish,
    refuses the commit rather than reporting clean. This was found by testing:
    the first `--all` implementation read from `HEAD:`, so in a repo with no
    commits it scanned zero files and printed "clean" — a false pass, the worst
    possible failure for a guard. It now reads the checked-out tree.
  - *Masks what it reports.* A scanner that prints the secret becomes a second
    copy of it in terminal scrollback and in CI logs.
  - *Catches the shape that actually happens here:* a credential embedded in a
    URL, which is how a `git remote` line ends up pasted into a doc.
  - *Not a guarantee.* `--no-verify` skips the local hooks, so
    `.github/workflows/ci.yml` runs the same scan server-side as its first step.
  A full scan of all 28 revisions and 235 text blobs found **0 credentials**; the
  15 personal absolute paths it did find were removed in `9211eab`, and rewriting
  them out of history is left as an owner decision.
- **2026-09-27 — Phases 13 and 14 shipped together in one commit (`e9a81ab`).**
  They share the turn-index contract — `runAgentLoop` tags a checkpoint with the
  1-based *message position* of the assistant message that proposed the call, not
  the model-turn counter, because the counter drifts the moment one turn emits
  several messages. `restoreMessagesToTurn` and `forkSession` slice on message
  positions, so the two halves only line up because of that choice.
  - *Fail-closed is enforced at two levels.* Within a group, `deny > ask > allow`
    regardless of declaration order, and on a blocking event any crashed or timed-out
    handler forces the group to `deny`. Across groups the same ranking applies, so an
    `allow` group cannot shadow a later `ask`. Both were found by review after the
    first implementation resolved `[allow, deny]` to `allow` — the exact case the gate
    exists to catch.
  - *Restore semantics were inverted and are now per file.* A snapshot tagged turn T
    is taken *before* turn T's write, so restoring "the state at the end of turn T"
    means the single snapshot with the smallest turn tag strictly **greater** than T.
    The first implementation used `<= T`, which restored the oldest content and never
    touched a file written at T.
  - *Three known limits, deliberately not hidden:*
    1. `recordCheckpoint` dedups by content hash and returns early on a repeat, so a
       content that recurs keeps only its earliest tag and cannot express "this content
       was current at end of turn T". Fixing it needs a turn→content index in the store.
    2. Turn↔message mapping is still positional, so a turn covering several messages
       will drift until the loop persists an explicit turn index.
    3. Hashing reads as `utf8`, so binary files hash and restore lossily.
- **2026-09-25 — Phase 12 shipped a smaller scope than planned, deliberately.**
  The plan called for `src/sandbox/darwin.ts`, `src/sandbox/linux.ts`
  (Landlock + seccomp) and `src/sandbox/win32.ts` (Job Objects + ACL guard).
  Only the macOS and Linux mechanisms were built, as
  `src/sandbox/generate.ts` + `detect.ts` + `apply.ts`.
  - *Landlock/seccomp dropped:* both need a compiled helper or a native addon.
    bubblewrap gives the same filesystem, network and PID-namespace guarantees
    with no build step, and a stub that reported Landlock without enforcing it
    would be worse than not having it. `wrapCommand` now **refuses** a `landlock`
    request rather than silently substituting bubblewrap and discarding the
    rules the caller wrote.
  - *Win32 Job Objects dropped:* a native binding would make `jaa`
    un-installable without a toolchain, which contradicts the one-command
    install that is the product's front door. Recording the gap (G1) beats
    shipping a claimed boundary.
  This is recorded as a decision rather than left as a silent omission, because
  the difference between "not built yet" and "not going to be built" matters to
  whoever picks this up next.
- **2026-09-25 — Single branch: `main` only.** The owner directed that all work
  commit and push straight to `main`, with no feature branches. The six
  `phase/*` branches (0 through 11) were already fully merged and have been
  deleted locally; `main` was at `09cb41f` before this change and is in sync
  with `origin/main`. Historical branch names in the phase log below are left
  exactly as written, because they record what actually happened at the time.
  The status board's `Branch` column is now `Commit`.
- **2026-09-25 — Competitive bar set:** jaa must beat the *union* of Claude Code,
  Codex CLI, DeepSeek Harness, and opencode, not any one of them. Phases 11-20
  are the competitive core; anything outside it is listed under "Deferred past
  Phase 20" rather than silently dropped.
- **2026-09-25 — Benchmark before features:** Phase 10 lands before Phase 11 so
  every later phase can be gated on a movement in a measured number. The task
  set is committed before any result is recorded, to stop the benchmark being
  tuned to flatter jaa.
- **2026-09-25 — Dependency order is fixed:** permissions (11) before sandbox
  (12) before hooks (13); checkpoint (14) before multi-agent (15); TUI (20)
  last so it can render what the earlier phases produce. Reordering breaks
  stated preconditions.
- **2026-09-25 — Compatibility is the moat, not a feature:** jaa reads
  `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.cursorrules`, `.cursor/rules/*.mdc`,
  `.windsurfrules`, `.github/copilot-instructions.md`, `.mcp.json`,
  `~/.codex/config.toml`, and `opencode.json`; and writes `AGENTS.md`,
  `CLAUDE.md`, and `.mcp.json`. Full matrix above.
- **2026-09-25 — Never execute foreign plugin code silently:** `.opencode/plugins/*.js`
  and plugin-provided hooks are *listed* in `jaa doctor`, never evaluated during
  detection. Installing executable content requires explicit confirmation, and
  plugin tools are subject to the same permission engine and sandbox as
  built-ins.
- **2026-09-25 — Never clobber another tool's config:** jaa writes only files it
  created, tracked in `.jaa/compat-manifest.json`. `AGENTS.md` and `CLAUDE.md`
  need `--force` to overwrite. Every other export is stdout only.
- **2026-09-25 — Platform honesty over platform claims:** if an OS sandbox
  primitive is unavailable, `jaa doctor` says so with the reason and the
  affected guarantee. Windows has no Seatbelt equivalent, so its containment is
  documented as Job Objects plus an ACL guard, not as equivalent isolation.
- **2026-09-25 — Conservative multi-agent defaults:** `max_depth` defaults to 1
  and `max_threads` to 6, matching Codex's guidance that deeper recursion turns
  broad delegation into repeated expensive fan-out. Fan-out is opt-in.
- **2026-09-25 — Package name:** publish as `jaa-cli` (free on npm; `jaa` is
  squatted by an empty `0.0.0`). Bin command stays `jaa`. Scoped
  `@mrityunjay/jaa` is the fallback.
- **2026-09-24 — Ecosystem:** TypeScript + Node 26, npm distribution. Verified:
  `node --version` = v26.5.0, `npm --version` = 12.0.2 (host: Windows,
  PowerShell).
- **2026-09-24 — Old Python assets:** `.venv` + `__pycache__` removed from repo.
  Recovery scripts moved to `tools/recovery/`. Recovered Python prototype copied
  to `reference/` (read-only snapshot, not installed, never published).
- **2026-09-24 — Provider approach:** official SDKs (`openai` covers the
  OpenAI-compatible family via `baseURL`; `@anthropic-ai/sdk`; `@google/genai`;
  `ollama` for local-first). **No API key ever baked into the repo or the
  package.** Keys live only in `~/.jaa/.env` (mode-restricted) or env vars.
  Precedence: process env > project `.env` > `~/.jaa/.env`.
- **2026-09-24 — Built-in eval harness** is a core phase gate (Phase 9),
  shipping `jaa eval` with golden tasks/ and metrics (pass@1, retries, tokens,
  cost). Improvements are measured, not claimed.
- **2026-09-24 — GitHub:** local commits on feature branches only (`phase/<n>`).
  No `git push`, no GitHub token stored or configured; owner handles publishing
  to GitHub with his own credentials.
- **2026-09-24 — VantaOS** (`~/Website`) is out of scope and
  must remain untouched.
- **2026-09-24 — Keyring format:** `~/.jaa/.env` stores exactly one line per
  provider, `JAA_<PROVIDER>_API_KEY=value`. Raw line reader (not dotenv) so
  secret values survive stray `#`/`$`. Masked everywhere it is displayed.
  Local-only providers (ollama) never need a key.
- **2026-09-24 — Piped secrets:** `echo $KEY | jaa key set openai` reads stdin
  when it isn't a TTY; `jaa key set <provider> <key>` on a TTY is fine too.
  Secret never appears in command output (`****<last4>` only).

## Security log

- **2026-08-15 message leak:** recovered source-dump included a leaked GitHub
  token across 5 files under `~/.config/manicode/projects/jaa/chats/...`
  plus `message-history.json`. All occurrences replaced with `[REDACTED]`;
  re-scanned — no `gh[opu]_` patterns remain anywhere in `.config\manicode` or in
  the recovered source now held in `reference/`.
- **Standing rule:** `.gitignore` excludes `*.env*` (except `.env.example`),
  `*.key`, `*.pem`. `package.json` `files` whitelist excludes everything except
  `dist/`, `README.md`, `LICENSE`, `plan.md`. Structured logs never contain key
  material; keyring output masks values.

## Verification record

| Date | Command | Result |
|------|---------|--------|
| 2026-09-24 | `git init -b main` | ok |
| 2026-09-24 | `npm i commander` + `npm i -D typescript @types/node vitest tsx` | ok — resolved: commander ^15.0.0, typescript ^7.0.2, @types/node ^26.6.2, vitest ^5.0.1, tsx ^4.23.15 |
| 2026-09-24 | `npm run lint` (`tsc --noEmit`, strict) | ok |
| 2026-09-24 | `npm test` (`vitest run`) | ok — 4/4 passed |
| 2026-09-24 | `npm run build` (`tsc -p tsconfig.build.json`) | ok |
| 2026-09-24 | `node dist/cli/index.js --version` | ok — `0.1.0` |
| 2026-09-24 | `node dist/cli/index.js doctor` | ok — node ok, git ok, tmp ok, platform info, data-dir info |
| 2026-09-24 | `npm audit --audit-level=high` | ok — 0 vulnerabilities |
| 2026-09-24 | `git commit` on `phase/0-baseline` | ok — root commit `b001053`, 62 files |
| 2026-09-24 | `npm i zod dotenv` | ok — added to deps |
| 2026-09-24 | `npm run lint` (Phase 1 first pass) | ok — 4 errors (all new code) fixed: exactOptionalPropertyTypes on `SetupOptions`, unused param-properties on `EnvLayers`, `ProcessEnv` vs `Record<string,string>` |
| 2026-09-24 | `CI=1 npm test` | ok — 16/16 passed (12 new config tests + 4 cli) |
| 2026-09-24 | `npm run build` | ok (tsconfig.build.json) |
| 2026-09-24 | smoke (temp `JAA_HOME`): `setup --provider openai --key … -y`, `echo | key set anthropic`, `key list`, `config set/get/list`, `doctor`, `key remove` | ok — masked `****<last4>`, config.json contains no secret, `.env` created, piped key accepted |
| 2026-09-24 | real `~/.jaa` scan | ok — only dirs + default config.json; no `.env`, no secrets |
| 2026-09-24 | `npm i openai @anthropic-ai/sdk @google/genai ollama` | ok — resolved: openai ^7.23.0, @anthropic-ai/sdk ^0.128.0, @google/genai ^2.24.0, ollama ^0.6.3 (install scripts blocked non-fatally) |
| 2026-09-24 | `npm run lint` (Phase 2 first pass) | errors fixed in new code: exactOptionalPropertyTypes on mapped request fields, `openai` v7 types moved to `openai/resources/chat/completions/completions` (not root), Anthropic `InputSchema` requires literal `type:"object"` → neutral `ToolDef.inputSchema` tightened, Gemini `Schema`/ollama `Tool` boundary casts, union narrowing in tests |
| 2026-09-24 | `npm test` | ok — 29/29 passed (13 new provider tests) |
| 2026-09-24 | `npm run build` | ok (tsconfig.build.json) |
| 2026-09-24 | `npm run lint` (Phase 3 first pass) | errors fixed in new code: exactOptionalPropertyTypes on `ask` loop-options builder + `resolveModel` input, unused `ClientProviderAdapter`/`ChatMessage` imports in tests, test array needing an explicit `ChatMessage[]` annotation |
| 2026-09-24 | `npm test` | ok — 61/61 passed (9 budget + 7 loop + 16 session tests) |
| 2026-09-24 | `npm run build` | ok (tsconfig.build.json) |
| 2026-09-24 | smoke: `session list`, `ask --help`, `ask --provider nope`, `ask --resume s-nope-0000` | ok — no-sessions hint, full help, clean unknown-provider + unknown-session errors |
| 2026-09-24 | `node dist/cli/index.js ask "…" --save` | blocked at runtime — `fetch failed` (local Ollama not running); error surfaced cleanly, not a code failure |
| 2026-09-24 | live Ollama ask (Phase 3): `ask "Reply with exactly the word OK." --provider ollama --model qwen2.5-coder:7b --save --max-turns 1` | ok — `OK`, session created; `session list`/`show` verified `[system][user][assistant]` |
| 2026-09-24 | resume reuse of session provider/model + delta persistence (fresh session `s-mufqr9yg-12717f8a`) | ok — resumed session reuses stored provider/model; new `[user]` message persisted; delta printing doesn't replay history |
| 2026-09-24 | `npm run lint` (Phase 4 first pass) | 3 errors fixed in new code: `exactOptionalPropertyTypes` on `tools` in loop-options builder, `execFile` stdout typed `string \| Buffer` at the boundary, non-existent `toStartWith` matcher → `toMatch` |
| 2026-09-24 | `npm test` | ok — 84/84 passed (23 new tool tests: registry, fs, globToRegExp, patch, bash gate, web scheme, git not-a-repo) |
| 2026-09-24 | `npm run build` | ok (tsconfig.build.json) |
| 2026-09-24 | direct registry smoke (temp-ws): `write_file` round-trip + `list_dir` | ok — 12 tools advertised (`read_file,write_file,list_dir,stat,glob,patch,bash,fetch_url,git_status,git_log,git_diff,git_show`); wrote 6 bytes to note.txt |
| 2026-09-24 | `npm i ollama-js` Ollama SDK version note | see row above — ollama ^0.6.3 |
| 2026-09-24 | live Ollama tool round-trip (`qwen2.5-coder:7b`, `--max-turns 4`) | **partial** — loop executed 0 tool turns because this qwen2.5-coder build returns tool calls as *text* (`{"name":"write_file",...}` in `content`), not native `tool_calls`. Verified directly against Ollama 0.34.2 `/api/chat`. Registry + loop tool wiring covered by unit tests instead |
| 2026-09-24 | live Ollama tool round-trip (`llama3.2:3b`, `--provider ollama --model llama3.2:3b --ctx 2048 --max-turns 6`, in temp `live-ws`) | **ok** — native `tool_calls` end-to-end: agent called `write_file(greetings.txt,"hello from llama3.2")`, file landed on disk (SHA-256 `331CB6…`), final answer `[completed] 2 turn(s) · 1119 in / 58 out`. Confirms the loop + registry + provider wiring works against a real tool-native model |
| 2026-09-24 | raw Ollama `/api/chat` (llama3.2:3b, tool payload) | **ok** — native `tool_calls` array returned; first tool-mapping result under qwen2.5-coder:7b was a model build difference, not a wiring bug |
| 2026-09-24 | `npm run lint` + `npm test` + `npm run build` (`--ctx` num_ctx feature) | ok — 88/88 (8 files, +4: loop numContext passthrough ×1, ollama num_ctx mapping ×2, mapping sanity ×1) |
| 2026-09-24 | live Ollama context regression — `--ctx 2048` | **required on this machine**: bare llama3.2:3b fails at serve (`ggml CPU buffer 63.9 GB for KV cache`) with `OLLAMA_NUM_PARALLEL=8`; passing `options.num_ctx=2048` fixes it. Committed as `3520cda`

| 2026-09-25 | `npm run lint + npm test + npm run build + npm audit --audit-level=high` | ok — 129/129 tests (12 files incl. 23 new skills tests), 0 vulnerabilities, smoke `jaa skill list`/`--help`/ask `--no-skills` all green, Phase 6 gate complete → `phase/6-skills` committed as `8f40eaa`
| 2026-09-25 | `npm run lint + npm test + npm run build + npm audit --audit-level=high` | ok — 144/144 tests (13 files, +15 agents tests), 0 vulnerabilities, smoke `jaa agent list`/`jaa agent show code-reviewer` all green, Phase 7 gate complete → `phase/7-subagents` committed as `69739e7`
| 2026-09-25 | `npm run lint + npm test + npm run build + npm audit --audit-level=high` | ok — 156/156 tests (15 files, +12 MCP/LSP protocol tests), 0 vulnerabilities, smoke `jaa mcp serve --help`, `jaa lsp diagnose --help` all green, Phase 8 gate complete → `phase/8-mcp-lsp` committed as `cf1c8f9`
| 2026-09-25 | `npm run lint + npm test + npm run build + npm audit --audit-level=high` | ok — 161/161 tests (16 files, +5 eval tests), 0 vulnerabilities, smoke `jaa eval --help` + `npm run pack:dry-run` (172 files, only dist/README/LICENSE/plan.md), Phase 9 gate complete → `phase/9-eval` committed as `aede7b0` |
| 2026-09-25 | `npm run lint + CI=1 npm test + npm run build + npm audit --audit-level=high` | ok — 190/190 tests (17 files, +29 bench tests), 0 vulnerabilities. Phase 10 gate: `jaa bench --list` → 46 cases / 10 tags; live `jaa bench --tags debug --timeout 8000 --out <ndjson>` ran 7 cases end-to-end, all recorded as FAIL with `error: agent loop failed: fetch failed` (no local model reachable) and **no crash**; resume re-run added 0 duplicate rows. Baseline reads 0% only because no model was available on the host, not because of a code fault. Competitor parity numbers **not verified** — no competitor binary was invoked |
| 2026-09-25 | `npm run lint + CI=1 npm test + npm run build + npm audit --audit-level=high` | ok — 268/268 tests (18 files, +55 permission tests), 0 vulnerabilities. Phase 11 gate: `jaa perm list` / `jaa perm test` verified end to end. Two independent security reviews were run; the first returned **BLOCK** with 2 critical + 6 major findings, the second found 2 further criticals in the fixes. All were fixed and each is now a named regression test: shell-operator chaining cannot widen a prefix allow, whitespace/case cannot evade a prefix deny, `./`/`../`/absolute/case path variants all hit the same rule, `full-auto` never implies bash, an MCP-provided unknown tool never inherits a mode baseline, a malformed config warns instead of silently voiding denies, and a bad `allow` no longer discards a valid `deny`. `jaa chat` was found completely ungated and is now gated |
| 2026-09-25 | `npm publish` + `npm install -g jaa-cli` + `jaa --version` | ok — `jaa-cli@0.1.0` live on npm (tarball 103 kB, 172 files, shasum `93f4d6bb…`), global bin at `%APPDATA%/npm/jaa`, `jaa --version` → `0.1.0`. Auth via `~/.npmrc` (`//registry.npmjs.org/:_authToken=...`); first token was read-only/2FA-gated (403), replaced with a publish-scoped bypass-2FA token |
| 2026-09-29 | `npm run lint` (Phase 15 first pass) | errors fixed in new code: `exactOptionalPropertyTypes` on the `parseModelField` return, `no-control-regex` written as literal C0 bytes in `inject.ts` (repaired by line replacement), unused `parent` set in `effectiveToolNames`, `task.startedAt = undefined` → `delete` (the board compiles with `exactOptionalPropertyTypes`, so absent and `undefined` differ), duplicate `ToolCall` import, `unfinishedTasks` imported from the wrong module |
| 2026-09-29 | `npm run lint` + `CI=1 npm test` + `npm run build` + `npm audit --audit-level=high` | ok — **851/851 tests across 29 files** (+94 new, 0 regressions from 757/757 across 28), `npm run lint` 0 errors, `npm run build` 0, `npm audit --audit-level=high` **0 vulnerabilities**. Smoke: `jaa tasks --help` / `list` / `stop` / `attach` all correct, with exit code 1 on a failed or unknown task; `jaa doctor` reports the new `orchestrator` check; `jaa agent run --alongside nope` fails cleanly on an unknown subagent. **Phase 15 gate, all four assertions:** three workers edit one overlapping file with zero conflicts (real git worktrees, interleaved writes, each file holds exactly one writer's content end to end); the depth and thread caps hold under a deliberate fan-out bomb (3 roots × 25 children each, peak concurrency ≤ `maxThreads`); a subagent cannot escalate its own permissions (`effectiveToolNames` is an intersection, proven against a hand-edited `AGENTS.md` asking for `deploy_production` and `disable_sandbox`); injected instructions in a subagent report are neutralized (5 canonical overrides plus whitespace and control-char evasion, with 4 benign security sentences asserted not to fire) |
| 2026-09-29 | `npm run check:secrets` | ok — `clean (174 tracked file(s) scanned)` |
| 2026-09-29 | `npm run lint` (Phase 16 first pass) | errors fixed in new code: duplicate `ToolCall` import in the CLI, `unfinishedTasks` imported from the wrong module, missing `AgentLoopCompactionOptions` / `CompactionNotice` imports in the TUI, an unbalanced brace in `app.tsx` after the prefix edit, and a nested-backtick template literal in the test. **A silent corruption was also caught here:** editing `prefixFor` in `app.tsx` replaced the Unicode prefixes `❯`, `→` and `↳` with literal ASCII `?`. The diff is now clean for those lines and the assertion is back |
| 2026-09-29 | `npm run lint` + `CI=1 npm test` + `npm run build` + `npm audit --audit-level=high` | ok — **900/900 tests across 30 files** (+49 new, 0 regressions from 851/851 across 29), `npm run lint` 0 errors, `npm run build` 0, `npm audit --audit-level=high` **0 vulnerabilities**, `npm run check:secrets` clean (184 files). Smoke: `jaa memory list/add/clear` all correct, `clear` refuses without `--yes` and exits 1, and a note appended outside the markers is treated as operator prose and left alone. **Phase 16 gate, both assertions:** a session driven past the threshold keeps the system prompt, the project memory, a pinned mid-transcript message and the recent tail, and the token count drops (asserted end-to-end through `runAgentLoop`, not just the function); auto-memory survives a "restart" because it is a file, re-read with no in-process state |
| 2026-09-29 | three bugs found by the Phase 16 tests, not by review | (1) the memory renderer emitted `MEMORY_END` **before** the entries, so the managed block was empty and every note was silently stranded in the prose — `readMemory` returned `[]` for a file that plainly contained notes; (2) the loop called `compactIfNeeded` on an **already-trimmed** request, and because it refuses when trimming would drop nothing, every compaction was a silent no-op in the real loop while passing in isolation; (3) the size cap measured the entries only, so a file with a hand-written preamble could stay over the limit while evicting every note. All three now have named regression tests |
| 2026-09-29 | `npm run lint` (Phase 17 first pass) | errors fixed in new code: `createRequire` missing (a bare `require` in an ESM module threw a `ReferenceError` that a `catch {}` swallowed, so `resolveTsserver` silently returned `undefined` and the server was reported uninstalled); swapped `resolveTsserver` arguments; unused imports; a `NavigationSession`/`LspClient` type mismatch. **A file was also corrupted mid-edit** by a PowerShell `List[string].InsertRange` failure that removed ~120 lines of `client.ts` and spliced two methods together — repaired by reconstructing the block, and the existing `tests/lsp.test.ts` confirmed the repair |
| 2026-09-29 | `npm run lint` + `CI=1 npm test` + `npm run build` + `npm audit --audit-level=high` | ok — **931/931 tests across 31 files** (+31 new, 0 regressions from 900/900 across 30), `npm run lint` 0, `npm run build` 0, `npm audit --audit-level=high` **0 vulnerabilities**, `npm run check:secrets` clean (188 files). **20 tests failed on the first full run** and all 20 had one cause: `--lsp` had been inserted into `ask`'s option list twice, so Commander threw on *every* command at startup ("conflicting flag '--lsp'"), which is why `key set`, `hooks list` and `doctor` all failed at once. Removing the duplicate fixed all 20. Smoke: `jaa lsp list` reports both servers and their tsserver, `lsp list --json` emits the records, `ask --help` shows `--lsp`, `doctor` adds an `lsp` check |
| 2026-09-29 | four defects found only by driving the real `typescript-language-server` | (1) `spawn` of an npm shim is `ENOENT`/`EINVAL` on Windows, so Phase 8's `lsp diagnose` could never have worked here; (2) the server gates all publishing on a client capability the LSP spec does not define (`textDocument.publishDiagnostics`), read out of its bundled source — omitting it yields a silent server; (3) notifications were read from `result` instead of `params`; (4) the server publishes `file:///c%3A/…` against a client that sent `file:///C:/…`, so every publish landed under an unreachable key. Verified fixed by a real end-to-end run: a file with `const wrong: number = "not a number"` reports `Type 'string' is not assignable to type 'number'` at 3:14 and `5:3`, and a clean control file reports 0 |
| 2026-09-29 | `npm i -D @ast-grep/napi` then `npm uninstall @ast-grep/napi` | **net zero, deliberately.** Installed and verified working (parses this repository and extracts `runAgentLoop`, `drive`, `createHookWiring` … structurally, so tree-sitter is genuinely available here). Then concluded the language server already provides definition, references, hover and symbols *semantically*, and that detection-by-parsing needed only extension scanning plus a project marker. An unused native module in a package that must install with no toolchain is a net negative, so it was removed. Recorded as limit L7 — "we tried the obvious tool and it was redundant" is a result |
| 2026-09-29 | `npm i -D typescript5@npm:typescript@5.9.3` | ok — resolved 5.9.3, ships `lib/tsserver.js`, `npm run lint` and `npm run build` unchanged. The project's own `typescript@^7.0.2` is untouched: aliased, dev-only, never on the build path. **Runtime `dependencies` unchanged**, so there is no bundle delta beyond the new source |
| 2026-09-29 | `winget install Rustlang.Rustup` + `rustup component add rust-analyzer` | ok — cargo 1.98.1, rustc 1.98.1, rust-analyzer 1.98.1. Needed to close the last probeable registry entry. The component step is not optional: `~/.cargo/bin/rust-analyzer.exe` is a rustup *proxy* that exits 1 when the component is absent, which looks exactly like a broken server |
| 2026-09-29 | Live-probed every registry entry with a real project | typescript, python, rust, go, cpp, **java** all report a real error in a broken file and **nothing** in a clean control file. All six registry entries are now proven against a real server, and a new entry without a probe fails the test. This is what turned up the pull-diagnostics bug below and the three JDT LS bugs — every fixture was wrong in a way only a real server could explain |

## Phase log

### Phase 0 — repo scaffold + CLI skeleton
- [x] `git init -b main`
- [x] Remove Python `.venv` (3.14) + `__pycache__`
- [x] Move 6 recovery scripts → `tools/recovery/`
- [x] Copy recovered project → `reference/` (43 files)
- [x] `.gitignore` (secrets-safe), `LICENSE` (MIT), `README.md`
- [x] `tsconfig.json` (strict) + `tsconfig.build.json` + `vitest.config.ts`
- [x] `package.json` deps installed, versions recorded (see verification table)
- [x] `src/cli/index.ts` (`--version`, `--help`, `doctor`) + `src/doctor.ts` + `src/version.ts`
- [x] tests for cli/doctor (4 tests)
- [x] gate run: lint, test, build, smoke `node dist/cli/index.js --version` → **0.1.0**, `doctor` → all green
- [x] fixed: `--version` read `0.0.0` (dist layout differs per directory depth) → bounded walk-up to package root in `src/version.ts`
- [x] `npm audit` at high → 0 vulnerabilities
- [x] phase commit on `phase/0-baseline` → `b001053`

### Phase 1 — config + keyring *(next)*
- [x] `src/config/paths.ts`: `~/.jaa` layout (root, sessions, skills, cache, `.env`)
- [x] `src/config/env.ts`: precedence process env > project `.env` > `~/.jaa/.env`; `EnvLayers` without mutating `process.env`, per-key `SecretRef.source`, `resetEnvLayers()` + `findSecret()`
- [x] `src/config/providers.ts`: provider registry (openai, anthropic, google, groq, deepseek, mistral, together, xai, azure, ollama) → env var names + `JAA_<ID>_API_KEY`; `providerStatuses()` shared with doctor
- [x] `src/config/keyring.ts`: `key set/list/remove`, masked output (`****<last4>`), raw line reader, mode 0600 on POSIX
- [x] `src/config/settings.ts`: zod-typed settings (`defaultProvider`, `ollamaBaseUrl`, `models.*`), `config get/set/list` with dotted-path validation
- [x] `src/config/setup.ts`: interactive wizard (provider pick → paste key) + `--provider --key -y` non-interactive + piped-stdin key
- [x] bootstrap `~/.jaa` on first command (creates dir tree + defaults `config.json`)
- [x] `doctor` gained a `providers` check (names + source, never values)
- [ ] tests → done (12: env precedence, keyring round-trip/masking, settings validation, setup)
- [ ] phase commit on `phase/1-config` → **done** (gate: lint ok, test 20/20, build ok, smoke ok, `npm audit` 0)

### Phase 2 — provider adapters + router *(done)*
- [x] `src/providers/types.ts`: neutral `Role`/`ChatMessage`/`ToolCall`/`ToolDef`/`ChatRequest`/`Usage`/`ChatResponse`/`ChatStreamChunk`/`ProviderAdapter`/`ResolvedModel`; `ToolDef.inputSchema` typed as object-root JSON Schema (satisfies Anthropic `InputSchema`)
- [x] `src/providers/openaiCompatible.ts`: factory for the whole OpenAI-compatible family (OpenAI, Groq, DeepSeek, Mistral, Together, xAI, Azure, local vLLM/LM Studio) — SDK v7 types imported from `openai/resources/chat/completions/completions`; `chat()` + `stream()`; pure `mapMessagesToWire`/`mapWireToolCalls`/`toolToWire`
- [x] `src/providers/anthropic.ts`: SDK adapter, `system` param collapse, tool_result blocks, `mapToolCalls`, `DEFAULT_MAX_TOKENS = 2048`, injectable `fetch` for tests
- [x] `src/providers/gemini.ts`: SDK adapter (`GoogleGenAI`), systemInstruction + functionCall/functionResponse parts, `Schema` boundary cast, usage from usageMetadata
- [x] `src/providers/ollama.ts`: local-first adapter (no key), `options.temperature`/`num_predict`, tool_calls as parsed objects
- [x] `src/providers/router.ts`: `resolveProviderKey` (env layers then keyring, never logs value), `resolveAdapter` (localOnly → ollama; helpful setup hint when keyless), `chat()`, `resolveModel()`, `defaultModelFor()` per provider
- [x] tests → done (13: wire mappers for all 4 families, fake-fetch round-trips openai+anthropic, router resolution incl. keyless ollama + hint + settings default)
- [x] phase gate: lint ok, test 29/29, build ok → commit on `phase/2-providers`

### Phase 3 — agent loop + context budgeting + sessions *(done)*
- [x] `src/agent/budget.ts`: `estimateTokens` (chars/4, floor 1) + `estimateMessageTokens` (overhead + tool-call args) + `estimateChatTokens`; `trimToBudget` = chunk-based (system chunks always kept; newest non-system chunk kept even when it alone overflows; assistant-tool_calls chunk never split from its tool results; `Infinity` budget = no trim). `DEFAULT_TOKEN_BUDGET = 32_000`
- [x] `src/agent/loop.ts`: `runAgentLoop` — per-request `trimToBudget` against the provider context budget, returns the full untrimmed transcript; `executeTool` (injected; Phase 4 registers real tools), executor throws fed back as tool results (loop never crashes); stops on `completed` (no tool calls) / `max_turns` (`DEFAULT_MAX_TURNS = 20`); cumulative usage; render callbacks `onAssistantMessage`/`onToolCall`/`onToolResult` for the Phase 5 TUI
- [x] `src/agent/session.ts`: one JSON file per session under `~/.jaa/sessions/`; zod-validated on every read (disk = hostile); id `s-<base36 ts>-<hex>` guarded by `/^s-[A-Za-z0-9_-]{4,63}$/` (path traversal); title derived from first user message (≤60 chars, ellipsis); `createSession` seeds a system prompt only for brand-new conversations; `saveSession` atomic (tmp + rename, mode 600 on POSIX); `loadSession` returns `undefined` for unknown ids and throws on corrupt; `listSessions` newest-first and skips corrupt files; `appendMessages` bumps `updatedAt`
- [x] CLI: `jaa ask <prompt>` (options: provider/model/system/max-turns/token-budget/temperature/resume/save) prints assistant replies, persists deltas on `--resume`/`--save`; `jaa session list|show|remove`
- [x] tests → done (32: budget trimming invariants incl. tool-call pairing, scripted-adapter loop round-trips incl. tool feed-back + executor-throw recovery + max_turns + per-request trimming + callbacks, session round-trip/corrupt/id-guard/list-sort/title)
- [x] phase gate: lint ok, test 61/61, build ok, smoke ok → commit on `phase/3-loop`

### Phase 4 — tools *(done)*
- [x] `src/tools/types.ts`: `ToolContext` (`root`/`cwd`/`allowBash`) + `ToolDefinition` (`name`, `description`, `inputSchema` JSON Schema, zod `schema`, `run(input, ctx)`) — context injected per execution, registry stays context-free
- [x] `src/tools/registry.ts`: `createRegistry(tools)` — `list()` → neutral `ToolDef[]` for advertising, `execute(name, argsJson, ctx)` (JSON-arg parse, zod validation with path-qualified issue report, unknown-tool + handler errors returned as strings so the loop never crashes); `confinePath` decides containment on the **real location**, not the spelling — `..`/absolute resolved away lexically, then `realpathSync.native` (POSIX symlink, Windows junction, 8.3 alias, case flip) expanded on every call and the test made resolved-against-resolved, so a link planted inside `root` is refused too; null-byte guard; resolution failure fails closed. Two limits stand: the check precedes the open, so a link swapped in between is a TOCTOU race it does not close, and a file that does not exist yet is resolved via its deepest existing ancestor with the missing tail re-appended (the tail cannot hide a link, because every existing ancestor was resolved); `runProcess` (execFile, no shell, timeout, maxBuffer) shared by bash/git; `clampOutput` → 80 KB per tool result
- [x] `src/tools/fs.ts`: `read_file` (binary sniff, truncated at cap), `write_file`, `list_dir`, `stat`, `glob` (`*`/`?`/`**`, workspace-only via `globToRegExp`, 500-entry cap)
- [x] `src/tools/patch.ts`: `patch` — exact-anchor hunks (`oldText`→`newText`), each must match exactly once (ambiguity rejected), applied in order, **atomic** (no partial writes); ≤20 hunks
- [x] `src/tools/bash.ts`: `bash` behind the ask-gate — refuses when `ctx.allowBash` is false (tells the model the gate), otherwise `runProcess` via `sh -c`/`cmd /d /s /c`, default 30 s timeout (cap 120 s), exit-code trailer
- [x] `src/tools/web.ts`: `fetch_url` — http(s)-only, `AbortSignal.timeout`, redirects followed, body capped at share cap; `src/tools/git.ts`: read-only `git_status`/`git_log`/`git_diff`/`git_show` all run `git -C <root>` (can't touch anything outside the workspace)
- [x] `src/tools/index.ts`: `defaultToolDefinitions()` (fs + patch + bash + web + git) + `createDefaultRegistry()`
- [x] CLI: `ask` wires the registry by default; `--no-tools` = plain chat; `--no-bash` = advertise but keep the shell gated (bash stays gated unless the operator opts in)
- [x] tests → done (23: registry advertising/unknown-tool/bad-JSON/zod-path/error-recovery, fs round-trip/traversal-escape/absolute-escape/`..\`-escape/list/stat/glob, globToRegExp no-slash-crossing, patch unique/atomic/ambiguous, bash gate + run, web scheme guard, git not-a-repo)
- [x] phase gate: lint ok, test 84/84, build ok, smoke partial initially (qwen2.5-coder:7b text-tools) → **ok after re-verify** on `llama3.2:3b` (native tool calls, live 2-turn round-trip; see verification record) → committed on `phase/4-tools` (`1390502`)

### Phase 5 — Ink TUI + non-interactive mode *(complete)*

- [x] `src/tui/app.tsx`: `ChatApp` Ink component — typed-input prompt (`❯`), idle hint
      (`type a message and press Enter · Ctrl+C to quit`), live transcript rendering
      (`❯`/`→`/`↳`/`…` prefixes with status meta, colors by line kind), busy/cursor
      states, error + retry state. Exported for `jaa chat` (Ink) and `startChat`.
- [x] `src/tui/render.ts`: display helpers — `clip`/`summarize` (bounded single-line
      collapse; `\r\n`/`\s+` normalized), `formatToolCall` (re-parsed JSON args),
      `summarizeToolResult` (`(ok)`/`(failed)` meta), `linesFromMessages` for the
      resumed-transcript view (mirrors the live transcript so the initial render and
      the streaming view look identical).
- [x] `src/agent/loop.ts` callbacks wired into the TUI: `onAssistantMessage` /
      `onToolResult` drive live line rendering; cumulative `usage` + `stopReason`
      (`completed` / `max_turns`) feed the footer status line.
- [x] Bug fixes surfaced by the Ink test harness:
      - **Duplicate tool-call line:** the TUI previously rendered `→ tool(...)` from
        both `onAssistantMessage` (which already emits the call) and a redundant
        `onToolCall` callback → printed twice. Removed the duplicate callback. The
        loop still calls it; the TUI simply no longer double-prints.
      - **Final status line hidden when idle:** the input row only rendered `status`
        while `busy === true`, so the post-loop `completed · N turn(s) · X in / Y out`
        footer (and the `error — … to retry` line) were invisible. The row now
        renders `input || status` so the completion / error status is visible idle.
- [x] tests → `tests/tui-app.test.tsx` (ink-testing-library, 3 tests): idle-hint echo;
      full tool round-trip `→ bash({"command":"ls"})` → `↳ ls succeeded (ok)` →
      final answer `done` → `completed · 2 turn(s) · 16 in / 7 out`; and loop-failure
      surfacing (`loop failed:` + retry hint). **3/3 passing.**
      NOTE — ink-testing-library v4 `Stdin` does NOT queue chunks: two synchronous
      `stdin.write(...)` calls coalesce into one, so `parse-keypress` receives
      `"text\r"` instead of a lone `\r` and the `\r → name:'return'` mapping never
      fires. The tests therefore `await delay(...)` between the text write and the
      `\r` write so each forms its own readable chunk. (In a real terminal this is
      not needed; it's a testing-library PassThrough artifact.)
  - [x] phase gate → lint ok, test 106/106 (11 files), build ok, `npm audit --audit-level=high` → 0 vulnerabilities, smoke `node dist/cli/index.js doctor` → all green, `startChat` renders via `jaa chat`
  - [x] phase commit on `phase/5-tui` → `bf16eb1`

### Phase 6 — skills (SKILL.md loader + autotrigger + GitHub install) *(complete)*
- [x] `src/skills/types.ts`: `Skill` interface (id, name, description, triggers, body, path) + `ParsedFrontmatter`
- [x] `src/skills/loader.ts`: `parseFrontmatter` (minimal YAML parser for name/description/triggers), `parseSkill`, `loadSkill`, `loadSkills`, `ensureSkillsDir`
- [x] `src/skills/match.ts`: `effectiveTriggers` (explicit triggers or skill name fallback), `skillMatches` (case-insensitive substring), `matchSkills`, `skillContext` (delimited system-prompt injection string)
- [x] `src/skills/install.ts`: `installFromGitHub` (`git clone --depth 1` → verify SKILL.md exists, cleanup on failure), `installFromUrl` (fetch raw file → save as `<id>/SKILL.md`), `removeSkill`, `listSkillIds`
- [x] `src/skills/index.ts`: barrel exports
- [x] `src/cli/index.ts`: `jaa skill list|install|remove` subcommands; `--no-skills` flag on both `ask` and `chat` to disable autotrigger; `ask` autotrigger injects matched skill context into the system prompt before the loop
- [x] `src/tui/app.tsx`: system-prompt seeding fix (Phase 5 bug — `systemPrompt` prop was never injected into the ChatApp's message state for new chats → now seeded via `initialMessages`, fixing `onTurnEnd` delta calculation for `--save`); skill autotrigger per user message — `matchSkills` checks the prompt, matched skill names shown as an info line, skill body injected as an additional system message before the user's message
- [x] tests → `tests/skills.test.ts` (23: frontmatter parsing incl. quotes/Windows-line-endings/unclosed/missing-name, parseSkill fallback, loadSkill/loadSkills with malformed/empty dirs, effectiveTriggers fallback, skillMatches case-insensitive, matchSkills multi-match/empty, skillContext delimiters/empty)
- [x] phase gate → lint ok, test 129/129 (12 files), build ok, `npm audit --audit-level=high` → 0 vulnerabilities, smoke `jaa skill list`/`jaa skill --help`/`jaa ask --help` (shows `--no-skills`) all green
  - [x] phase commit on `phase/6-skills` → `8f40eaa`

### Phase 7 — subagents + AGENTS.md project memory *(complete)*
- [x] `src/agents/types.ts`: `AgentSpec` interface (name, description, ownership, deps, acceptance, instructions) + `ParsedAgents`
- [x] `src/agents/parser.ts`: `parseAgents` (split on `## Subagents` heading, parse `###` subheadings with `- **Field**: value` bullets, handle multi-line continuation, Windows line endings, missing sections); `loadAgents` (read AGENTS.md from root), `findAgent`, `getAgentSpec`
- [x] `src/agents/runner.ts`: `buildAgentSystemPrompt` (combines project context + agent name + instructions + default jaa identity), `runSubagent` (loads agent spec, builds system prompt, creates fresh tool registry with bash gated off by default, runs loop)
- [x] `src/agents/index.ts`: barrel exports
- [x] `src/cli/index.ts`: `jaa agent list|show|run <name> [task]` subcommands; run supports `-p/--provider`, `-m/--model`, `--system`, `--max-turns`, `--token-budget`, `--temperature`, `--ctx`, `--no-tools`
- [x] `AGENTS.md` at repo root: project context (stack, conventions, security rules), 3 subagents (code-reviewer, test-writer, docs-updater) with ownership/deps/acceptance/instructions
- [x] `src/tui/app.tsx`: system-prompt seeding fix — `initialMessages` now seeds `props.systemPrompt` as first message for new chats (Phase 5 bug: system prompt prop was passed but never injected into TUI message state, causing `onTurnEnd` delta calculation to be off for `--save` sessions). Tests still pass since `linesFromMessages` doesn't render system messages.
- [x] tests → `tests/agents.test.ts` (15: frontmatter parsing incl. windows-line-endings/multi-line-instructions/unknown-fields/empty-sections/missing-section, loadAgents from filesystem, findAgent/getAgentSpec, system prompt construction)
- [x] phase gate → lint ok, test 144/144 (13 files), build ok, `npm audit --audit-level=high` → 0 vulnerabilities, smoke `jaa agent list`/`jaa agent show code-reviewer` all green
- [x] phase commit on `phase/7-subagents` → `69739e7`

### Phase 8 — MCP client/server + LSP diagnostics (protocol-correct) *(done)*
- [x] `src/mcp/framing.ts`: newline-delimited JSON framing (encode/decode/decodeFrames) for MCP stdio
- [x] `src/mcp/types.ts`: strict MCP types with optional fields (`MCP_PROTOCOL_VERSION = "2024-11-05"`)
- [x] `src/mcp/validation.ts`: `isRecord`, `isRequestId` boundary helpers
- [x] `src/mcp/server.ts`: `McpServer` with injectable streams, idempotent `run()`, JSON-RPC lifecycle (initialize/initialized state, `-32002` before init, `-32602` invalid params, `isError` on tool failures)
- [x] `src/mcp/client.ts`: `McpClient` with proper handshake (`notifications/initialized`), concurrent request correlation, timeouts, spawn/exit errors, idempotent disconnect
- [x] `src/mcp/jaa-server.ts`: routes MCP tools through `createDefaultRegistry()` with bash opt-in (`createJaaMcpServer(allowBash = false)`)
- [x] `src/lsp/framing.ts`: independent LSP `Content-Length` framing with extra-header support, duplicate/missing/oversize validation
- [x] `src/lsp/client.ts`: LSP client using LSP framing, document lifecycle, diagnostic-response validation, safe disconnect
- [x] `src/cli/index.ts`: `mcp serve --allow-bash`, repeatable `--mcp-server`, `--no-tools` guards, `lsp diagnose` uses `pathToFileURL`
- [x] tests → `tests/mcp.test.ts` (7: framing, split/coalesced/CRLF, incomplete trailing, server lifecycle, tool validation, error resilience) + `tests/lsp.test.ts` (5: Content-Length encode/decode, split/coalesced, extra headers, incomplete bodies, invalid lengths)
- [x] phase gate → lint ok, test 156/156 (15 files), build ok, `npm audit --audit-level=high` → 0 vulnerabilities
- [x] phase commit on `phase/8-mcp-lsp` → `cf1c8f9`

### Phase 9 — eval harness + seed tasks + npm packaging polish *(done)*
- [x] `src/eval/types.ts`: `EvalTask`/`EvalRun`/`EvalCheck` types; tasks carry checks, setup, and optional tool/turn/budget overrides
- [x] `src/eval/runner.ts`: `runEvalTask` runs the agent loop in a temp cwd, applies setup files, retries failing tasks, returns a structured `EvalRun`; `summarize` computes `pass@1` / `pass@N` and token totals
- [x] `src/eval/tasks.ts`: check helpers (`contains`, `notContains`, `toolCalled`, `fileExists`, `stopReasonIs`, `passesChecks`), `task` factory, and `loadTasks` for JSON task directories
- [x] `src/eval/seed/index.ts`: four seed tasks (`echo-ok`, `write-file`, `list-files`, `bash-gated`) exercising text checks, tool checks, and file checks
- [x] `src/eval/index.ts`: barrel exports
- [x] `src/cli/index.ts`: `jaa eval` command with `--provider`, `--model`, `--tasks`, `--retries`, `--json`; uses the default registry with bash gated off
- [x] `tests/eval.test.ts` (5): passing task, retries, seed-task ids, summarize math, tool/file checks
- [x] `package.json`: added `eval` script; `files` whitelist stays `dist`, `README.md`, `LICENSE`, `plan.md`
- [x] `README.md`: eval harness section + packaging section
- [x] `npm run pack:dry-run` → tarball contains only the four whitelisted entries (172 files, 102.4 kB)
- [x] phase gate → lint ok, test 161/161 (16 files), build ok, `npm audit --audit-level=high` → 0 vulnerabilities
- [x] phase commit on `phase/9-eval` → **pending**

## Compatibility and interop matrix

The single differentiator. jaa must adopt a repository that is already
configured for other harnesses, and be adoptable by teams already using jaa.

### Read (import) -- jaa consumes these on startup

| Source | Format | Consumed as | Notes |
|---|---|---|---|
| `AGENTS.md` (repo root) | Markdown | project memory + subagents | Universal standard. Codex, opencode, DeepSeek all read it. Already supported. |
| `~/.codex/AGENTS.md` | Markdown | global project memory | Codex global layer. Precedence below repo `AGENTS.md`. |
| `CLAUDE.md` | Markdown | project memory | Claude Code. Merged below `AGENTS.md` when both exist. |
| `CLAUDE.local.md` | Markdown | local project memory | Gitignored Claude override layer. |
| `GEMINI.md` | Markdown | project memory | Gemini CLI. |
| `.cursorrules` | Plain text | project memory | Legacy Cursor. |
| `.cursor/rules/*.mdc` | Markdown + frontmatter | project memory (per-glob) | Modern Cursor rules. Each file scoped to its glob. |
| `.windsurfrules` | Markdown | project memory | Windsurf. |
| `.github/copilot-instructions.md` | Markdown | project memory | GitHub Copilot. |
| `.claude/skills/*/SKILL.md` | Frontmatter + Markdown | skills | Identical format to jaa skills. Zero conversion. |
| `.claude/agents/*.md` | Frontmatter + Markdown | subagents | `name`, `description`, `tools`, `model` mapped. |
| `.claude/commands/*.md` | Markdown | skills | Flat command files map to skills. |
| `.claude/settings.json` | JSON | permission rules + hook hints | `permissions.allow` / `.deny` translated. |
| `.mcp.json` | JSON | MCP servers | Claude Code project-scoped MCP. `mcpServers` map to jaa clients. |
| `~/.codex/config.toml` | TOML | MCP servers + model defaults | Parse `[mcp_servers.*]`, `model`, `sandbox_mode`. |
| `~/.config/opencode/opencode.json` | JSON | MCP servers + plugins + instructions | `mcp`, `plugin`, `instructions` mapped. |
| `opencode.json` (project) | JSON | same, project layer | Merged below the global layer. |
| `.opencode/plugins/*.js` | JavaScript | *not executed* | Listed in `jaa doctor` as detected-but-unsupported. Never eval foreign code. |
| `pyproject.toml` / `package.json` | TOML / JSON | project-type detection + test command | Feeds `jaa doctor` and the benchmark runner. |

Precedence, highest first: `jaa` native `AGENTS.md` section > `AGENTS.md` >
`CLAUDE.md` > `GEMINI.md` > `.cursor/rules/*.mdc` > `.cursorrules` >
`.windsurfrules` > `.github/copilot-instructions.md`. Every source is
attributed in `jaa doctor` so the user can see exactly what was loaded and from
where. No source is ever silently rewritten.

### Write (export) -- jaa emits these

| Target | Command | Contents |
|---|---|---|
| `AGENTS.md` | `jaa compat sync` | Generated project memory: stack detection, conventions, build/test/lint commands, subagent index. Written only when the file is absent or `--force` is passed. Never clobbers hand-written prose. |
| `CLAUDE.md` | `jaa compat sync` | Pointer file to `AGENTS.md` plus a Claude-specific header, so Claude Code picks up jaa's context without duplication. |
| `.mcp.json` | `jaa compat sync` | Registers `jaa mcp serve` as an MCP server, so Claude Code can call jaa's tools. |
| `opencode.json` snippet | `jaa compat print opencode` | Printed to stdout, never written silently. |
| `config.toml` snippet | `jaa compat print codex` | `[mcp_servers.jaa]` table for Codex. Printed, never written silently. |
| `.jaa/config.json` | native | Canonical jaa settings. Source of truth. |

Hard rule: **jaa never writes to a file it did not create, except `AGENTS.md`
and `CLAUDE.md` with an explicit `--force`.** Every other export is stdout.

### Export surfaces -- other tools consume jaa

| Surface | Command | Consumed by |
|---|---|---|
| MCP stdio server | `jaa mcp serve` | Claude Code, Codex, opencode, DeepSeek, any MCP client |
| Headless JSON | `jaa ask -p "<q>" --json` | Scripts, CI, editor integrations |
| Codex-compatible JSON | `jaa exec --output json` | Drop-in for `codex exec --output json` consumers |
| Stream JSON | `jaa exec --output stream-json` | Live UIs; one JSON object per event |
| Exit codes | `jaa exec` | CI: `0` pass, `1` agent error, `2` permission denied, `3` budget exceeded |
| Skill directory | `~/.jaa/skills/` | Symlinked or copied by other harnesses (SKILL.md is a shared standard) |
| Subagent definitions | `jaa agent export` | Emits `.claude/agents/*.md` and `.codex/agents/*.toml` |

### The acceptance test for Phase 18

A repository containing all of `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
`.cursorrules`, `.cursor/rules/style.mdc`, `.mcp.json`, and a
`~/.codex/config.toml` with two MCP servers must, with zero jaa-specific
configuration:

1. `jaa doctor` report every detected source with its path and precedence rank.
2. `jaa ask` have all of the project memory in context.
3. `jaa ask` have both MCP servers' tools available.
4. `jaa compat sync` create `CLAUDE.md` and `.mcp.json` that make Claude Code
   able to call `jaa mcp serve`.
5. `jaa eval` run without configuration errors.

A test fixture repository encoding all of those files is a required Phase 18
deliverable, with a test per numbered assertion.

## Roadmap phase specs (10-20)

Each phase lists the gap it closes, concrete deliverables, the gate that must
pass, and what could regress. No phase is "done" until its gate output is
pasted into the verification record above.

---

### Phase 10 - Benchmark and parity harness

**Gap closed:** every other phase in this roadmap. Without it, "better than the
union of four harnesses" is an assertion. With it, it is a number.

**Why first:** it is the measuring stick for 11-20 and it reuses the Phase 9
eval harness rather than replacing it.

- [x] `src/bench/types.ts` - `BenchCase` (id, prompt, tags, checks, setup,
      budget, timeout), `BenchResult`, `HarnessAdapter`, 10 declared tags
- [x] `src/bench/checks.ts` - 20 check builders over transcript, work tree, and
      tool calls (`fileExists`, `fileContains`, `fileAbsent`,
      `fileLineCountAtLeast`, `finalContains`, `finalMatches`, `finalLacks`,
      `toolCalled`, `notToolCalled`, `toolCalledAtLeast`, `turnsAtMost`,
      `turnsAtLeast`, `touched`, `untouched`, `errored`, `noError`, `all`,
      `any`, `caseOf`)
- [x] `src/bench/cases.ts` - **46 cases** across all 10 tags, committed before
      any result is recorded. 22 of 46 (48%) are tool-agnostic, above the
      one-third floor, so the set cannot be tuned to flatter the tool layer
- [x] `src/bench/runner.ts` - throwaway case directory, setup application,
      before/after tree snapshot for `diffFiles`, hard per-case timeout that
      converts a hang into a recorded error rather than a crash, and `cwd`
      stripped from the result unless `keepWorkdir` is set
- [x] `src/bench/harnesses/jaa.ts` - in-process adapter driving the real agent
      loop with the default tool registry, bash gated off by default
- [x] `src/bench/harnesses/cli.ts` - generic external-CLI adapter with
      `{{prompt}}` / `{{cwd}}` / `{{model}}` templating, PATH availability
      probe, output-size caps, SIGTERM then SIGKILL escalation, tolerant JSON
      extraction, and a normalizer that maps each vendor's field names
      (`result` / `output` / `text` / `finalText`, `input_tokens` /
      `prompt_tokens`, ...). Presets for `claude`, `codex`, `opencode`, `dsh`
- [x] `src/bench/matrix.ts` - cross-product runner, incremental NDJSON append
      after every case, resume keyed on `caseId::harness::model`, tolerant of a
      truncated trailing line from an interrupted run
- [x] `src/bench/report.ts` - per-harness pass rate, median wall time, median
      turns, token and cost totals, per-tag breakdown, Markdown and JSON
- [x] `src/cli/index.ts` - `jaa bench --harness --provider --model --tags
      --timeout --out --report --list --json --allow-bash`
- [x] `tests/bench.test.ts` - 29 tests: every check builder, runner pass/fail/
      timeout/error/skip, diff capture, work-dir retention, matrix cross
      product, resume, NDJSON round-trip, truncated-line tolerance, report math,
      empty-report safety, case-set invariants (unique ids, all tags covered,
      tool-agnostic floor), external adapter availability, JSON parsing,
      malformed-output handling, and the real jaa adapter
- [ ] `docs/benchmarks/RESULTS.md` - the first published parity table.
      **Blocked on a reachable model.** No local Ollama instance was running and
      no provider key was supplied, so no honest pass rate exists yet. Run
      `jaa bench --harness jaa,codex,claude --out results.ndjson --report
      docs/benchmarks/RESULTS.md` on a machine with the binaries and a model
      before claiming any parity claim

**Gate result:** lint 0, 190/190 tests, build 0, audit 0. `jaa bench --list`
lists 46 cases across 10 tags. A live 7-case run completed with correct
per-case error capture and no crash, and resume added no duplicate rows.
**Parity numbers: not verified** — see the blocked item above.

---

### Phase 11 - Permission system

**Gap closed:** ranked #1 adoption blocker. One boolean becomes a real model.

**Competitor parity:** Codex 3 approval policies x 3 sandbox modes; Claude Code
allow/deny/ask/defer plus rule files; DeepSeek a monotonic deny guard layered
over allow/deny/ask.

- [x] `src/permissions/types.ts` - `Decision` (`allow`/`deny`/`ask`/`defer`),
      `Rule` (optional tool glob, command prefix, path glob, plus a `source` for
      attribution), `PermissionRequest`, `PermissionOutcome`, `GateOptions`
- [x] `src/permissions/rules.ts` - specificity ranking (exact tool > tool glob >
      command prefix > path glob > catch-all), glob compilation where `*` does
      not cross a separator and `**` does, case-insensitive tool matching,
      `normalizeRequestPath` so a rule sees the file the tool actually opens,
      `normalizeWhitespace` + shell-operator detection for command prefixes,
      `importClaudeSettings` mapping `Bash(cmd:*)` / `Read(glob)` / bare names
- [x] `src/permissions/engine.ts` - `createEngine` where **deny is absolute**,
      `resolveDecision` applying the mode baseline, and `createPermissionGate`
      wrapping a tool executor. Non-interactive `ask` becomes `deny`, never a hang
- [x] `src/permissions/ask.ts` - `SessionGrants` (exact match over *all*
      arguments), `sanitizeForDisplay` stripping ANSI/C0 so the consent prompt
      cannot be repainted by injected escapes, and `askOnTty` that keeps the
      readline interface open until the answer arrives
- [x] `src/config/settings.ts` - zod `permissions` block; a parse failure now
      warns and salvages each field independently so a bad `allow` cannot void a
      valid `deny`; zod default is a factory so the shared array cannot leak
- [x] installed on `jaa ask`, `jaa chat` (previously ungated entirely), and
      `jaa agent run`; subagents no longer inherit shell access just because
      tools are enabled
- [x] project `.claude/settings.json` detected and reported but **not applied**
      without `--trust-project-settings`, because it lives in an untrusted
      checkout
- [x] `src/doctor.ts` - `permissions` check reporting mode, rule counts, whether
      bash is reachable, and project-policy provenance
- [x] `src/cli/index.ts` - `jaa perm list|test`, `--permission-mode` on
      `ask`/`chat`/`agent run`, `--allow-bash` and `--no-tools` on `agent run`
- [x] `tests/permissions.test.ts` (55): specificity ordering, matching, engine
      precedence, absolute deny, mode baselines, Claude import, the gate, and one
      regression test per exploit found in review (shell chaining, whitespace
      and case evasion, `./`/`../`/absolute path bypass, `full-auto` bash,
      unknown-tool allow, dead config warning, per-field salvage, grant scope)

**Gate result:** lint 0, 268/268 tests (18 files, +55), build 0, audit 0.
`jaa perm list` and `jaa perm test` verified end to end, including the exact
exploits from two security review rounds, each now returning `ask` or `deny`
where they previously returned `allow`.

**Deliberately out of scope for Phase 11:** the MCP server, `jaa eval`, and the
bench harness still call their registries directly. All three have
`allowBash` off by default, so they cannot reach a shell, but a `deny` rule does
not currently apply to them. Gating them is Phase 13 work alongside hooks,
where a shared `ToolContext` carries the resolved policy.

---

### Phase 12 - OS-level sandbox

**Gap closed:** ranked #2 trust blocker. Path validation is not containment.

**Competitor parity:** Codex Landlock + seccomp on Linux, Seatbelt on macOS;
Claude Code Seatbelt and bubblewrap; opencode Docker. jaa targets all three
desktop platforms with no Docker requirement.

**Status: implemented on macOS and Linux. Not available on Windows, and jaa
says so rather than pretending.** Two of the three planned modules were
deliberately not built, and the plan was corrected rather than the claim
softened:

- Landlock/seccomp (`src/sandbox/linux.ts`) -- not built. Landlock needs a
  compiled helper binary that jaa does not ship, and seccomp needs a native
  addon. bubblewrap covers the same filesystem/network/PID guarantees without a
  build step, so the phase targets it instead. `wrapCommand` now **refuses** a
  `landlock` request rather than silently substituting bubblewrap and discarding
  the rules.
- Win32 Job Objects plus an ACL guard (`src/sandbox/win32.ts`) -- not built.
  Job Objects need a native Node binding, which would make jaa un-installable
  without a toolchain. No Windows sandbox exists, and every entry point that can
  run a command has a `--no-sandbox` opt-out that states what is given up.

- [x] `src/sandbox/types.ts` - `SandboxPolicy` (writable roots, readable roots,
      network, env passthrough, enforcement), platform capability probe
- [x] `src/sandbox/generate.ts` - Seatbelt profile and bubblewrap argv from one
      policy, plus the policy validator that refuses over-broad or
      self-contradictory roots
- [x] `src/sandbox/detect.ts` - probes what the host actually supports by
      running the **real** generated profile, caches per platform, and reports
      only the guarantees it verified
- [x] `src/sandbox/apply.ts` - wraps `runProcess`; a tool that cannot be
      sandboxed declares so, and `require` refuses rather than running wide
- [x] `src/tools/bash.ts` and `src/tools/git.ts` route through the sandbox
- [x] `src/tools/git.ts` - the git argv is itself a code-execution surface and is
      hardened: `-c core.fsmonitor=false`, `--no-ext-diff --no-textconv` on the
      diff-producing subcommands only, and `git_diff` is treated as code
- [x] `src/cli/index.ts` - `--no-sandbox` and `--allow-network` on `ask`, `chat`
      and `agent run`, so an operator can always choose knowingly
- [x] `src/doctor.ts` - names the active mechanism and its guarantees, and
      reports the permission decision the gate would actually reach
- [x] `tests/sandbox.test.ts` - policy generation per platform, mount-shadowing
      and env-leak regressions, fail-closed behaviour, and live exploit controls
- [x] `tests/tools.test.ts` - every git tool exercised against a real repository,
      plus `core.fsmonitor` and diff-driver execution controls

**Gate (macOS/Linux) -- NOT YET RUN. This is the single most important thing left
unverified in this phase.** The macOS/Linux runtime gate is: a command that
writes outside the declared roots fails, and a network call under
`network: false` fails. This host is Windows, so neither was executed. What *was*
verified here is the pure logic: policy validation, argument construction, mount
ordering, env handling, the fail-closed path, the live git exploit controls, and
that `doctor` reports the truth. Argument generation being correct is not the
same as confinement working, and this plan does not claim it is.

**Gate (this host, Windows) -- run and passing:** `npm run lint` 0 errors;
321/321 tests across 19 files; `npm run build` clean; `npm audit
--audit-level=high` 0 vulnerabilities. `jaa doctor` reports the sandbox
unavailable with the reason, and `bash` refuses under `require`.

**Two independent security reviews were run and their findings fixed**, not
waived. The first found a repository-local `git diff` command-driver RCE and a
capability probe that reported failing binaries as available. The second found
the same RCE class still open through `core.fsmonitor` -- which also worked on a
*sandboxed* host, defeating the mitigation -- plus a `git status` that was
entirely broken by over-broad hardening flags, a `bwrap` profile that failed on
every Linux command while `doctor` reported it working, an environment
passthrough that inherited every API key, an operator `allow` that could never
win, and a permissions line in `doctor` that contradicted `perm test`.

**Risk:** platform sandboxing is the single most failure-prone area in this
roadmap. Mitigation: the capability probe runs the real generated profile rather
than a hand-written stand-in, the probe result is memoised, a policy that would
grant the whole filesystem is refused, and an unavailable primitive downgrades
to an explicit refusal or a visible warning rather than a lie.

#### Open gaps carried out of Phase 12

These are real and unresolved. None is closed by the fact that the code landed.

- [ ] **G1 -- No sandbox on Windows.** `bash` refuses unless `--no-sandbox` is
      passed, which runs it unisolated. Job Objects need a native Node binding
      that would make `jaa` un-installable without a build toolchain. Options,
      none chosen: ship a prebuilt optional native addon; shell out to WSL; or
      document container/VM as the Windows answer. **Owner decision required**,
      because each option changes the install story.
- [ ] **G2 -- macOS/Linux runtime gate never executed.** Needs one run of the
      Phase 12 gate on a real macOS host and one on a real Linux host. Until then
      the sandbox is *believed* to confine, with correct argv and a fail-closed
      path, but confinement itself is unproven. Highest-priority gap: every other
      item here is a narrowing of a working boundary, whereas this one is the
      boundary.
- [ ] **G3 -- Linux env passthrough values are visible in child argv.**
      `--setenv NAME value` puts the value in the `bwrap` command line, so a
      process listing by the same user can read it. `--clearenv` is in place, so
      the *set* of variables is correct; only the visibility of the values is
      wrong. Fixing it needs a different transport (inherit-then-clear in a
      wrapper, or an fd-based handoff), not a flag change.
- [ ] **G4 -- macOS Seatbelt system-read list unvalidated on real hardware.**
      `/etc` and `/private/etc` are absent from `SYSTEM_READ_PATHS`. On macOS
      `/etc` is a symlink into `/private/etc`, and if the SBPL `subpath` filter
      does not canonicalise, every process opening `/etc/...` is denied -- which
      would break large parts of the toolchain. Cannot be tested without a Mac.
      Also note `SYSTEM_READ_PATHS` and the Linux `SYSTEM_ROOTS` are two separate
      lists, so the two platforms grant different trees and can drift.
- [ ] **G5 -- `core.fsmonitor=false` and `--no-ext-diff` are a deny-list.**
      They close the two git code-execution routes that are known today. A git
      config key nobody has thought of would reopen the class, which is why
      `git_diff` is gated like `bash` and why `doctor` says "hardened but
      unisolated" rather than "sandboxed". Only a true sandbox with no
      attacker-writable `.git` removes the need for the deny-list.

**Also carried forward:** the `git` tools are `best-effort` by design, so on
Windows they run unisolated *today*, mitigated only by G5's deny-list. That is a
known, accepted, and documented exposure, not an oversight.

---

### Phase 13 - Hooks

**Gap closed:** ranked #3 team-usability blocker. All four competitors have
hooks; jaa has none.

**Competitor parity:** Claude Code 10 events, Codex 9, Grok 12, opencode 7.
jaa targets the Claude Code event vocabulary for drop-in familiarity.

- [ ] `src/hooks/events.ts` - the event union: `SessionStart`,
      `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
      `PostToolBatch`, `PermissionRequest`, `Notification`, `SubagentStart`,
      `SubagentStop`, `Stop`, `StopFailure`, `PreCompact`, `PostCompact`,
      `SessionEnd`, `ConfigChange`
- [ ] `src/hooks/types.ts` - `HookHandler` discriminated by kind, `HookEvent`
      payload mirroring the Claude Code JSON shape, `HookDecision`
- [ ] `src/hooks/load.ts` - read `hooks` from `jaa` config, `AGENTS.md`
      frontmatter, `.claude/settings.json`, and plugin manifests; later layers
      merge, never replace
- [ ] `src/hooks/run.ts` - dispatch to `command` (stdin JSON, parse stdout),
      `http` (POST the payload), `prompt` (inject into context),
      `mcp` (call a server tool), `agent` (spawn a subagent for a verdict)
- [ ] `src/hooks/decide.ts` - `PreToolUse` and `PermissionRequest` may return
      allow / deny / ask, may rewrite tool arguments via `updatedInput`, and
      `PostToolUse` may rewrite the result. A handler that crashes or times out
      must resolve to the safe default (deny for pre-use, passthrough for
      post-use), never to allow
- [ ] Timeout and output caps per handler; stdout clamped like any tool result
- [ ] `src/cli/index.ts` - `jaa hooks list|test <event>`; `test` runs a
      synthetic payload through the chain and prints the decision trace
- [ ] `tests/hooks.test.ts` - every event, every handler kind, deny/ask/allow
      decisions, argument rewrite, crash-to-deny, timeout-to-deny, layer merge

**Gate:** a `PreToolUse` hook can block a tool call. A `PostToolUse` hook can
rewrite a result. A crashing hook denies rather than allows. Imported Claude
Code `PreToolUse` deny rules fire.

**Risk:** arbitrary command execution from config is a security surface. Phase
11 gates it, Phase 12 contains it, and project-level hooks require the same
workspace-trust prompt Claude Code uses.

---

### Phase 14 - Checkpoint, rewind and fork

**Gap closed:** ranked #5. No safe experimentation without rewind.

**Competitor parity:** Claude Code snapshots before every edit, `Esc Esc` and
`/rewind` restore code and conversation; Codex forks threads and isolates in
worktrees; opencode uses git write-tree snapshots.

- [ ] `src/checkpoint/store.ts` - content-addressed snapshots of every file the
      agent writes, stored under `~/.jaa/checkpoints/<session>/`, deduplicated
      by hash so an unchanged file costs nothing
- [ ] `src/checkpoint/create.ts` - snapshot before each mutating tool call,
      tagged with turn index and tool-call id
- [ ] `src/checkpoint/restore.ts` - restore code to any turn, restore
      conversation to any turn, or both. Writes go through the same
      `confinePath` and the same Phase 11 permission decision as any other write
- [ ] `src/checkpoint/fork.ts` - branch a session from any turn into a new
      session id, sharing nothing mutable
- [ ] Undo of a checkpoint never touches files the agent did not write; Bash
      side effects are explicitly out of scope and documented as such, exactly
      as Claude Code documents it
- [ ] `src/cli/index.ts` - `jaa rewind [turn]`, `jaa fork <id> [turn]`
- [ ] `src/tui/app.tsx` - `Esc Esc` binding, a `/rewind` picker showing the
      turn list with a one-line summary per turn
- [ ] `tests/checkpoint.test.ts` - create/restore round-trip, dedup, traversal
      refusal, fork isolation, and a test proving restore cannot escape the root

**Gate:** `Esc Esc` restores the working tree to a prior turn exactly. Forked
sessions do not share mutable state. Restore of a path outside the root is
refused.

**Risk:** disk growth. Mitigation: hash dedup plus a configurable retention
window, pruned on session close.

---

### Phase 15 - Multi-agent orchestration

**Gap closed:** ranked #4. `jaa agent run` becomes a real orchestrator.

**Competitor parity:** Claude Code subagents + agent view + agent teams +
dynamic workflows + `/batch` worktree fan-out; Codex `max_threads: 6`,
`max_depth`, `spawn_agents_on_csv`, worktree isolation, auto-review; DeepSeek
subagents + workflows + background jobs.

- [x] `src/orchestrator/task.ts` - `Task` (id, prompt, agent, status, result,
      parent, children, depth, isolation), a persisted task board under
      `~/.jaa/tasks/`. One file per task, not one board file: a run is a tree
      written from many places at once, so a single document would make every
      writer race for one read-modify-write and a crash would destroy every other
      task's state. `descendantsOf` walks `children` (a parent may record a child
      before the child's file exists); `ancestorsOf` walks `parent`; both are
      cycle-safe because a hand-edited board can contain one
- [x] `src/orchestrator/inject.ts` - subagent report injection scan. Control
      characters stripped, instruction-shaped spans replaced with
      `INJECTION_MARKER`, whole report framed as untrusted data. Matches a
      tight phrase list rather than a broad one, so it does not fire on the
      security documentation this repo is full of — a filter that mangles honest
      output gets switched off
- [x] `src/orchestrator/isolation.ts` - git worktree per worker, on its own
      `jaa/<task-id>` branch so a fan-out is mergeable. A failure is a **typed
      refusal**, never a fallback: if worktree creation fails the task is recorded
      `failed` and no worker starts, because a silent continue would put N workers
      on one checkout and corrupt it
- [x] `src/orchestrator/pool.ts` - bounded concurrency. `maxThreads` 6,
      `maxDepth` 1, `maxTasks` 32, clamped to a hard ceiling of 32/4/256. The
      semaphore is held for a worker's execution only and released before
      delegation, because holding it across children deadlocks every parent on a
      permit a child needs. **`effectiveToolNames` is an intersection, never a
      union**, and it is the only path from a declaration to a worker's registry
- [x] `src/agents/types.ts` + `parser.ts` + `runner.ts` - declaration upgrades:
      `model`, `tools`, `disallowedTools`, `skills`, `maxTurns`, `isolation`,
      `background`. Every one only narrows. Values that cannot mean what they
      claim (`MaxTurns: many`, `Isolation: docker`) are **dropped rather than
      clamped**, so a typo leaves the caller's default instead of a cap of 0
- [x] `src/orchestrator/team.ts` - peer-to-peer messaging and a shared board.
      `TeamChannel.send` scans the body, because a forwarded message is the same
      attack as a report: worker A reads a poisoned README and posts a shell
      command to worker B, who is mid-task with tools in hand
- [x] `src/orchestrator/fanout.ts` - CSV and JSONL batch fan-out, one worker per
      row, merged back. A hand-rolled CSV reader that honours quoted fields,
      because `String.split(",")` silently corrupts any row containing a quoted
      comma. Requires `--fanout`
- [x] `src/orchestrator/review.ts` - independent reviewer pass. Independence is
      structural, not a matter of prompting: a different model by default, the
      worker's own conclusion field withheld, and the reviewer gets no tools. A
      crashed reviewer is `rejected`, never a silent pass
- [x] `src/orchestrator/background.ts` - detached workers via `spawn` with
      `detached: true` and `stdio: "ignore"`, unref'd. Not a real `fork()`: that
      needs a native addon on Windows, the same reason Phase 12 declined Job
      Objects. Stop is **cooperative and observable**, not a signal — the parent
      holds no handle, so `requestStop` marks the board and the child polls
- [x] `src/cli/index.ts` - `jaa tasks list|show|attach|stop|clear`; `--alongside`,
      `--max-threads`, `--max-depth`, `--isolation`, `--keep-worktrees` on
      `agent run`. The parallel path routes through the pool rather than a second
      copy of the action, so permissions, hooks and sandboxing cannot drift apart
      between the single-agent and multi-agent paths
- [x] `src/doctor.ts` - an `orchestrator` check reporting the effective limits,
      the hard ceiling, and whether worktree isolation is available. A host that
      cannot isolate is a `warn`, because a fan-out without worktrees has
      concurrent writers on one checkout
- [x] `tests/orchestrator.test.ts` - 94 tests: the board, the tree walks, the
      scan, the escalation invariant, the limits, the pool, real worktrees, the
      team channel, fan-out, the reviewer, background, and declaration parsing

**Gate result:** lint 0, **851/851 tests across 29 files** (+94, 0
regressions), build 0, audit 0. All four gate assertions pass and are named
tests:

1. *Three agents edit three overlapping files with zero conflicts* — three real
   git worktrees, interleaved writes, each file holding exactly one writer's
   content end to end and the original checkout untouched.
2. *Depth and thread caps hold under a deliberate fan-out bomb* — 3 roots each
   delegating 25 children, peak concurrency ≤ `maxThreads`, and the refused
   delegation is recorded on the task rather than silently dropped.
3. *A subagent cannot escalate its own permissions* — asserted against a
   hand-edited `AGENTS.md` asking for `deploy_production` and `disable_sandbox`;
   neither appears, and the effective set is a subset of the parent's at every
   depth.
4. *Injected instructions in a subagent report are neutralized* — five canonical
   overrides including whitespace and control-character evasion, plus role
   reassignment, concealment, forged conversation structure and credential
   exfiltration. Four benign security sentences are asserted **not** to fire.

**Two real bugs were found and fixed by the tests rather than by review:**
`parseVerdict("this is not approved")` returned `approved`, because a substring
matcher reads the token `approved` out of a negation — the worst possible
direction for one, since a reviewer saying "no" was being recorded as a pass. And
the first pool implementation awaited roots and children sequentially, which
silently serialised the entire fan-out and made `maxThreads` meaningless; a test
asserting peak concurrency > 1 now guards it.

#### Known limits carried out of Phase 15

- [ ] **L1 -- The injection scan is a mitigation, not a proof.** It removes the
      literal instruction text, so an exact-match defence fails, but it cannot
      remove every paraphrase and it cannot distinguish a hostile instruction
      from an honest one that looks like one. The honest control is the worker's
      tool set, not a text filter at the end; the scan is defence in depth.
- [ ] **L2 -- `TeamChannel.claim` is compare-and-set, not a lock.** The window
      between the board read and the write is real, so two workers racing for the
      same task can both think they won. What the check buys is that a claim is
      *visible*, so a loser retries and finds the task taken. A losing claim
      still needs the work done twice or abandoned.
- [ ] **L3 -- Background stop is cooperative.** A child inside a long provider
      call finishes that call first, so `requestStop` is not immediate and
      returns whether the request was recorded, not whether the worker stopped.
      `isStale` reports a worker that has stopped making progress. A real kill
      would need the pid to be meaningful across a reboot, which is not
      guaranteed for a detached process.

---

### Phase 16 - Compaction and persistent memory

**Gap closed:** the current `trimToBudget` silently drops context. Competitors
summarize.

**Competitor parity:** Claude Code compacts around 95% and re-reads project
memory from disk afterward so it survives; opencode near 90%; Codex uses
model-native compaction.

- [x] `src/agent/compact.ts` - summarization compaction at a configurable
      threshold (default 90%), using **the same provider adapter and model as the
      loop** so it works on every provider including local ones. The summariser
      is never given tools, and an oversized transcript is summarised in halves
      and merged rather than sent in one request — which is what every provider
      with a window smaller than the conversation would refuse
- [x] Preserved verbatim across compaction: every `system` message (the jaa
      identity, project memory, preloaded skills), any pinned 1-based message
      position, and the newest `keepRecent` chunks. Only the unpinned middle is
      summarised, and a pinned message is not even handed to the summariser, so
      it cannot be lost to summarisation
- [x] `src/agent/memory.ts` - auto-memory. `JAA-MEMORY.md` in the project root,
      delimited by explicit `start`/`end` markers so hand-written prose below the
      notes survives. 16 kB cap, oldest evicted first, measured against the whole
      file. **Untrusted on read**: a note that reads like an injection stays on
      disk and is withheld from the system prompt
- [x] `src/tools/memory.ts` - the `remember` tool, so the agent can write its own
      memory. In `MUTATING_TOOLS` (it writes a file) but deliberately **not** in
      `NEVER_IMPLICITLY_ALLOWED`, so a permission mode can allow it. Declares no
      `path`, so Phase 14 takes no snapshot — the file is checked in, so `git`
      restores it
- [x] Compaction is observable: `jaa ask` prints `[compacted] N → M tokens`, the
      TUI writes a `~ context compacted` line into the transcript, and the summary
      itself carries `[compacted]` so the model is told it is reading a record
- [x] `src/cli/index.ts` - `jaa compact [session] [--focus] [--yes]`;
      `jaa memory list|add|edit|clear`; `--no-memory`, `--no-compact`,
      `--compact-threshold`, `--compact-keep` on `ask`
- [x] `src/agent/loop.ts` - compaction wired **on the request, never on
      `history`**, and **before** `trimToBudget`. Omitted entirely when not
      configured, so the pre-Phase-16 path is unchanged
- [x] `src/agent/budget.ts` - `chunkMessages` exported, so compaction and
      trimming share one definition of which messages may not be separated
- [x] `tests/compaction.test.ts` - 49 tests: the summary and its fallbacks, each
      preserved item individually, the tool-call-pairing invariant across a
      compaction, pinning, the summariser's no-tools contract, the split-and-merge
      path, the local-model (no `stream`) path, the loop's turn-index contract, and
      memory persistence, scoping, the cap, the scan and the tool

**Gate result:** lint 0, **900/900 tests across 30 files** (+49, 0
regressions), build 0, audit 0. Both gate assertions pass as named tests:

1. *A session past the threshold retains the system prompt, project memory and
   pinned content, and the token count drops* — asserted end-to-end through
   `runAgentLoop`, checking the messages the provider actually received rather
   than the return value of the compaction function alone.
2. *Auto-memory survives a process restart* — a "restart" is a fresh read with no
   in-process state carried over, and it is asserted per project so one repo's
   notes cannot reach another.

#### Known limits carried out of Phase 16

- [ ] **L4 — The saved session file keeps growing.** Compaction bounds the cost
      of every provider call, which is what breaks, but it deliberately does not
      rewrite the transcript, because doing so would invalidate Phase 14's
      checkpoint positions. Reclaiming the space is `jaa compact`, which the
      operator runs on purpose. A session left alone grows without bound.
- [ ] **L5 — The memory cap evicts silently to the caller.** The tool result tells
      the model how many notes were dropped, and `jaa memory add` prints it, but
      nothing is appended to the file itself. A note evicted between two reads is
      invisible to anyone who does not happen to run the tool.

---

### Phase 17 - Live code intelligence

**Gap closed:** ranked #8. `jaa lsp diagnose` is a manual one-shot command;
competitors feed real diagnostics into the loop.

**Competitor parity:** opencode ships 30+ auto-installing LSP configurations and
queries the server after every edit, feeding results into model context.

- [x] `src/utils/spawn.ts` - **Phase 17 had no client without this.** On Windows
      `spawn("typescript-language-server")` is `ENOENT` and spawning the `.cmd`
      is `EINVAL`, because npm installs a shim and Node will not run a batch file
      without a shell. Measured, and `cmd /c` is the wrong answer: with each
      argument quoted, `&`, `|` and `>` still break out, and `%PATH%` **expands**.
      So this locates the shim, reads the standard npm format out of it, and
      spawns `process.execPath` with the script — no shell, and every argument
      stays an argv element
- [x] `src/lsp/registry.ts` - 6 built-in servers (TypeScript, Python, Rust, Go,
      C/C++, Java) as data, in opencode's `lsp` config shape. Detection is by
      project marker *or* extension, and a server is only offered when the project
      actually contains that language — `pyright` being on PATH does not make a
      TypeScript repo a Python one. `node_modules`, `target`, `.venv` and friends
      are skipped, and the walk is bounded
- [x] `src/lsp/client.ts` - Phase 8's one-shot client made long-lived. Document
      sync (`didOpen`/`didChange`/`didSave`), definition, references, hover,
      document and workspace symbols, a configurable per-request timeout, and
      server→client requests answered with `MethodNotFound` rather than ignored
      (a server waiting on a reply is a server that hangs)
- [x] **Both diagnostic models.** `typescript-language-server` answers
      `textDocument/diagnostic` with "Unhandled method" — it is push-only — so a
      client that only spoke pull produced an error and nothing else. Pull is used
      when a server advertises `diagnosticProvider`; otherwise a bounded wait on
      `textDocument/publishDiagnostics`
- [x] `src/lsp/manager.ts` - one session per (project, language), started on
      demand. A crashed server is restarted **once** and then disabled for the
      session, because a server that dies again after a clean restart is
      misconfigured and retrying it per turn costs a process launch per turn
- [x] `src/lsp/loop.ts` - after a mutating tool call, ask the server what it
      thinks of the file and append the answer to the tool result. The model never
      asks. Bounded, and every failure path is silent: a broken type checker must
      not fail a write that already succeeded
- [x] `src/tools/lsp.ts` - `lsp_diagnostics`, `lsp_definition`,
      `lsp_references`, `lsp_hover`. Results are rendered as workspace-relative
      `path:line` rather than `file:///…`, which is the form both the model and a
      human can use
- [x] `src/cli/index.ts` - `--lsp` on `ask` (off by default), `jaa lsp list`;
      servers are shut down at the end of a run
- [x] `src/doctor.ts` - an `lsp` check that separates "no language here" from
      "server installed but this project is not that language" from "server
      installed but has nothing to drive"
- [x] `tests/lsp-loop.test.ts` - 31 tests, including one that runs against the
      **real** `typescript-language-server` on this repository and asserts both a
      real type error is reported and a clean file reports nothing. It skips where
      no server is installed, because a machine without one is a supported
      configuration

**Gate result:** lint 0, **931/931 tests across 31 files** (+31, 0
regressions from 900/900 across 30), build 0, audit 0, `check:secrets` clean
(188 files). Both gate assertions pass:

1. *Editing a file with a type error surfaces it to the agent on the next turn
   without the model being asked* — wired in `ask`, and the diagnostics ride on
   the tool result rather than becoming a message (a provider requires a tool
   result to immediately follow its assistant message, and an inserted message
   would shift every later position and break the Phase 14 turn index).
2. *A crashing language server is restarted once and then ignored, never fatal* —
   asserted with a server that exits immediately, called twice.

**Four real defects were found by running against the real server, none of which
any unit test would have caught.** Each is a case where the code looked correct:

1. **Nothing could be spawned on Windows at all.** `spawn` of an npm shim is
   `ENOENT`/`EINVAL`. Phase 8's `lsp diagnose` could therefore never have worked
   on this platform.
2. **`textDocument/publishDiagnostics` is gated on a client capability the LSP
   spec does not define.** Read out of the server's own source
   (`features.diagnosticsSupport = Boolean(capabilities.textDocument.publishDiagnostics)`,
   and `FileDiagnostics.publishDiagnostics()` returns early when it is false): a
   client that omits the key gets a server that handshakes correctly and then
   never sends a single diagnostic, silently.
3. **Notifications were read from `result` instead of `params`**, so every push
   arrived with an undefined payload and was discarded.
4. **The server publishes a URI jaa never sent.** Client: `file:///C:/…`. Server:
   `file:///c%3A/…` — lowercased drive, percent-encoded colon, because it
   round-tripped the URI through a URL parser. Keyed on the raw string, every
   publish landed under a key no lookup ever asked for.

Plus one platform finding worth recording on its own: **TypeScript 7 ships no
`tsserver` at all** — the Go port removed it — so `typescript-language-server`
cannot use a `typescript@7` project. jaa resolves a `tsserver` separately from
the server's command and reports the two failures separately, and the repository
carries an aliased `typescript5@npm:typescript@5.9.3` purely to have something to
drive. The project's own `typescript@^7.0.2` type gate is untouched.

#### Known limits carried out of Phase 17

- [x] **L6 (corrected) — Diagnostics *were* being persisted; the claim was
      wrong.** The original draft said the loop "diagnoses without mutating the
      transcript, so `jaa session show` still shows the agent's claim rather than
      the compiler's". That is not what happens. `withDiagnostics` writes its
      verdict into the `write_file` result, that result is in `result.messages`,
      and the persisted delta is a slice of that same array — so
      `tests/lsp-servers.test.ts` drives the full loop, saves, reloads, and
      asserts the compiler's sentence is still there beside the agent's "done".
      The wrapper is now `withDiagnostics()` in `src/lsp/loop.ts` instead of an
      inline block in the CLI, and it is covered rather than asserted. Recorded
      because a limit that is not real is worse than no limit: it would have
      been used to justify not building the thing.
- [x] **L7 (closed) — `java` is now proven like the rest.** JDT LS *was*
      installed here after all (`D:\tools\jdtls`, JDK 26 and Adoptium 21), so the
      earlier "no JDT LS on this host" was wrong. Closing it took three real bugs,
      each of which had made Java look clean rather than broken:
      1. the `jdtls` on `PATH` is a batch file wrapping a Python script and
         ending in `pause` — no process can be spawned as it, so the config
         passed detection and then failed at the moment of use. `src/lsp/
         java-launcher.ts` now reads the Eclipse layout off that path and builds
         the `java -jar org.eclipse.equinox.launcher_*.jar` line itself, with a
         per-process `-data` workspace that `close()` removes.
      2. JDT LS **blocks on `workspace/configuration`** during startup and needs
         a real array of settings back, not `MethodNotFound`. The client
         answered `MethodNotFound` to every server request, so the server sat at
         "0% Starting Java Language Server" indefinitely and every Java file came
         back clean. The client now answers the requests it can answer
         meaningfully and falls back to `MethodNotFound` for the rest.
      3. JDT LS reports nothing for a file outside its source roots, which also
         looks exactly like a clean file. Source roots are sent in
         `initializationOptions`.

      Verified with a broken and a clean control file, like every other entry.
- [ ] **L8 — `@ast-grep/napi` was installed, verified and removed.** It works
      (it parses this repository and extracts `runAgentLoop`, `drive`,
      `createCheckpointRecorder` … structurally), but the language server already
      provides definition, references, hover and symbols *semantically*, and
      detection-by-parsing turned out to need extension scanning plus a project
      marker, which is simpler and has no native dependency. Shipping an unused
      native module in a package that must install with no toolchain is a net
      negative, so it is not a dependency. Recorded because "we tried the obvious
      tool and it was redundant" is a result.


---

### Phase 18 - Compatibility and interop layer

**Gap closed:** the thesis. Full specification is the compatibility matrix
section above; this phase is the implementation of it.

- [ ] `src/compat/detect.ts` - probe every source in the read matrix, record
      path, mtime, size, and precedence rank
- [ ] `src/compat/memory.ts` - merge `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`,
      `.cursorrules`, `.cursor/rules/*.mdc`, `.windsurfrules`, and
      `.github/copilot-instructions.md` into one attributed project-memory
      block. No silent rewrite; `jaa doctor` prints the full attribution table
- [ ] `src/compat/claude.ts` - `.claude/settings.json` permission rules and
      hook entries; `.claude/agents/*.md` and `.claude/commands/*.md`
- [ ] `src/compat/codex.ts` - minimal TOML reader for `[mcp_servers.*]`,
      `model`, `sandbox_mode` from `~/.codex/config.toml`. A focused parser, not
      a general TOML dependency, unless the gate proves that wrong
- [ ] `src/compat/opencode.ts` - `mcp`, `plugin`, `instructions`,
      `permission`, and `agent` from `opencode.json` at both project and global
      scope. Plugin *files* are listed, never executed
- [ ] `src/compat/mcpjson.ts` - Claude Code `.mcp.json` -> jaa MCP clients
- [ ] `src/compat/sync.ts` - `jaa compat sync`: generate `AGENTS.md` (guarded),
      `CLAUDE.md`, and `.mcp.json`. Refuses to overwrite hand-written content
      without `--force`, and writes a `.jaa/compat-manifest.json` recording what
      it generated so a later sync can update rather than duplicate
- [ ] `src/compat/print.ts` - `jaa compat print <codex|opencode|claude|all>`
      emits ready-to-paste config to stdout
- [ ] `src/compat/export.ts` - `jaa exec --output json|stream-json`, exit codes
      `0/1/2/3`, and `jaa agent export` to `.claude/agents/*.md` and
      `.codex/agents/*.toml`
- [ ] `tests/fixtures/multi-harness-repo/` - a fixture repository containing
      every read-matrix file
- [ ] `tests/compat.test.ts` - one test per numbered acceptance assertion in
      the matrix, plus precedence-order tests and a no-clobber test

**Gate:** the five acceptance assertions in the matrix section all pass against
the fixture repository with zero jaa-specific configuration.

**Risk:** precedence surprises. A user may expect `CLAUDE.md` to win because
that is their daily driver. Mitigation: precedence is documented, printed by
`jaa doctor`, and overridable with an explicit `jaa` config key.

---

### Phase 19 - Plugin system and registry

**Gap closed:** ranked #7. Skills and subagents cannot currently be bundled and
distributed as one unit.

**Competitor parity:** Claude Code plugin manifests bundling skills, agents,
hooks, MCP servers, LSP servers, output styles, themes, and `bin`; Codex
marketplace with 90+ first-party plugins; DeepSeek's everything-is-a-plugin
Cordis model; opencode's `plugin` array.

- [ ] `src/plugins/manifest.ts` - `jaa-plugin.json` schema: `name`, `version`,
      `description`, `author`, `homepage`, `repository`, `license`, and
      component paths for `skills`, `agents`, `hooks`, `mcpServers`,
      `lspServers`, `themes`, `bin`. Read `.claude-plugin/plugin.json` too, so
      Claude Code plugins install directly
- [ ] `src/plugins/install.ts` - install from a local path, a git URL, or an
      npm tarball; verify the manifest before writing; atomic install with
      rollback on failure
- [ ] `src/plugins/load.ts` - layered load: global then project, later layers
      merge by name. Namespaced agent and skill ids (`plugin-name:skill-name`)
      so two plugins cannot collide
- [ ] `src/plugins/registry.ts` - discovery, search, install, remove, enable,
      disable, update. Local and remote catalogs
- [ ] `src/plugins/bin.ts` - plugin-provided executables added to the Bash
      tool's `PATH` for the session only, never to the user's shell profile
- [ ] Security: plugin code is executable. Plugin-provided tools, hooks, and
      agents are subject to the Phase 11 permission engine and the Phase 12
      sandbox. A plugin cannot widen permissions. Installing a plugin from an
      untrusted source prints exactly what it will execute and requires
      confirmation
- [ ] `src/cli/index.ts` - `jaa plugin list|search|install|remove|enable|
      disable|update|inspect`
- [ ] `tests/plugins.test.ts` - manifest validation, layered merge, namespacing,
      install rollback, PATH scoping, and a test proving a plugin cannot escalate
      permissions

**Gate:** a Claude Code plugin with skills, agents, and an MCP server installs
into jaa and all three components work. Two plugins with colliding skill names
coexist. A plugin cannot grant itself a permission the session does not have.

**Risk:** this is the largest new attack surface in the roadmap. Mitigation:
Phase 11 and 12 are hard prerequisites, plugin install is explicit and
inspectable, and `bin` injection is session-scoped.

---

### Phase 20 - The TUI, and making it the default

**Gap closed:** the primary surface. Phase 17 put a language server in the loop;
this makes the loop legible while it runs, and puts it where a person lands first.

- [x] `src/tui/render.ts` — line kinds including `diagnostic`, fenced-code
      splitting, tool-card state, and pure formatters (duration, tokens, gauge)
- [x] `src/tui/components.tsx` — the status bar, tool cards, boxed code blocks
- [x] `src/tui/commands.ts` — the slash-command set, and the line-editing and
      history operations behind the keys
- [x] `src/tui/app.tsx` — streaming paint, tool-card lifecycle, command dispatch,
      key bindings
- [x] `src/cli/tui-default.ts` — the TTY gate, and bare `jaa` as the default
- [x] `docs/tui.md` — what is on screen, the keys, and how it is tested

#### Decisions

**Bare `jaa` opens the TUI, but only in a terminal.** Every condition in
`shouldLaunchTui` protects a caller that is not a person: both ends must be a
TTY, `CI` wins over everything, and `JAA_NO_TUI` is the escape hatch. A TUI into
a pipe is unreadable and a non-TTY stdin means nobody is there to type, and the
failure mode for getting that wrong is a hung job rather than a wrong word. The
command itself reuses the `chat` action rather than reimplementing it, because a
chat that behaves differently depending on how it was started would be two
products and the one you get by accident is the one that gets trusted.

**Streaming is opt-in and falls back three times.** `onStreamDelta` is set only
by a host that wants tokens, so a caller that does not pays nothing. When it is
set and the adapter has a stream, three things are guarded: a stream that yields
nothing falls back to the real call, because the stream is text-only and a tool
turn would otherwise be lost; a stream that dies mid-turn falls back and reports
`onStreamReplace`, because a partial answer presented as a finished one is the
failure to avoid; and a stream that reports no usage is estimated, because a
zero-token turn is not a free turn and a gauge reading 0 never warns.

**Rows that change cannot live in `Static`.** A `Static` item is written once
and never repainted, so a row that grows — streamed text, or a tool card moving
from running to a verdict — would be painted as a new row per update and stack up
on screen. Finished rows go to `Static`; the moving ones live in ordinary state
and are committed when they stop changing. The same reason keeps an expanded tool
card out of `Static`: it could not be collapsed again.

**Diagnostics are drained, not pushed.** The host's `withDiagnostics` wrapper is
built before the TUI exists, so a report can be produced before anyone is
listening; a callback would drop exactly those. A queue drained after each tool
result cannot.

#### Verification

- `tests/tui-stream.test.tsx` — streaming paint, no doubled message, a code fence
  arriving across deltas, the non-streaming fallback, a card's full lifecycle,
  every slash command, and every key binding including the two-press quit
- `tests/tui-commands.test.ts`, `tests/tui-render-new.test.ts` — the pure
  functions, including the three cases where the obvious implementation is wrong
- `tests/tui-default.test.ts` — the TTY gate, each condition separately
- `tools/tui-render-check.mts` — the real renderer against a TTY-shaped stream

Two real bugs came out of the render check rather than the component tests. Ink
throws from its input handler when the stream cannot do raw mode, which printed a
stack trace over the operator's own prompt; `startChat` now supplies the stream
Ink uses and reports the capability to the component. And an empty prompt rendered
no caret at all, because the status line had replaced it — the two are now
stacked, so you can see both where to type and what just happened.

#### Known limits carried out of Phase 20

- [x] **L1 (closed) - The interface is now verified in a real terminal.** WSL 2
      provides a pty on Windows, and `tools/tui-pty-drive.py` drives the built
      CLI through Python's `pty` module; the same driver runs natively on a Linux
      runner. It asserts on things a fake writable never produces: that Ink hides
      the cursor, emits DECSET 2026 (synchronized output), erases a line before
      rewriting it, and restores the cursor on a clean exit.

      Three findings came out of it, none of which any other harness could see:

      1. **A pty with a 0x0 winsize makes the TUI render nothing at all.** Node
         reads the width via ioctl, not from `COLUMNS`, so setting the
         environment variable does nothing. Ink sizes itself to zero, the frame
         comes out empty, and the interface looks broken while being fine. The
         driver now sets the winsize *and* verifies it by asking a child process,
         so an unusable terminal is reported as an unusable terminal.
      2. Ink repaints by erasing and rewriting a line, which is why a repaint does
         not scroll the transcript off the top.
      3. The pty suite cannot share a test pool. Twenty seconds of uncontended
         terminal time, asked of a pool running forty other files — several of
         which spawn real language servers — failed against a different neighbour
         every run. A check that is only reliable on an idle machine is a check
         that gets deleted, so it has its own config, script and CI step.

- [x] **First run could be completed and then stranded. Enter on the key bar
      stored the key, printed "using OpenAI", and never released the screen.**
      `Shell` swaps in the chat only when `SetupScreen` calls `onDone`, and the
      `enter-key` branch of the input handler called `confirmKey` without
      calling it - the list branch above it did, which is why the local-model
      path worked and the key path did not. The reported symptom was "chatting
      does not work even after giving an API key": the key was written correctly,
      nothing errored, and the screen showed a success message with no way past
      it. Now covered by a test that drives the real keystroke sequence and
      asserts `onDone` fired, which is the only version of this test that would
      have caught it.

- [x] **Ollama was invisible unless you had already succeeded at using it.**
      The provider list was filtered with `localOnly !== true`, so the one
      option that needs no account, no key and no money was the one you could
      not see. It was reachable only through the `choose-local` step, which needs
      Ollama's `/api/tags` to have answered - so it was missing for anyone with
      nothing pulled, and for anyone whose probe lost the race against a 1.5s
      timeout on a slow boot. The two people most likely to be setting jaa up for
      the first time. Ollama is now a row in the list marked "no key", it goes to
      the model list rather than to a key bar, it shows no signup URL, the empty
      model list names `ollama serve` and `ollama pull llama3.2`, and Esc steps
      back out instead of dropping the session.

      Verifying it also turned up a limit in the harness: the pty driver wrote
      every keystroke in a single `os.write`, so a multi-step flow arrived as one
      burst and React coalesced the intermediate screens. Fine for `/help`,
      useless for first-run setup, which is the flow that was broken. It now
      sends one keystroke per 0.45s - roughly what a person takes to glance at a
      screen before pressing the next key.
- [x] **The pty suite was failing for two reasons that had nothing to do with the
      TUI, and both of them read as "the interface is broken".**
      Worth writing down because the whole cost of this was a debugging session
      chasing the wrong layer.

      **A CRLF shebang.** `tools/tui-pty-drive.py` is exec'd through
      `#!/usr/bin/env python3`. A working-tree CRLF checkout makes that
      `python3\r`, and Linux answers `env: 'python3\r': No such file or
      directory` - which reads exactly like a missing interpreter. The suite
      failed 3/3 while the TypeScript under test was demonstrably fine, which is
      the worst possible combination: a red gate and a working product. There is
      now a `.gitattributes` pinning `*.py` and `*.sh` to LF, so a Windows
      checkout cannot produce a file that cannot be run.

      **A hard limit below the cold start.** The driver's `HARD_LIMIT` was 18
      seconds. Measured, the chat screen takes **28.8 seconds** from spawn to
      first paint on this host, because node is loaded off `/mnt/c` - a Windows
      9p mount - through WSL. So the driver declared the recording empty, killed
      a child that was about to paint, and retried into the same wall: three
      attempts, three empty recordings, no information. Raised to 90s with
      `RETRIES` cut to 2 so the worst case still fits the suite's 300s timeout.
      The suite now takes ~150s instead of ~80s, which is the honest price of
      not killing a healthy process.

      Both were found by writing a throwaway pty runner to compare against the
      driver. The driver said the TUI rendered nothing; the runner said 2081
      bytes of correct screen. Only one of them was wrong, and it was not the one
      reporting the failure.
- [x] **Splash - the idle screen is a brand moment, and it reports real numbers.**
      `src/tui/splash.tsx` draws a framed `JAA` wordmark with a
      `JUST-AN-AI` line, a context gauge, and top and bottom status rows, shown
      only while the transcript is empty. Every value on it is read from the live
      app: the gauge is the real ratio, the model is the resolved model, memory is
      the real token count. It falls back to a text wordmark below 56 columns and
      renders nothing below 44, because a splash that wraps in a split pane turns
      the session into ragged fragments. Depth comes from a dim ramp down the
      letter rows rather than a drop shadow - an offset shadow behind letters that
      dense doubles every stroke and the word stops being readable, which is the
      one thing a wordmark has to be. Verified in a real 100x30 pty.
- [ ] **L2 - Only the OpenAI-compatible adapter streams.** `ChatStreamChunk`
      exists on the adapter interface and the Anthropic, Google and Ollama
      adapters do not implement it yet, so those get the non-streaming path and
      the text still appears — just all at once. The interface and the three
      fallbacks       are in place and tested; the adapters are the remaining work, and
      they are Phase 21.
- [ ] **L3 - The whole-repository TypeScript probe is load-sensitive.** Unlike
      the other language-server probes, which run against a throwaway fixture,
      this one points `tsserver` at the jaa repository itself so it indexes a real
      project. Under a full 40-file test pool on a loaded host that index can
      still exceed the 120s push wait, and the failure reads as "typescript
      reported: (nothing)" — indistinguishable from a broken server. It passes
      alone and passed on a second consecutive full run, so it is contention
      rather than a defect, but it is recorded rather than smoothed over: a test
      that flaps on machine load is a test people learn to re-run instead of
      read. The durable fix is to move it to a fixture that is large enough to be
      realistic and small enough to be fast, which is Phase 30's provider-double
      work applied to the language-server harness.
- [ ] **L4 - Half fixed. The language servers have their own pool; the rest of
      the suite is still load-sensitive on this host.**
      **Done:** `vitest.lsp.config.ts` runs `lsp-servers` and `lsp-loop` with
      `fileParallelism: false`, so the five real servers no longer compete with
      thirty-eight other files, and no longer compete with each other. Nothing
      was skipped and no assertion was weakened: 51/51, twice green.

      **Still open:** the remaining pool is not clean. On this Windows host,
      across repeated full runs, the victim moved each time - `lsp-loop`'s
      whole-repo TypeScript probe, then `lsp-servers`' Go probe, then
      `tui-app`'s rewind confirmation, then `bench`'s retained-stdout cap - each
      passing alone, with the same code, and the same run going green on the
      next attempt. Moving the language servers out narrowed it; it did not
      remove it. Chasing the next victim is not a fix, because there is no last
      one.

      The general remedy is measured, not assumed: `npm run test:serial`
      (`vitest run --no-file-parallelism`) is **1018/1018 green on the same
      machine minutes after a parallel run failed a different file**. The
      parallel pool stays the default because CI runners are not this host and
      have been green run after run, and serialising everything would slow CI to
      hide a property of one loaded laptop. But a green parallel run on this
      machine is not evidence of anything, and it should not be reported as one.

---

## Phases 21-31, in detail

Each phase below is scoped so the *definition of done* is checkable, and each
names what it will break if it is done wrong. A phase whose success cannot be
demonstrated is not a phase.

---

### Phase 21 - Streaming on every adapter

**Why first.** It is Phase 20's L2, it is the single biggest perceived-latency
win available, and the contract is already written and tested by
`tests/loop-stream.test.ts`. Three fallbacks are in place and proven: an empty
stream re-runs non-streaming (so a tool turn is never lost), a stream that dies
mid-turn re-runs and reports `onStreamReplace` (so a partial answer is never
presented as a whole one), and a stream with no usage is estimated (so the
context gauge is never pinned at zero).

**What is actually hard.** Not the text — all three SDKs stream text. It is:

- **Tool calls.** The OpenAI-compatible stream yields text only. Anthropic
  streams `content_block_start`/`delta`/`stop` and can put a tool use in any
  block; Gemini streams function calls as a trailing part. Each needs its own
  assembler, and each assembler's output must equal the non-streaming message for
  the same request. That equality is the acceptance test, not "it streamed".
- **Usage.** Reported on different events by each provider, sometimes more than
  once, sometimes never.
- **Interruption.** Ctrl+C mid-stream must cancel the provider request, not leave
  a half-painted frame.

**Definition of done.**
- `ProviderAdapter.stream` implemented for anthropic, gemini and ollama.
- A property test per adapter: for N scripted responses, the streamed message
  (content *and* tool calls) is deep-equal to the non-streaming one. Fails if an
  assembler drops or reorders a block.
- Ctrl+C during a stream leaves the transcript consistent and the provider
  request cancelled.
- All six registry entries of the loop's stream contract tests run against every
  adapter.

**What it breaks if done wrong:** a tool call assembled from a partial stream is
worse than no streaming at all, because the model appears to want a tool and
nothing happens. The equality test exists to make that impossible to merge.

---

### Phase 22 - Live theme reload, and a config surface worth using

**Why.** Phase 20 shipped themes that need a restart, which makes them a
screenshot rather than a setting. The palette is a module constant read at
import; that is the whole limitation.

**What.**
- `loadTheme()` reads `ui.theme` and is re-read on a filesystem watch of the
  config. A changed theme repaints without a restart.
- Move colours off module constants into a React context, so a change is a
  re-render rather than a process restart. This is the real work; the watch is
  the easy half.
- `jaa config` gets `list`, `get`, `set`, `unset`, `path`, `edit`, and prints
  *every* key with its current value and a one-line explanation. The setting
  exists today; discovering it does not.
- A `ui` block beyond `theme`: `gaugeWidth`, `showStatusBar`, `showToolTiming`,
  `animations` (honouring `prefers-reduced-motion` automatically), `maxWidth`.
- A preview command: `jaa config set ui.theme X && jaa config preview ui` shows
  the chat chrome in every theme and exits.

**Definition of done.** A theme change repaints within one frame of the config
file being written, with no restart. A key exists in the config schema, is
listed by `jaa config list`, is settable by path, and is documented — asserted by
a test that walks the schema, because a setting nobody can find is not a setting.

---

### Phase 23 - Diff review in the TUI

**Why.** jaa writes files and reverts them. Right now the operator sees
`✓ write_file src/a.ts 142B` and has to go and look. This is the highest-value
missing affordance in the whole product: it is where an agent earns or loses
trust.

**What.**
- A split view: the file before, the file after, hunks coloured by add/remove.
- Enter opens the hunk, `y` accepts, `n` rejects, `a` accepts all, `q` rejects
  all and asks the agent to try again.
- Rejection feeds back into the loop as a tool result, so the model learns what
  was not wanted rather than the operator just undoing it afterwards.
- A pending-changes list across the session, with the rewind target visible
  beside each file so `/rewind` and review are the same mental model.

**Definition of done.** An operator can review and partially reject a five-file
change without leaving the TUI, and the agent's next turn reflects the
rejections. Tested by driving a scripted agent that writes, rejects, and rewrites.

**What it breaks if done wrong.** A review UI that cannot be trusted to show the
*real* file is worse than none, because the operator approves what they were
shown rather than what was written. So the diff must be rendered from disk after
the write, not from a buffer the tool passed in.

---

### Phase 24 - Multi-session and a switcher

**Why.** `jaa chat` is one argument-free session. A real week of work is
several, and today the only way to get another is `--resume`, which is a restart.

**What.**
- A live session list, with a picker bound to a key.
- Fork from any turn into a new session, keeping the transcript prefix.
- Named sessions, and search across transcripts (`/sessions <text>`).
- A session summary line the operator can scan: last activity, turns, files
  touched, cost.

**Definition of done.** Switching sessions preserves both transcripts and the
active one, mid-turn switching is refused rather than half-applied, and a forked
session can be resumed from either side.

---

### Phase 25 - Attachment pipeline

**Why.** An agent that cannot see a screenshot cannot fix a UI, and a terminal
user pastes a URL where a person pastes an image.

**What.**
- `jaa ask "@file.png describe this"`, `@file.ts`, `@https://…`, and a bare path
  is detected as an image by extension and magic bytes.
- Images are read, resized to a provider-appropriate size, and sent as the
  provider's native content blocks — not base64 stuffed into a text message,
  which every provider bills differently and most reject.
- URLs are fetched once, converted to markdown, and cached by content hash so
  the same URL in a later turn is free.
- Text files respect an explicit size cap and say so when they are truncated,
  rather than silently sending the first 8 000 characters.

**Definition of done.** An image round-trips to a provider that supports vision
and to one that does not (with a stated refusal rather than a silent one), and a
truncated file says it was truncated.

---

### Phase 26 - Cost accounting, and a budget the agent respects

**Why.** The status bar shows tokens. Tokens are not money, and a user who
cannot see the number cannot decide whether to keep going.

**What.**
- Per-request cost from the provider's own pricing table, kept as data with a
  date so a stale price is visible rather than silently wrong.
- A running total per session and per day, and an at-a-glance figure in the
  status bar.
- A budget: `jaa ask --budget 1.00` and a session-level equivalent. The loop
  checks it *before* a request and stops cleanly with an explanation, rather
  than discovering the overrun afterwards.
- A `--report-cost` flag that prints the per-turn breakdown.

**Definition of done.** A scripted session's cost is asserted to the cent against
a fixture, and a budget of zero stops the loop before the first request rather
than after it.

**What it breaks if done wrong.** A budget checked *after* a request is a
reporting feature pretending to be a control. The check has to be pre-flight.

---

### Phase 27 - Prompt caching, done properly

**Why.** Phase 16 compacts the conversation; it does not stop re-sending a stable
prefix. For a long session this is often the largest single cost.

**What.**
- Providers expose cache-read and cache-write token counts; they are currently
  discarded. Capture them, show them, and separate them in cost reporting.
- Stable prefixes: the system prompt and tool definitions are already stable,
  and the first turns of a session are stable until compacted. Track which.
- Where a provider supports an explicit cache TTL, set it.

**Definition of done.** A second turn against a provider that reports cache reads
shows a non-zero cache-read count, and the cost report reflects the discount. A
provider that does not report it is shown as unknown rather than as zero.

---

### Phase 28 - Structured output and tool-result schemas

**Why.** Tool results are strings. A string has to be re-parsed by the model and
re-parsed again by jaa to render a card, and anything ambiguous becomes a wrong
tool call.

**What.**
- An optional JSON Schema per tool, sent to providers that support it, so a tool
  result is validated at the boundary and a malformed result is a clear error
  rather than a model's guess.
- A typed result envelope on the tool result, so the TUI can render structured
  data instead of summarising it — a file list as a list, a diff as a diff.

**Definition of done.** A tool that declares a schema and returns a violating
result fails with the violation named, and one that returns a conforming result
has it rendered as structure rather than as text.

---

### Phase 29 - Edit prediction and inline completion

**Why.** The highest-frequency interaction in a coding agent is typing at a
prompt. Everything else is occasional.

**What.**
- FIM-style completion against the model, on a debounce, only when the cursor is
  in a plausible position.
- A strict latency budget: anything slower than the budget is discarded, because
  a slow completion that arrives after the user has typed is worse than none.
- Explicitly off in `--permission-mode full-auto` unless asked for: unsolicited
  model calls are a cost and a latency surprise.

**Definition of done.** A completion that arrives after the budget is discarded
and never overwrites what the user typed, asserted by a test with a deliberately
slow fake provider.

---

### Phase 30 - A provider test double, and fault injection

**Why it is a phase and not a chore.** Every phase above needs a provider that is
deterministic, can be told to fail in a specific way, and does not need a key.
Today every adapter test either hits the network or fakes the adapter inline,
which means the *router* — the part that actually decides which adapter runs —
is barely tested at all.

**What.**
- A `FakeProvider` implementing the full adapter contract, scriptable by
  response, and able to inject: mid-stream failure, a stream that never
  terminates, usage that is missing, a tool call split across blocks, a rate
  limit, and a 500.
- A `--fake` mode for `jaa ask` so a human can drive the whole TUI with no key
  and no network.
- Fault injection wired through the loop's own tests, so the three fallbacks in
  Phase 21 are exercised against a real adapter rather than a stub.

**Definition of done.** `jaa ask --fake` drives a full session end to end with no
network, and every fallback in `tests/loop-stream.test.ts` is exercised through
the router rather than around it.

## Phase 31 - Multi-pane workspace, and the surfaces a session actually needs

This phase is here because a stale draft of Phase 20 specified it under files
that were never created (`src/tui/cards.ts`, `layout.tsx`, `dashboard.tsx`,
`permissions.tsx`, `themes.ts`, `keybinds.ts`, `motions.tsx`, `export.ts`). The
scope was real; the file map was fiction. Retiring the draft without carrying the
scope forward would have quietly deleted the largest unbuilt affordance in the
product, so it is restated here against the layout that exists.

What Phase 20 actually built, for the avoidance of doubt: `src/tui/render.ts`,
`components.tsx`, `commands.ts`, `app.tsx`, `theme.ts`, `setup.tsx`,
`setup-state.ts`, `local-models.ts`. Cards live in `components.tsx` and the theme
registry is `theme.ts`. Phase 31 adds to those files and introduces three new
ones.

**Gap closed:** the gap between what jaa does and what a person can see it doing.
Phase 15 runs subagents in parallel with a per-agent token count; there is no
place to watch that, steer it, or stop it.

- [ ] `src/tui/keybinds.ts` - a configurable keymap with a discoverable palette.
      Every binding is listed by a command that renders the current map, because
      an undiscoverable keymap is a keymap nobody changes. Conflicts are
      reported at load, not silently resolved by precedence
- [ ] `src/tui/layout.tsx` - multi-pane: transcript, tool activity, subagent
      tree, and a dockable task board. Focus, split, and resize on a binding
      from `keybinds.ts`. Single-pane remains the default, because a layout is a
      preference and defaulting to the complex one makes the first run worse
- [ ] `src/tui/dashboard.tsx` - every live subagent with state, current tool,
      elapsed time, and token spend, attach/steer/stop from the dashboard.
      Reads the orchestrator's live state; it does not keep a parallel copy,
      which is how a dashboard starts lying
- [ ] An inline approval card in `components.tsx`, rendering a decision from
      `src/permissions/engine.ts` as a first-class card showing the exact
      command, the rule that matched, and the options. The engine already exists
      and is tested; only its presentation is missing
- [ ] `/export` to Markdown in `commands.ts`, including tool calls, diffs, and
      compaction markers. The transcript is already structured, so this is a
      serializer, not a scraping job
- [ ] Vim motions in the composer, plus expand and collapse
- [ ] Accessibility, which is a requirement and not a pass at the end: full
      keyboard reachability, visible focus, correct ARIA, a non-visual transcript
      mode for screen readers, and no information carried by colour alone. An
      automated axe pass over the non-visual transcript

**Gate:** a full session -- subagents, approvals, diffs, a compaction event, a
crashed tool -- renders correctly at 80x24 and at 200x60 with no layout
corruption. Every action is reachable by keyboard alone. The axe pass reports
zero serious violations.

**Risk:** Ink is a React renderer for a terminal, and many live-updating panes
will drop frames. Mitigation: bounded update frequency, a frame budget, and a
headless render test that asserts update counts rather than trusting the eye. The
second risk is the dashboard lying: it must render orchestrator state, never a
local mirror of it, or a stalled agent will look busy.

---

## Deferred beyond Phase 31

Recorded so they are not lost, explicitly not in the competitive-core scope:

- Code Mode -- a model-generated TypeScript program that orchestrates many tool
  rounds in one call. This is DeepSeek's genuine innovation and the one place
  jaa would need to out-invent rather than out-ship. It is deliberately not
  scheduled: it needs Phase 30's provider double to be testable at all, because
  a program that runs many tool rounds is exactly what a flaky provider turns
  into an unreproducible bill. Highest-value phase after 31.
- Background and scheduled execution -- durable jobs, wakeup scheduling, a
  GitHub Action, cost and status lines.
- Provider depth -- OAuth subscription auth for Claude Pro/Max and ChatGPT
  Plus, the OpenAI Responses API, per-model reasoning-effort control, and
  prompt-cache accounting.
- Plugin themes as a distributable marketplace entry.
- A web and IDE client, if the client-server split is ever worth the cost.

## Definition of done for phases 11-20

Every phase gate, pasted with real output:

```
npm run lint
CI=1 npm test
npm run build
npm audit --audit-level=high
npx playwright test --config=tests/e2e/playwright.config.ts   # when e2e exists
npx wrangler deploy --dry-run                                  # N/A for jaa
```

Plus, for the roadmap as a whole:

- `jaa bench` shows jaa at or above the best competitor on every tag, or the
  specific tags where it loses are named with the reason.
- The Phase 18 fixture repository passes all five acceptance assertions.
- `jaa doctor` runs clean on Linux, macOS, and Windows and names the active
  sandbox mechanism on each.

Report format is unchanged: SUMMARY, FILES, PACKAGES, COMMANDS, METRICS, RISKS,
FINDINGS, BLOCKED. Intended behavior is never reported as verified.

## Tools commands (Windows note)
PowerShell: `rg` NOT on PATH; use the grep/glob session tools or
PowerShell `[regex]` over `[IO.File]::ReadAllText` for huge JSON lines.