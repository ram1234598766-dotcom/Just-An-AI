# jaa — optional language servers

jaa ships with a registry of six language servers in `src/lsp/registry.ts`. It
installs **none** of them. Each is an operator choice, detected per project, and
reported honestly when absent:

```
jaa lsp list     # what this project uses, and whether it works here
jaa doctor       # the same check as part of a full health report
```

A server being *installed* is not the same as a server being *usable*.
`rust-analyzer` with no `cargo` starts, handshakes, and reports nothing at all —
no error, no diagnostics, no way to tell that from a clean file. So each entry
declares the toolchain it needs, and jaa reports it unavailable when that
toolchain is missing rather than calling it available.

## What each entry needs

| Language | Server | Install | Also needs |
| --- | --- | --- | --- |
| TypeScript / JavaScript | `typescript-language-server` | `npm i -g typescript-language-server typescript` | a `tsserver` (see below) |
| Python | `pyright-langserver` | `npm i -g pyright` | — |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` | `cargo` + `rustc` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` | `go` |
| C / C++ | `clangd` | your platform's LLVM package | a `compile_commands.json` |
| Java | Eclipse JDT LS | put its `bin` on `PATH`, or set `JDTLS_HOME` | a JRE (17+) |

## Notes that will save you an hour

**TypeScript 7 has no `tsserver`.** `typescript-language-server` is a front-end
for `tsserver`, so on a project using TypeScript 7 you must install a 5.x
alongside it. jaa prefers the project's own `node_modules/typescript`, then its
own, and tells you which one it picked.

**Rust needs the component, not just the binary.** `~/.cargo/bin/rust-analyzer`
is a *rustup proxy*. Without `rustup component add rust-analyzer` it exits 1
immediately, which looks exactly like a broken server.

**C++ needs a compilation database.** clangd ignores a `.cpp` file it has no
compile command for, so it publishes nothing. Generate one with
`cmake -DCMAKE_EXPORT_COMPILE_COMMANDS=ON`, or point jaa at an existing
`compile_commands.json`.

**Java's launcher is not spawnable.** The `jdtls` on `PATH` is a batch file
wrapping a Python script and ending in `pause`. jaa reads the Eclipse layout off
that path and runs `java -jar org.eclipse.equinox.launcher_*.jar` itself, so no
shell is involved. It also answers `workspace/configuration`, which JDT LS
blocks on during startup — without an answer it sits at "0% Starting" forever and
every Java file looks clean.

**JDT LS needs source roots.** Send them in `initializationOptions`:

```json
{ "settings": { "java": { "project": { "sourcePaths": ["src"] } } } }
```

## How the tests prove this

`tests/lsp-servers.test.ts` runs every registry entry against a real project in
a temp directory, with a deliberately broken file and a clean control file. Each
server must report a real error in the first and **nothing** in the second. The
control is the point: without it, a server that reports nothing at all would pass
the first half.

An entry with no probe fails the test, so a new server cannot ship unproven. On a
host missing a server the probe skips for the same reason `detectServers` marks
it unavailable, and the skip is visible in the test output rather than hidden.
