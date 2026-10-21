# frontmatter-set

Sets, inserts or removes YAML frontmatter fields across Markdown files, and changes nothing but the lines it sets. It shows a diff first and writes only with `--go`.

Stamping the same few fields (`status`, `tags`, `author`, `date`) across a folder of posts or docs is usually left to a throwaway script, and usually without checks. This does it as one command, with them: a re-parse of every edit, a plan pin between the dry run and the write, and a backup of each file before it changes.

**Hardened:** 2026-10-22 · v0.1.0 · release gate, one fix round, re-check CLOSED WITH FOLLOW-UPS (83 tests, macOS and Linux)

## Install

Not on npm; run it from a clone.

```sh
git clone https://github.com/dgaidula/frontmatter-set && cd frontmatter-set
npm install          # two dependencies: yaml, diff
npm link             # optional: puts frontmatter-set on your PATH
frontmatter-set --cheat
```

Requires Node 20+. One file, `frontmatter-set.mjs`, plus the [`yaml`](https://www.npmjs.com/package/yaml) package (parsing, and the quoting of written values) and [`diff`](https://www.npmjs.com/package/diff) (the dry-run diff).

## Usage

```sh
frontmatter-set <file|dir>... [--set key=value]... [--set-yaml key=value]... [--unset key]... [--where key=value]... [--go [--plan <hex>]]
```

At least one `--set`, `--set-yaml` or `--unset` is needed.

```sh
frontmatter-set posts/ --set status=published                         # dry run: a diff per file, writes nothing
frontmatter-set posts/ --set author="Ada Lovelace" --where status=draft   # only the files that are drafts now
frontmatter-set a.md b.md --unset tags                                 # remove a field and its continuation lines
frontmatter-set posts/ --set status=published --go --plan 3f9c1a7e5b2d4c60   # write, only if nothing differs from the dry run
frontmatter-set posts/ --set-yaml words=1500                           # a YAML number, not the string "1500"
```

- **A folder** means its `*.md` files, not recursive; dotfiles are left out. A file named directly is edited whatever its extension.

- **`--set key=value`** replaces the key’s value, or inserts the key just before the closing `---` when it is absent. Repeatable. The value is everything after the first `=`. A key is matched after Unicode NFC normalisation, so `café` typed either way is one key; a key with leading or trailing whitespace, and a key or value with a control character (U+0000–U+001F but tab, U+007F–U+009F, U+2028, U+2029), is a usage error.

- **`--set-yaml key=value`** reads the value as YAML (the 1.2 core schema) and writes it as its canonical text: `words=1500` writes `words: 1500`, `draft=true` writes `draft: true`, `note=null` (or `note=~`) writes `note: null`, and `'title="A: B"'` writes the string `"A: B"`. Only a number, boolean, null or string is taken; a map, a sequence, an alias, a tag, an anchor or a value that does not parse is a usage error, and so is an empty value (or a bare `---` or `...`), a value with a YAML comment (`'a # c'`; use `--set` to write the `#`), and a number that would be written as infinite or zero (`1e400`, `1e-400`). A number written in another form than given (`1.10` as `1.1`, `0x1F` as `31`, `007` as `7`, `1e3` as `1000`) is a `warn` naming both texts. It mixes with `--set`, `--unset` and `--where`; one key named by two of them is a usage error.

- **`--unset key`** removes the key and its continuation lines (the indented lines of a block scalar, the items of a list). A key that is not there is left alone.

- **`--where key=value`** touches only files whose current value of the key equals the string. A string is compared by its parsed value (`"open"` and `open` both equal `open`); a number, boolean or null by its source text, exactly as written: `0123` matches `0123`, not `123`; `null` matches `null` and `~` matches `~`; an empty value (`key:`) matches the empty string. Repeatable; the conditions are ANDed. A missing key, a list or a mapping never matches.

- **`--set` values are YAML scalars, and always strings.** The `yaml` package’s own stringifier decides the quoting, under YAML 1.1 rules so that it also quotes what an older parser would misread: `a: b`, a leading `#`, `-`, `[`, `{`, `*`, `&`, `!`, `|`, `>`, `'`, `"`, `%`, `@` or a backtick, `yes`/`no`/`on`/`off`/`true`/`false`/`null`, a number, a date, and a leading or trailing space; and any plain form YAML 1.2 would read as something else (`0o17`) is double-quoted too. Anything else stays plain, and a long value stays on one line. A value cannot contain a line break. `--set words=1500` therefore writes `words: "1500"` (use `--set-yaml` for a number).

- **Already so, and type changes.** A key that already holds the value is a `skip` (“already so”): for `--set`, a number or boolean whose YAML text is the value (`words: 1500` with `--set words=1500`) counts; for `--set-yaml`, the same type and value. A replace that changes a number, boolean, string, list or mapping into another type (`words: 1200` to the string `"1500"`, a `tags` list to a string), or a value into null, is a `warn` whose reason names both types; `--go` still writes it, and the warn is a finding (exit 1). Filling an empty or null value is not a type change, so it is not a warn; replacing a value with null is.

### What stays untouched

The frontmatter is edited line by line, never re-serialised. A key’s line (and its continuation lines) is replaced where it stands, keeping the key’s own spelling and spacing and the line ending of the last line replaced. A trailing comment stays on a replaced single-line value (`status: open  # as of Oct` becomes `status: closed  # as of Oct`), after the colon of a key whose value was empty or on the next lines (`tags: # one per line`), and on every untouched line. Every byte outside the lines being set is kept: the body, key order, quoting, blank lines, a leading byte-order mark, CRLF or LF endings, and a missing final newline.

### Checks before any write

- **Re-parse guard.** The new frontmatter is parsed again. The item is refused, and the file left alone, unless every untouched key is deep-equal to before, each `--set` key reads back as exactly its new value, and each `--unset` key is gone. (Removing `base: &b …` while another key still says `*b` is the kind of edit this catches.)

- **Invalid input.** A file whose frontmatter does not parse is refused with the parser’s message and line number. So is a file that is missing, unreadable, binary, or not UTF-8, and frontmatter that is not a block mapping.

- **Backup, then rewrite in place.** Before a file is written it is copied to a backup folder outside it, `~/Library/Application Support/frontmatter-set/backup/<YYYY-MM-DD>/<HHMMSS>-<pid>/<folder>-<8 hex>/<name>` (one folder per run, so every backup keeps its file’s own name; under it, the file’s folder name plus 8 hex characters of a hash of its path, so two `a.md` never meet; on every platform but macOS the root is `$XDG_STATE_HOME/frontmatter-set/backup`, or `~/.local/state/frontmatter-set/backup` when it is unset or relative; `FRONTMATTER_SET_BACKUP_DIR` overrides it). The copy is read back before anything is written. Then the file is rewritten in place: every byte written, cut to its new length and flushed, then read back. In place keeps the file itself, its inode, so its permission bits, extended attributes and Finder tags, BSD flags, creation date and hard links all stay, and nothing new appears in the folder (no temp file for a synced folder to upload). The cost is atomicity: a run killed mid-write can leave that one file half written, and the backup holds its original. A file that does not read back as written is rewritten from the backup and the item fails, naming the backup. `--json` gives each backup as `items[].data.backup`, and the human output as a note. **The backup folder is never cleaned by the tool**; delete old dated folders by hand. The dry run writes no backup. A symlink is followed, so the link keeps pointing where it did. A file the user cannot write is refused before anything happens. If a file changed between the plan and the write, it is not written and the item fails.

- **Plan pin.** The dry run reports a plan: 16 hex characters of a sha256 over every target’s path, the bytes read, and the bytes that would be written (`state.plan` in `--json`, and in the advised command). `--go --plan <hex>` writes only if the plan is still that one, so `--go` does exactly what the dry run showed; if anything differs it writes nothing, adds a refused `plan` item, and exits 1. A plain `--go` still works, for a person or a runbook that has already reviewed the dry run; the `next:` advice always offers the pinned form. No `--yes` exists, and nothing prompts, so an unattended caller can always run it.

### One item per file

| verdict | when |
|---|---|
| `ok` | the file would change (dry run), or changed |
| `warn` | as `ok`, but a replace changes a value’s type (number, boolean, string, list or mapping to another, or to null), or `--set-yaml` writes a number in another form than given; written with `--go` |
| `skip` | already so; `--where` not met; no frontmatter (or no closing `---`); a folder with no `.md` files; held back because the plan changed |
| `refuse` | no such path; unreadable, binary or not UTF-8; not writable; frontmatter that does not parse; a key that appears twice once NFC-normalised; an edit that failed the re-parse guard |
| `fail` | the write itself failed (or did not read back, and was restored from the backup) |

The dry run includes a unified-style diff of the changed lines (one line of context) in the human output and in `--json` as `items[].data.diff`. `--brief` stays one line per file.

Every run renders from one list of items in four modes: the default human output (the diff included), `--brief`, `--json` (a stable `{ tool, version, contract, command, effect, exit, state, items, summary, next }` object, `state.plan` the plan digest), and `--quiet` (the summary line only). Every text mode ends with a `next:` line. `--json` cannot be combined with `--brief` or `--quiet`. `frontmatter-set --cheat` prints a short card of common invocations in tldr page format.

## Exit codes

| code | meaning |
|---|---|
| `0` | all items ok (a skip is not a failure) |
| `1` | partial: a file warned (a type change, a number rewritten), was refused or failed, or the plan changed |
| `2` | usage error: no path, nothing to set or unset, a malformed `key=value`, a repeated key, whitespace around a key, a line break or control character, a `--set-yaml` value that is not one number, boolean, null or string (empty, commented, or a number too large or small to write), `--plan` without `--go` |
| `3` | could not run to completion: a dependency is missing, or an internal error |

## For agents

See [CLAUDE.md](CLAUDE.md): reach for `--brief` or `--json`, treat any non-`ok` line as a finding, dry-run before `--go`, and obey or halt on the `next:` line.

## Development

```sh
npm install
npm test      # node --test
```

`test/fence.test.mjs` pins the skeleton’s runtime block by hash. The edit logic lives above that block in `frontmatter-set.mjs`.

## Open items

- **Compared with `yq` (v4.54.1, 2026-10-21).** Setting `status: closed` in four sample files with `yq --front-matter=process -i '.status = "closed"'` and with this tool: `yq` kept quoting style, key order and flow sequences, but it collapsed the spacing before a trailing comment (`high   # note` became `high # note`) and rewrote a CRLF frontmatter block with LF endings (five lines changed for a one-key edit). This tool changed exactly one line in each file. So `yq` is close; what this tool adds is that byte-for-byte guarantee, plus the re-parse guard, the dry-run diff, the plan pin and the backup.

- **Typed values.** `--set` writes strings only; `--set-yaml` writes a number, boolean or null.

- **Top-level keys of a block-style frontmatter only.** No dotted paths into nested maps, and flow-style `{...}` frontmatter is refused. Keys are matched by their parsed text; a quoted key is found and keeps its quotes when replaced.

- **A replaced line keeps its trailing comment.** `status: open  # as of Oct` keeps `# as of Oct` when the value changes, which can leave a stale remark. Dropping it instead is a one-line change if that reads better.

- **In place, not atomic.** Hard links, extended attributes and Finder tags now survive a write, at the price that a run killed mid-write can leave one file half written; its original is in the dated backup folder.

## Known limits

- A file with CR-only line endings, or frontmatter closed by `...` instead of `---`, is skipped as having no frontmatter, or refused; it is never edited wrongly.
- A comment on a multi-line value (`note: | # why`, or after a flow list’s closing `]`) is dropped with the value.
- Filling an empty or null value is not a type change, so it is not a warn; replacing a value with null is.
- There is no lock: a program that writes a file in the moment between the tool’s last check of it and its own write loses that write (the tool’s backup holds the bytes it checked).
- A dangling `x.md` symlink in a folder is passed over silently; named directly, it is refused as `no such path`.
- A new key that YAML 1.1 reads as a boolean or null (`on`, `yes`, `no`, `null`) is inserted quoted (`"on": x`); an existing key keeps its own spelling.
- A file literally named `--go` (or `--plan`), given after `--`, is left out of the dry-run command the advice offers after a plan change; name it `./--go` instead.

## License

MIT © Danniel T. Gaidula
