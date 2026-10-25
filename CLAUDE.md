# frontmatter-set — agent guide

Node 20+ single-file CLI built from
[mjs-tool-skeleton](https://github.com/dgaidula/mjs-tool-skeleton), with two
dependencies, `yaml` and `diff`. One file: `frontmatter-set.mjs`. `README.md`
is the human-facing description; this file is the agent-facing contract.

It sets, inserts or removes YAML frontmatter fields across Markdown files
(`frontmatter-set <file|dir>... --set key=value --unset key --where key=value`),
changing only the lines it sets. It exists so a batch stamp (`status`,
`tags`, `author`) is a command, not a throwaway script.

## Driving `frontmatter-set` from an agent session

- **Reach for `--brief` first** — or `--json` when you need to parse the result — never the default human output. Brief is exactly one line per item (`<verdict> <summary>  <name>`, with a long reason cut at 160 characters; it is never longer than the human output), then a summary line and a `next:` line; JSON is a stable `{ tool, version, contract, command, effect, exit, items, summary, next }` object. The human output is for a person at a terminal and only wastes your context.

- **Any line whose verdict is not `ok` is a finding**, not noise. The verdicts are `ok`, `warn`, `skip`, `refuse`, `fail`; a non-`ok` line is never collapsed or dropped, and carries a parenthesised reason. A run is clean only when the summary reads `warn=0 refuse=0 fail=0` — `skip` is not a failure, but report what was skipped and why.

- **Dry-run before you commit.** `frontmatter-set <path>… --set key=value` (no `--go`) previews every change with a diff and writes nothing; `--go` performs it. In `--json`, `effect` says which kind of run it was (`dry-run` or `applied`), `state.plan` is the plan digest, and `items[].data.diff` is the diff (`jq -r '.items[].data.diff // empty'`). There is no confirmation step and no `--yes`.

- **Pin the plan.** After a clean dry run, `next` is `ask` with the same command plus `--go --plan <hex>`. That form writes only if every file and every edit is byte-for-byte what the dry run showed, and otherwise writes nothing and says `plan changed since the dry run`; read the diff, then run the pinned form. Plain `--go` still works, for a person or a runbook that has already reviewed the dry run.

- **What the verdicts mean here.** `ok`: the file would change (dry run) or changed. `warn`: as `ok`, but a replace changes a value’s type (a number, boolean, string, list or mapping becomes another type, or null), or `--set-yaml` writes a number in another form than given (`1.10` as `1.1`); `--go` writes it, and the reason says which. `skip`: already so, `--where` not met, no frontmatter, no `.md` files in a folder, or held back by a plan mismatch. `refuse`: not found, unreadable, not UTF-8 text, not writable, frontmatter that does not parse (the parser’s message is the reason), or an edit that failed the re-parse check (the file is left alone). `fail`: the write itself failed, or did not read back and was restored from its backup (the reason names it). One refused file does not stop the others.

- **`--set` values are strings; `--set-yaml` is typed.** `--set words=1500` writes `words: "1500"` (a `warn` over a numeric value, and a `skip` over `words: 1500`); `--set-yaml words=1500` writes `words: 1500`, and takes only a number, boolean, null or string (an empty value, a comment, or a number that overflows is exit 2).

- **Every `--go` write is backed up first**, to a dated folder outside the target (`items[].data.backup` in `--json`), then made in place. The backup folder is never cleaned.

- **Scope of an edit.** Top-level keys of a block-style frontmatter only: no dotted paths into nested maps, no flow-style `{...}` frontmatter. A key’s “continuation lines” (a block scalar, a list under the key) go with it.

- **Check the exit code, then read `next`:** `0` all ok · `1` partial (something warned, refused, or failed) · `2` usage error · `3` could not run to completion (an environment or internal error). **Exit `0` does not mean go** — a clean dry run exits `0` and can still say `ask`. On exit `2` or `3` there is nothing on stdout and no `next`: report stderr and halt.

- **`frontmatter-set --cheat`** prints a short card of the tool’s common invocations (a tldr page: a purpose line, then a handful of example commands). Read it when you need the usual command lines and not the full `--help`; it is not an output mode, and `--brief`, `--json` and `--quiet` are a usage error beside it.

- **Quote back** the final summary line plus every non-`ok` line as `--brief` printed it. That is the whole result — do not paraphrase a refusal into “done”. A reason that ends `… (+N chars; --json for all)` was cut at 160 characters: the cut form is the quote, and `--json` has the full reason when you need it.

### The babysit loop: run, read `next`, obey or halt

Every run ends with one piece of advice: the `next:` line, or the `next` object in `--json`.

```
next: ask  (dry run: 3 files would change; 1 file refused and left alone)
next: ask  (the plan changed since the dry run; nothing was written; run the dry run again and review it)
```

- **`run`** — run exactly that command, then read its `next` in turn. The text line reads `next: run <command>  (<why>)`, and `<command>` starts with `cd <dir> &&`: paste `<command>` into a fresh shell as it stands, from any directory. If a token is shown as `$'…'`, take `argv` and `cwd` from `--json` instead. In `--json`, take the `argv` array as given (`argv[0]` is node, `argv[1]` the tool’s own script) and run it from `next.cwd`; never rebuild or re-quote it. A `run` can come at exit `1`: a tool may advise `--go` over findings when its `--go` holds them aside rather than acting on them (it moves them to a hold folder, say). Run it, and still quote back every non-`ok` line.

- **`wait`** — run the command again after that many seconds; its text line starts with `cd <dir> &&` too. It is always a read-only poll.

- **`done`** — nothing is left for this tool to do. Report and finish. At exit `1` it means no further tool step, not success: report the findings.

- **`ask`** — a person’s decision. Report the summary and the findings, then halt. Never take the step yourself; in `--json`, `argv` is what the person would review, not a command for you. (A person running the tool by hand sees the same step as `next: your call: <command>`.)

- **`stop`** — something is broken beyond the tool’s remedy. Report and halt.

- **No `next:` line** (`"next": null` in `--json`) — this tool gives no advice; follow your runbook.

**Budgets.** At most 6 `run` steps per procedure, unless the runbook sets another number; past it, halt and report. `wait` has no cycle limit: the tool is the stuck detector (it turns a stuck state into `ask`), and the runbook procedure sets how long, in wall-clock time, you may wait.

**The runbook can only hold you back.** A runbook can halt you where `next` says `run`; nothing but a person carries you past `ask` or `stop`. Report any disagreement as a finding. `next` never carries an override flag — any `--yes*`, `--force*`, `--assume-yes`, `--allow`, `--allow-*`, or `--i-am-*` flag, `-y`, or one the tool declares — and it never contradicts the exit code. Advice can only go straight to `--go` on what you just previewed: a `run` that carries `--go` repeats the dry run you just ran, with `--go` added, and a `run` into another command carries no `--go`.

## Working on the tool

The tool-specific code sits above the fenced block in `frontmatter-set.mjs`:
`editText()` is the whole edit (line-based, never re-serialised), `checkEdit()`
is the re-parse guard, `planDigest()` the plan pin, `nextAction()` the advice.
Keep the `report()` / `verdict()` / `nextAction()` shape: every output mode
renders from the one item list, so they cannot disagree.

The fenced block at the bottom, between its two “do not edit” marker
comments, is runtime v2: the shared machinery of contract `mjs-tool/3`. Never
edit it; to move to a later contract, replace the whole block with the new
one. `test/fence.test.mjs` pins it by hash.

`npm test` runs `node --test`. Every test writes only inside its own temp
folder.

`fsync` after each write has no test; only a power loss would show its effect.
