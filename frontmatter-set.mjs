#!/usr/bin/env node
// frontmatter-set - set, insert or remove YAML frontmatter fields across Markdown
// files, changing only the lines it sets. Single-file Node CLI from
// mjs-tool-skeleton (contract mjs-tool/3): usable by a person at a terminal and
// unattended by an agent, from ONE set of item objects.
//
// Usage:
//   frontmatter-set <file|dir>... [--set key=value]... [--set-yaml key=value]... [--unset key]...
//                   [--where key=value]... [--go [--plan <hex>]]
//   (at least one --set, --set-yaml or --unset)
//   frontmatter-set --help | --version | --cheat
//
// What it does:
//   A directory means its *.md files (not recursive). For each file the YAML
//   frontmatter (the block between the opening and closing `---`) is edited line
//   by line, never re-serialised: a key's line (and any indented continuation
//   lines of a block scalar or list) is replaced where it stands, a missing key is
//   added just before the closing `---`, and every other byte of the file is
//   kept: line endings, a leading BOM, comments, quoting and key order.
//
//   --set k=v    Set the key to the string v (written as a YAML scalar, quoted
//                only when YAML would misread it plain). Repeatable.
//   --set-yaml k=v  Set the key to v read as YAML: a number, boolean, null or
//                string, written as its canonical text (words=1500 writes
//                words: 1500; a number written differently from v, 1.10 as
//                1.1, is a warn). Anything else, an empty value, a comment,
//                or a number too large or too small to write, is a usage
//                error. Repeatable.
//   --unset k    Remove the key and its continuation lines. Repeatable.
//   --where k=v  Touch only files whose current value of k equals v: a string
//                by its parsed value, anything else by its source text.
//                Repeatable; the conditions are ANDed.
//   Replacing a number, boolean, string, list or mapping with another type, or
//   with null, is a warn. Filling an empty or null value is not.
//
// Safety:
//   - A dry run unless --go. The dry run shows a unified-style diff of the
//     changed lines (and `data.diff` in --json), and a plan digest (`state.plan`
//     in --json, the hex in the `next` line).
//   - --go --plan <hex> writes only if the plan is still the one the dry run
//     showed (same files, same bytes, same edits); otherwise it writes nothing.
//     --go alone still works.
//   - Each edit is checked by re-parsing the new frontmatter: every untouched key
//     must be deep-equal to before, each --set key must equal its new value, each
//     --unset key must be gone. A file that fails is refused and left alone.
//   - A file whose frontmatter does not parse is refused, with the parser's message.
//   - Each file is first copied to a backup folder outside it, one per run:
//     <root>/<date>/<HHMMSS>-<pid>/<folder>-<8 hex>/<name>, the root
//     ~/Library/Application Support/frontmatter-set/backup on macOS; on every
//     platform but macOS, $XDG_STATE_HOME/frontmatter-set/backup, or
//     ~/.local/state/frontmatter-set/backup when it is unset or relative;
//     $FRONTMATTER_SET_BACKUP_DIR overrides it. Then it is rewritten in place
//     (same inode, so extended attributes, flags and hard links stay) and read
//     back; a write that does not read back is restored from the backup.
//
// Output modes (all rendered from the same item objects, so they can never
// disagree):
//   (default)   human    A block per file, with the diff.
//   --brief              Exactly one line per file: <verdict> <summary>  <name>
//                        (no padding, no glyph), plus a parenthesised reason
//                        whenever the verdict is not ok, cut at 160 characters
//                        (the rest is in --json). Never longer than the human
//                        output of the same run. Ends with a summary line.
//   --json              A stable object on stdout, nothing else:
//                        { tool, version, contract, command, effect, exit,
//                          state: { plan }, items: [...], summary: { ok, warn,
//                          skip, refuse, fail }, next }   (contract "mjs-tool/3").
//   --quiet             The summary line only.
//   Every text mode then ends with one `next:` line, the tool's advice on the
//   next step. After a clean dry run it is `ask`, with the command to run:
//   the same command plus `--go --plan <hex>`. --json cannot be combined with
//   --brief or --quiet.
//
// Flags:
//   --set, --set-yaml, --unset, --where   the edit and the filter (see above).
//   --go        perform the edit (default is a dry run).
//   --plan <hex>  with --go: refuse unless the plan matches the dry run's.
//   --brief     one line per file (see above).
//   --json      machine-readable output (see above).
//   --quiet     summary line only.
//   --help, -h  print this header.
//   --version   print "frontmatter-set <version>" (version read from package.json).
//   --cheat     print a short card of common invocations in tldr page format
//               and exit 0, printing nothing else.
//               It cannot be combined with --brief, --json or --quiet.
//
// Conventions that make it safe unattended:
//   - Data goes to stdout; every diagnostic goes to stderr. In --json mode
//     stdout is JSON and nothing else.
//   - Nothing here prompts: there is no confirmation step, and no --yes.
//   - Unknown flags are a usage error (exit 2) with a --help hint.
//
// Exit codes:
//   0   all items ok (a skip is not a failure: already so, --where not met, no
//       frontmatter).
//   1   partial: at least one file warned, was refused or failed, or the plan
//       changed.
//   2   usage error (unknown flag, no path, no --set, --set-yaml or --unset, a
//       malformed key=value, a repeated key, whitespace around a key, a line
//       break or control character in a key or value, a --set-yaml value that
//       is not one number, boolean, null or string (or is empty, carries a
//       comment, or is a number too large or small to write), --plan
//       without --go).
//   3   could not run to completion: a dependency is missing, or an internal
//       error (including advice that breaks the `next` safety rules).

import {
  statSync, readFileSync, readdirSync, realpathSync, accessSync, copyFileSync, mkdirSync,
  openSync, readSync, writeSync, ftruncateSync, fstatSync, fsyncSync, closeSync, constants as fsConstants,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs, isDeepStrictEqual } from 'node:util';

// The two dependencies load here, not by a static import, so a missing
// node_modules is the contract's exit 3 with a message, not Node's exit 1.
let YAML = null;
let diffLib = null;
let dependencyError = null;
try {
  ({ default: YAML } = await import('yaml'));
  diffLib = await import('diff');
} catch (e) {
  dependencyError = `a dependency is missing (${e.message.split('\n')[0]}); run npm install in ${dirname(new URL(import.meta.url).pathname)}`;
}

// ---- the cheat card (printed by --cheat) ------------------------------------

const CHEAT = `# frontmatter-set

> Set, insert or remove YAML frontmatter fields across Markdown files, changing only those lines.
> More information: frontmatter-set --help.

- Preview setting a field in every .md file of a folder (dry run, with a diff):

\`frontmatter-set {{path/to/folder}} --set {{status=closed}}\`

- Set several fields, only in files where another field already has a value:

\`frontmatter-set {{path/to/folder}} --set {{priority=low}} --set {{review_note="Superseded."}} --where {{status=draft}}\`

- Set a field to a YAML number, boolean or null instead of a string:

\`frontmatter-set {{path/to/folder}} --set-yaml {{words=1500}}\`

- Remove a field and its continuation lines from some files:

\`frontmatter-set {{path/to/file1.md path/to/file2.md}} --unset {{review_note}}\`

- Write the changes, only if nothing differs from the dry run you reviewed:

\`frontmatter-set {{path/to/folder}} --set {{status=closed}} --go --plan {{plan_hex}}\`

- Preview with one line per file:

\`frontmatter-set {{path/to/folder}} --set {{status=closed}} --brief\``;

// ---- verdict semantics (the single source of truth) -------------------------
//
// Every item ends up with one of five verdicts: ok, warn, skip, refuse, fail.
// verdict() is the ONLY place the mapping from facts to a verdict lives.
//   outcome 'change'   the file has (or would have) edits          -> ok
//   outcome 'skip'     already so / --where not met / no frontmatter / held -> skip
//   outcome 'refused'  unreadable, invalid, or failed the re-parse guard -> refuse
//   item.error         the write itself failed                      -> fail

//   outcome 'change' with item.warn (a replace that changes a type) -> warn
function verdict(item) {
  if (item.error) return 'fail';
  if (item.outcome === 'refused') return 'refuse';
  if (item.outcome === 'skip') return 'skip';
  if (item.warn) return 'warn';
  return 'ok';
}

// ---- environment check ------------------------------------------------------

function checkEnvironment() {
  return dependencyError ? { ok: false, message: dependencyError } : { ok: true };
}

// ---- the spec: --set, --unset, --where --------------------------------------

// Control characters a value or key may not hold: C0 but TAB, DEL, C1, and the
// Unicode line and paragraph separators (YAML or a line-based reader could
// take them as a line break; the yaml stringifier writes them raw).
const BAD_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

// A key, checked: no surrounding whitespace, no line break or control
// character; NFC-normalised, so it matches the file's key in either form.
function checkKey(flag, key) {
  if (/[\r\n]/.test(key)) throw new Error(`${flag}: a key cannot contain a line break`);
  if (BAD_CHARS.test(key)) throw new Error(`${flag}: a key cannot contain a control character`);
  if (key !== key.trim()) throw new Error(`${flag} ${JSON.stringify(key)}: a key cannot start or end with whitespace`);
  return key.normalize('NFC');
}

// "key=value" -> { key, value }, split at the first "=". Throws a usage message.
function splitPair(flag, text) {
  const at = text.indexOf('=');
  if (at <= 0) throw new Error(`${flag} takes key=value (got \`${text}\`)`);
  const key = checkKey(flag, text.slice(0, at));
  const value = text.slice(at + 1);
  if (/[\r\n]/.test(value)) throw new Error(`${flag} ${key}: a value must be one line (a line break was given)`);
  if (BAD_CHARS.test(value)) throw new Error(`${flag} ${key}: a value cannot contain a control character (U+0000-U+001F but tab, U+007F-U+009F, U+2028, U+2029)`);
  return { key, value };
}

// --set-yaml key=<yaml>: the value parsed as YAML (1.2 core schema); only a
// plain number, boolean, null or string is taken. Throws a usage message.
function yamlPair(text) {
  const pair = splitPair('--set-yaml', text);
  if (!YAML) environmentError(dependencyError);
  const doc = YAML.parseDocument(pair.value);
  if (doc.errors.length) throw new Error(`--set-yaml ${pair.key}: the value does not parse as YAML (${yamlProblem(doc.errors[0])})`);
  const node = doc.contents;
  // Nothing, or a bare --- or ... (a document marker): no value was given.
  // null and ~ are the ways to ask for null.
  if (node === null || (YAML.isScalar(node) && node.value === null && node.source === '')) {
    throw new Error(`--set-yaml ${pair.key}: no value was given; write null or ~ for a null, or use --set ${pair.key}= for an empty string`);
  }
  if (!YAML.isScalar(node) || node.tag || node.anchor) {
    throw new Error(`--set-yaml ${pair.key}: the value must be a number, boolean, null or string (no map, sequence, alias, tag or anchor)`);
  }
  if (node.comment || node.commentBefore || doc.comment || doc.commentBefore) {
    throw new Error(`--set-yaml ${pair.key}: the value carries a YAML comment, which would be dropped; use --set to write the text with its #`);
  }
  const value = node.value;
  if (!(value === null || ['number', 'boolean', 'string'].includes(typeof value))) {
    throw new Error(`--set-yaml ${pair.key}: the value must be a number, boolean, null or string`);
  }
  if (typeof value === 'string' && (/[\r\n]/.test(value) || BAD_CHARS.test(value))) {
    throw new Error(`--set-yaml ${pair.key}: the value cannot contain a line break or a control character`);
  }
  // A JavaScript number holds integers exactly only up to 2^53; past that the
  // written digits would silently differ from the ones given.
  if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Error(`--set-yaml ${pair.key}: ${pair.value.trim()} is too large to write exactly as a number; use --set to write it as a string`);
  }
  // A finite number given that reads as infinite (1e400) or as zero (1e-400)
  // would be written as .inf or 0; .inf and .nan given as such are kept.
  const source = String(node.source);
  if (typeof value === 'number' && ((!Number.isFinite(value) && !/^[-+]?\.(inf|Inf|INF|nan|NaN|NAN)$/.test(source))
    || (value === 0 && /[1-9]/.test(source.replace(/[eE][-+]?\d+$/, ''))))) {
    throw new Error(`--set-yaml ${pair.key}: ${source} is too large or too small to write as a number; use --set to write it as a string`);
  }
  // A number written in another form than given (1.10 as 1.1, 0x1F as 31) is a warn.
  const rewritten = typeof value === 'number' && setText(value) !== source ? `${pair.key}: ${source} is written as ${setText(value)}` : null;
  return { key: pair.key, value, typed: true, rewritten };
}

// The parsed flags -> { sets, unsets, wheres }, or a usage message thrown.
// A --set-yaml is a set whose value may be a number, boolean or null.
function buildSpec({ set = [], unset = [], where = [], 'set-yaml': setYaml = [] }) {
  const sets = [...set.map((s) => splitPair('--set', s)), ...setYaml.map(yamlPair)];
  const wheres = where.map((s) => splitPair('--where', s));
  const unsets = unset.map((key) => {
    if (!key) throw new Error('--unset takes a key');
    return checkKey('--unset', key);
  });
  if (!sets.length && !unsets.length) throw new Error('nothing to do: give at least one --set key=value, --set-yaml key=value or --unset key');
  const seen = new Set();
  for (const { key } of sets) {
    if (seen.has(key)) throw new Error(`${key} is set twice (by --set or --set-yaml)`);
    seen.add(key);
  }
  for (const key of unsets) {
    if (seen.has(key)) throw new Error(`${key} is in both --set and --unset (or --unset is given twice)`);
    seen.add(key);
  }
  return { sets, unsets, wheres };
}

// ---- writing a value as a YAML scalar ---------------------------------------

// The yaml package's own stringifier decides the quoting. Version 1.1 rules
// make it quote what an older parser would misread too: yes, no, on, off, y, n,
// a date, a number. lineWidth 0 keeps a long value on one line. A plain form
// that either YAML 1.1 or 1.2 reads as anything but this string (0o17 is an
// octal under 1.2) is double-quoted instead.
function scalarText(value) {
  const text = YAML.stringify(value, { lineWidth: 0, version: '1.1' }).replace(/\n$/, '');
  if (YAML.parse(text) === value && YAML.parse(text, { version: '1.1' }) === value) return text;
  return YAML.stringify(value, { lineWidth: 0, version: '1.1', defaultStringType: 'QUOTE_DOUBLE' }).replace(/\n$/, '');
}

// The text a set writes: a string as scalarText() quotes it; a --set-yaml
// number, boolean or null as its canonical YAML text (150000, true, null).
function setText(value) {
  return typeof value === 'string' ? scalarText(value) : YAML.stringify(value).replace(/\n$/, '');
}

// ---- the frontmatter, located -----------------------------------------------

// Lines with their endings kept: "a\r\nb" -> ["a\r\n", "b"].
const splitLines = (text) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
const eolOf = (line) => (line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : '');
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Find the frontmatter block in a file's text. Returns { none: reason } when
// there is none, else { bom, lines, close } where lines[0] is the opening
// fence and lines[close] the closing one.
function locateFrontmatter(rawText) {
  const bom = rawText.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const lines = splitLines(rawText.slice(bom.length));
  if (!lines.length || !/^---[ \t]*\r?\n$/.test(lines[0])) return { none: 'the file does not start with a --- line' };
  const close = lines.findIndex((l, i) => i > 0 && /^---[ \t]*\r?\n?$/.test(l));
  if (close < 0) return { none: 'the opening --- has no closing ---' };
  return { bom, lines, close };
}

// A parser error as one line, with the line number in the file.
function yamlProblem(e) {
  const msg = String(e.message).replace(/ at line \d+, column \d+:?[\s\S]*$/, '').split('\n')[0];
  const line = e.linePos?.[0]?.line;
  return line ? `${msg} (line ${line + 1})` : msg;
}

// Parse frontmatter text. Returns { doc, obj } or { problem }.
function parseFrontmatter(fmText) {
  const doc = YAML.parseDocument(fmText);
  if (doc.errors.length) return { problem: yamlProblem(doc.errors[0]) };
  if (doc.contents === null) return { doc, obj: {} };
  if (!YAML.isMap(doc.contents)) return { problem: 'the frontmatter is not a mapping of keys to values' };
  if (doc.contents.flow) return { problem: 'the frontmatter is a flow mapping ({...}); only block style is edited' };
  let obj;
  try { obj = doc.toJS(); } catch (e) { return { problem: yamlProblem(e) }; }
  return { doc, obj };
}

// ---- the re-parse guard -----------------------------------------------------

// After an edit: parse the new frontmatter and check it says what was meant.
// Every untouched key deep-equal to before, each --set key equal to its new
// value, each --unset key gone, no key that was not there. Returns a problem
// string, or null when the edit holds.
// Keys are compared NFC-normalised, as the spec's keys are.
const nfcKeys = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.normalize('NFC'), v]));

function checkEdit(beforeRaw, afterFmText, { sets, unsets }) {
  const parsed = parseFrontmatter(afterFmText);
  if (parsed.problem) return `the edited frontmatter does not parse: ${parsed.problem}`;
  const beforeObj = nfcKeys(beforeRaw);
  const after = nfcKeys(parsed.obj);
  const setMap = new Map(sets.map((s) => [s.key, s.value]));
  for (const key of unsets) {
    if (Object.hasOwn(after, key)) return `${key} is still present after --unset`;
  }
  for (const [key, value] of setMap) {
    if (!Object.hasOwn(after, key)) return `${key} is missing after --set`;
    if (!isDeepStrictEqual(after[key], value)) return `${key} reads back as ${JSON.stringify(after[key])}, not the value set`;
  }
  for (const key of Object.keys(beforeObj)) {
    if (setMap.has(key) || unsets.includes(key)) continue;
    if (!Object.hasOwn(after, key)) return `the untouched key ${key} is gone after the edit`;
    if (!isDeepStrictEqual(beforeObj[key], after[key])) return `the untouched key ${key} reads differently after the edit`;
  }
  for (const key of Object.keys(after)) {
    if (!setMap.has(key) && !Object.hasOwn(beforeObj, key)) return `an unexpected key ${key} appeared after the edit`;
  }
  return null;
}

// ---- the edit ---------------------------------------------------------------

// A key's current value as text, or undefined for a list or mapping: a string
// is its parsed value; a number, boolean or null is its source text, exactly as
// written (`0123`, `~`, `null`; an empty value is "").
function valueText(obj, pair) {
  const cur = obj[pair.name];
  if (cur !== null && typeof cur === 'object') return undefined;
  if (typeof cur === 'string') return cur;
  const v = pair.node.value;
  if (YAML.isScalar(v)) return String(v.source ?? '');
  return v == null ? '' : String(cur);
}

// --where: does the file's current value of `key` equal `value`? A string is
// compared by its parsed value, anything else by its source text (see
// valueText). A list, a mapping, or a missing key never matches.
function whereHolds(obj, byName, { key, value }) {
  const pair = byName.get(key);
  if (!pair) return { ok: false, why: `no ${key} key` };
  const text = valueText(obj, pair);
  if (text === value) return { ok: true };
  return { ok: false, why: text === undefined ? `${key} is a list or mapping` : `${key} is ${JSON.stringify(text)}` };
}

// Where each top-level key lives, in lines: [{ name, node, startLine, endLine }].
function locatePairs(doc, fmLines) {
  const starts = [];
  let off = 0;
  for (const l of fmLines) { starts.push(off); off += l.length; }
  const lineAt = (offset) => {
    let lo = 0;
    for (let i = 0; i < starts.length; i += 1) { if (starts[i] <= offset) lo = i; else break; }
    return lo;
  };
  const pairs = [];
  for (const node of doc.contents?.items ?? []) {
    if (!YAML.isScalar(node.key)) continue;
    const keyStart = node.key.range[0];
    const valueEnd = node.value?.range ? node.value.range[1] : node.key.range[1];
    pairs.push({
      name: String(node.key.value), node, starts,
      startLine: lineAt(keyStart),
      endLine: lineAt(Math.max(valueEnd - 1, keyStart)),
      lineAt,
    });
  }
  return pairs;
}

// The replacement text for one key's line(s): the original text up to the old
// value (so the key's spelling, its spacing, a tag or an anchor stay), the new
// scalar, and a trailing comment when the old value sat alone on its line. The
// line ending is the last replaced line's own.
function replacementLine(pair, fmLines, value) {
  const line = fmLines[pair.startLine];
  const lineStart = pair.starts[pair.startLine];
  const v = pair.node.value;
  const keyEnd = pair.node.key.range[1];
  const valueOnKeyLine = v?.range && v.range[1] > v.range[0] && v.range[0] > keyEnd && pair.lineAt(v.range[0]) === pair.startLine;
  let prefix = valueOnKeyLine
    ? line.slice(0, v.range[0] - lineStart)
    : `${line.slice(0, keyEnd - lineStart)}:`;
  if (!/[ \t]$/.test(prefix)) prefix += ' ';
  let comment = '';
  if (valueOnKeyLine && pair.startLine === pair.endLine) {
    const rest = line.slice(v.range[1] - lineStart).replace(/\r?\n$/, '');
    if (/^[ \t]*#/.test(rest)) comment = rest;
  } else if (!valueOnKeyLine) {
    // An empty value, or one on the next lines: a comment after the colon stays.
    const after = /^[ \t]*:([ \t]+#.*)$/.exec(line.slice(keyEnd - lineStart).replace(/\r?\n$/, ''));
    if (after) comment = after[1];
  }
  const eol = eolOf(fmLines[pair.endLine]) || '\n';
  return `${prefix}${setText(value)}${comment}${eol}`;
}

// Edit one file's text. Returns { outcome:'skip', summary, reason } or
// { outcome:'refused', summary, reason } or { outcome:'change', text, edits }.
function editText(rawText, spec) {
  const loc = locateFrontmatter(rawText);
  if (loc.none) return { outcome: 'skip', summary: 'no frontmatter', reason: loc.none };
  const { bom, lines, close } = loc;
  const fmLines = lines.slice(1, close);
  const fmText = fmLines.join('');

  const parsed = parseFrontmatter(fmText);
  if (parsed.problem) return { outcome: 'refused', summary: 'invalid frontmatter', reason: parsed.problem };
  const { doc, obj } = parsed;

  // Keys by their NFC form, so an NFD key in the file is the key the spec names.
  const pairs = locatePairs(doc, fmLines);
  const byName = new Map();
  for (const p of pairs) {
    const nfc = p.name.normalize('NFC');
    if (byName.has(nfc)) return { outcome: 'refused', summary: 'duplicate key', reason: `the key ${nfc} appears twice once Unicode-normalised (NFC)` };
    byName.set(nfc, p);
  }

  for (const cond of spec.wheres) {
    const held = whereHolds(obj, byName, cond);
    if (!held.ok) {
      return { outcome: 'skip', summary: 'where not met', reason: `--where ${cond.key}=${cond.value}: ${held.why}` };
    }
  }

  const replaces = []; // { pair, value }
  const removes = []; // pair
  const inserts = []; // { key, value }
  const edits = [];
  const warnings = [];
  const typeName = (v) => (v === null ? 'null' : Array.isArray(v) ? 'list' : typeof v === 'object' ? 'mapping' : typeof v);
  for (const { key, value, typed, rewritten } of spec.sets) {
    const pair = byName.get(key);
    if (!pair) {
      inserts.push({ key, value }); edits.push({ key, action: 'insert' });
      if (rewritten) warnings.push(rewritten);
      continue;
    }
    const cur = obj[pair.name];
    if (cur === value) continue; // already so
    const curScalar = ['number', 'boolean', 'string'].includes(typeof cur);
    // already so: a --set text that is exactly how the number or boolean is written
    if (!typed && curScalar && typeof cur !== 'string' && valueText(obj, pair) === value) continue;
    // A type change is a warn; filling an empty or null value is not.
    if (cur !== null && typeName(cur) !== typeName(value)) {
      const was = curScalar ? `the ${typeof cur} ${typeof cur === 'string' ? JSON.stringify(cur) : valueText(obj, pair)}` : `a ${typeName(cur)}`;
      const now = typeof value === 'string' ? 'a string' : value === null ? 'null' : `the ${typeName(value)} ${setText(value)}`;
      warnings.push(`${key} was ${was} and is written as ${now}`);
    }
    if (rewritten) warnings.push(rewritten);
    replaces.push({ pair, value });
    edits.push({ key, action: 'replace' });
  }
  for (const key of spec.unsets) {
    const pair = byName.get(key);
    if (!pair) continue;
    removes.push(pair);
    edits.push({ key, action: 'unset' });
  }
  if (!edits.length) return { outcome: 'skip', summary: 'already so', reason: 'every field already has the requested state' };

  // Replacements and removals, last line first so earlier line numbers stay put.
  const out = fmLines.slice();
  const fixed = [
    ...replaces.map(({ pair, value }) => ({ pair, text: replacementLine(pair, fmLines, value) })),
    ...removes.map((pair) => ({ pair, text: null })),
  ].sort((a, b) => b.pair.startLine - a.pair.startLine);
  for (const { pair, text } of fixed) {
    out.splice(pair.startLine, pair.endLine - pair.startLine + 1, ...(text === null ? [] : [text]));
  }
  // Insertions go just before the closing fence, indented like the first key.
  const indent = pairs.length ? /^[ \t]*/.exec(fmLines[pairs[0].startLine])[0] : '';
  const insertEol = eolOf(fmLines[fmLines.length - 1] ?? '') || eolOf(lines[0]) || '\n';
  for (const { key, value } of inserts) out.push(`${indent}${scalarText(key)}: ${setText(value)}${insertEol}`);

  const problem = checkEdit(obj, out.join(''), spec);
  if (problem) return { outcome: 'refused', summary: 're-parse check failed', reason: `${problem}; the file was left alone` };

  const text = bom + lines[0] + out.join('') + lines.slice(close).join('');
  const before = lines.slice(0, close).join('');
  const after = lines[0] + out.join('');
  return { outcome: 'change', text, edits, warnings, region: { before, after } };
}

// A unified-style diff of the changed lines, one line of context, no header.
function diffOf(region) {
  const patch = diffLib.createPatch('f', region.before, region.after, '', '', { context: 1 });
  const body = patch.slice(patch.indexOf('@@'));
  return body.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => !l.startsWith('\\')).join('\n').replace(/\n+$/, '');
}

// ---- files and folders ------------------------------------------------------

// Each argument -> entries { path } (a file, as given) or { path, problem } (a
// reason there is nothing to edit). A folder yields its *.md files, not
// recursive, in name order. The same file twice is edited once: the same
// device and inode, so two hard-link names or two letter cases are one file.
function expandPaths(args) {
  const entries = [];
  const seen = new Set();
  const add = (path) => {
    let id;
    try { const st = statSync(path); id = `${st.dev}:${st.ino}`; } catch { id = resolve(path); }
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({ path });
  };
  for (const arg of args) {
    let st;
    try { st = statSync(arg); } catch (e) {
      entries.push({ path: arg, problem: e.code === 'ENOENT' ? { summary: 'no such path', reason: 'path does not exist' } : { summary: 'cannot stat', reason: e.message } });
      continue;
    }
    if (st.isDirectory()) {
      let names;
      try { names = readdirSync(arg).filter((n) => /\.md$/i.test(n) && !n.startsWith('.')).sort(); } catch (e) {
        entries.push({ path: arg, problem: { summary: 'cannot read folder', reason: e.message } });
        continue;
      }
      const files = names.map((n) => join(arg, n)).filter((p) => { try { return statSync(p).isFile(); } catch { return false; } });
      if (!files.length) entries.push({ path: arg, empty: true });
      for (const f of files) add(f);
    } else if (st.isFile()) {
      add(arg);
    } else {
      entries.push({ path: arg, problem: { summary: 'not a regular file', reason: 'special file (device/socket/pipe)' } });
    }
  }
  return entries;
}

function newItem(path) {
  return { command: 'apply', path, name: path, kind: 'file', reason: '', changed: false, data: { kind: 'file', diff: null } };
}

function keysSummary(edits, verb) {
  const keys = edits.map((e) => e.key);
  const shown = keys.slice(0, 3).join(', ');
  return `${verb} ${shown}${keys.length > 3 ? ` +${keys.length - 3} more` : ''}`;
}

// Plan one file: read it, work out the edit, change nothing on disk. The item
// carries `oldBytes` and `newBytes` (not in --json) for the plan digest and the write.
function planOne(entry, spec) {
  const item = newItem(entry.path);
  const finish = () => { item.verdict = verdict(item); return item; };
  if (entry.empty) {
    Object.assign(item, { kind: 'directory', outcome: 'skip', summary: 'no .md files', reason: 'the folder holds no *.md files (not recursive)' });
    item.data = { kind: 'directory', diff: null };
    return finish();
  }
  if (entry.problem) {
    Object.assign(item, { outcome: 'refused', summary: entry.problem.summary, reason: entry.problem.reason });
    return finish();
  }
  let bytes;
  try { bytes = readFileSync(entry.path); } catch (e) {
    Object.assign(item, { outcome: 'refused', summary: 'cannot read', reason: e.message });
    return finish();
  }
  item.oldBytes = bytes;
  item.data.sha256 = sha256(bytes);
  let text;
  if (bytes.includes(0)) {
    Object.assign(item, { outcome: 'refused', summary: 'binary file', reason: 'the file holds a NUL byte, so it is not Markdown text' });
    return finish();
  }
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch {
    Object.assign(item, { outcome: 'refused', summary: 'not UTF-8', reason: 'the file is not valid UTF-8 text' });
    return finish();
  }
  const result = editText(text, spec);
  item.outcome = result.outcome;
  item.summary = result.summary ?? '';
  item.reason = result.reason ?? '';
  if (result.outcome === 'change') {
    try { accessSync(entry.path, fsConstants.W_OK); } catch (e) {
      Object.assign(item, { outcome: 'refused', summary: 'not writable', reason: `the file cannot be written (${e.code ?? e.message}); it was left alone` });
      return finish();
    }
    if (result.warnings.length) Object.assign(item, { warn: true, reason: result.warnings.join('; ') });
    item.newBytes = Buffer.from(result.text, 'utf8');
    item.edits = result.edits;
    item.summary = keysSummary(result.edits, 'would change');
    const diff = diffOf(result.region);
    item.data.diff = diff;
    item.data.edits = result.edits;
    item.data.sha256After = sha256(item.newBytes);
    item.lines = diff.split('\n');
  }
  return finish();
}

// ---- the plan digest --------------------------------------------------------

// JSON with every object's keys sorted: one plan, one string.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// 16 hex characters of sha256 over every target: its real path, the sha256 of
// the bytes read, and the sha256 of the bytes that would be written (null when
// nothing would be), or why it is refused. A dry run and a --go of the same
// edits over the same files compute the same digest; any change makes another.
function planDigest(items) {
  const record = items.filter((it) => it.kind !== 'plan').map((it) => {
    let real;
    try { real = realpathSync(it.path); } catch { real = resolve(it.path); }
    return {
      path: real,
      before: it.oldBytes ? sha256(it.oldBytes) : null,
      after: it.newBytes ? sha256(it.newBytes) : null,
      problem: it.outcome === 'refused' ? it.summary : null,
    };
  });
  return sha256(canonicalJson({ v: 1, files: record })).slice(0, 16);
}

const PLAN_HEX = /^[0-9a-f]{16}$/;

function planChangedItem(expected, actual) {
  const item = {
    command: 'apply', kind: 'plan', path: '', name: `plan ${expected}`, changed: false, outcome: 'refused',
    summary: 'plan changed since the dry run',
    reason: `the plan is ${actual} now, so the files or the edits differ from the dry run; nothing was written: run the dry run again and review it`,
    data: { expected, actual },
  };
  item.verdict = verdict(item);
  return item;
}

// The dry run's argv: this one without --go and --plan <hex> (or --plan=<hex>).
function dryRunArgv(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--go') continue;
    if (argv[i] === '--plan') { i += 1; continue; }
    if (argv[i].startsWith('--plan=')) continue;
    out.push(argv[i]);
  }
  return out;
}

// ---- the write --------------------------------------------------------------

// The backup root: $FRONTMATTER_SET_BACKUP_DIR when set (the tests set it),
// else ~/Library/Application Support/frontmatter-set/backup on macOS and
// $XDG_STATE_HOME/frontmatter-set/backup elsewhere (~/.local/state when it is
// unset or relative, as the XDG spec says). Never cleaned by the tool.
function backupRoot() {
  if (process.env.FRONTMATTER_SET_BACKUP_DIR) return resolve(process.env.FRONTMATTER_SET_BACKUP_DIR);
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'frontmatter-set', 'backup');
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'state'), 'frontmatter-set', 'backup');
}

// This run's backup folder under the root, <YYYY-MM-DD>/<HHMMSS>-<pid>, fixed
// at the run's first backup.
const pad2 = (n) => String(n).padStart(2, '0');
let runFolder = null;
const thisRun = () => {
  if (!runFolder) {
    const d = new Date();
    runFolder = join(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}-${process.pid}`);
  }
  return runFolder;
};

// Copy the file to <root>/<YYYY-MM-DD>/<HHMMSS>-<pid>/<folder name>-<8 hex of
// its folder's path>/<name>: one folder per run, so every backup keeps its
// file's own name, and two a.md from two folders never meet. A name already
// taken is never overwritten (the backup fails). The copy is read back against
// the bytes the edit was planned on. Returns the backup's path. `copy` is for
// the tests.
function backupOne(real, bytes, copy = copyFileSync) {
  const dir = dirname(real);
  const folder = join(backupRoot(), thisRun(), `${basename(dir).slice(0, 40) || 'root'}-${sha256(dir).slice(0, 8)}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const dest = join(folder, basename(real));
  copy(real, dest, fsConstants.COPYFILE_EXCL);
  if (!readFileSync(dest).equals(bytes)) throw new Error(`the backup ${dest} does not hold the file's bytes`);
  return dest;
}

// Every byte from the start of an open file.
function readAll(fd) {
  const size = fstatSync(fd).size;
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, off);
    if (!n) break;
    off += n;
  }
  return buf.subarray(0, off);
}

// Write every byte from the start, looping until done, cut the file to that
// length, and flush.
function writeAll(fd, bytes) {
  let off = 0;
  while (off < bytes.length) {
    const n = writeSync(fd, bytes, off, bytes.length - off, off);
    if (!n) throw new Error('the write made no progress');
    off += n;
  }
  ftruncateSync(fd, bytes.length);
  fsyncSync(fd);
}

// In place, after a backup: open the file for update (a symlink is followed),
// check it still holds the bytes planned on, copy it to the backup folder,
// rewrite it (same inode, so its mode, extended attributes, flags, creation
// date and hard links stay), then read it back. A file that does not read back
// as written is rewritten from the backup and the item fails, naming the
// backup. `readBack`, `write` and `copy` are for the tests.
function writeOne(item, { readBack = readAll, write = writeAll, copy = copyFileSync } = {}) {
  const failWith = (summary, message) => { item.error = message; item.summary = summary; item.reason = message; };
  let fd;
  try { fd = openSync(item.path, 'r+'); } catch (e) {
    failWith('write failed', `${e.message}; nothing was written`);
    return;
  }
  let backup = null;
  try {
    if (!readAll(fd).equals(item.oldBytes)) {
      failWith('changed underneath', 'the file changed while the tool was running; nothing was written to it');
      return;
    }
    try { backup = backupOne(realpathSync(item.path), item.oldBytes, copy); } catch (e) {
      failWith('backup failed', `${e.message}; nothing was written`);
      return;
    }
    item.data.backup = backup;
    write(fd, item.newBytes);
    if (!readBack(fd).equals(item.newBytes)) {
      writeAll(fd, readFileSync(backup));
      failWith('write did not verify', readBack(fd).equals(item.oldBytes)
        ? `the file did not read back as written, so it was restored from the backup ${backup}`
        : `the file did not read back as written, and the restore did not either; the original is in the backup ${backup}`);
      return;
    }
    item.changed = true;
    item.summary = keysSummary(item.edits, 'changed');
    item.reason = `${item.warn ? `${item.reason}; ` : ''}the original is backed up to ${backup}`;
  } catch (e) {
    if (!backup) { failWith('write failed', e.message); return; }
    // The write may have stopped partway (a full disk, a file-size limit):
    // put the original back from the backup and say whether that worked.
    let restored = false;
    try { writeAll(fd, readFileSync(backup)); restored = readAll(fd).equals(item.oldBytes); } catch { /* reported below */ }
    failWith('write failed', restored
      ? `${e.message}; the file was restored from the backup ${backup}`
      : `${e.message}; the restore did not complete either; the original is in the backup ${backup}`);
  } finally {
    closeSync(fd);
  }
}

// ---- contract hooks (the fenced runtime below relies on these) --------------

const MUTATING_COMMANDS = new Set(['apply']);

// Empty: a clean dry run is `ask`. The tool edits files in place, so going on
// to --go is a person's or a runbook's decision, never the tool's own advice.
const AUTO_RUN_COMMANDS = new Set();

// --plan is not an override: it only narrows --go. Nothing else.
const EXTRA_OVERRIDE_FLAGS = [];
const GO_ALIASES = [];

function nextAction(run) {
  const next = defaultNextAction(run);
  if (next.action === 'stop') return next; // a failure outranks everything
  const { items, effect, argv, state } = run;
  if (items.some((it) => it.kind === 'plan')) {
    const why = 'the plan changed since the dry run; nothing was written; run the dry run again and review it';
    return argv.some(isOverrideFlag) ? nextStep('ask', why) : nextStep('ask', why, { argv: rerunArgv(dryRunArgv(argv)) });
  }
  if (effect !== 'dry-run') return next;
  if (argv.some(isOverrideFlag)) return next;
  const s = summarize(items);
  const writing = items.filter((it) => it.outcome === 'change');
  if (!writing.length) {
    return s.refuse
      ? nextStep('ask', `dry run: nothing would change and ${count(s.refuse, 'file')} refused; fix those and run the dry run again`)
      : nextStep('done', 'dry run: nothing would change');
  }
  const refused = s.refuse ? `; ${count(s.refuse, 'file')} refused and left alone` : '';
  // The --go offered carries the plan digest, so it writes only what this dry run showed.
  return nextStep('ask', `dry run: ${count(writing.length, 'file')} would change${refused}`, { argv: rerunArgv(argv, '--go', '--plan', state.plan) });
}

// ---- CLI --------------------------------------------------------------------

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean' },
        cheat: { type: 'boolean' },
        brief: { type: 'boolean' },
        json: { type: 'boolean' },
        quiet: { type: 'boolean' },
        go: { type: 'boolean' },
        plan: { type: 'string' },
        set: { type: 'string', multiple: true },
        unset: { type: 'string', multiple: true },
        where: { type: 'string', multiple: true },
        'set-yaml': { type: 'string', multiple: true },
      },
    });
  } catch (e) {
    usageError(e.message);
  }
  const { values, positionals } = parsed;

  if (values.help) {
    console.log(helpText());
    return;
  }
  if (values.version) {
    console.log(`${TOOL_NAME} ${readVersion()}`);
    return;
  }
  if (values.cheat) {
    for (const mode of ['brief', 'json', 'quiet']) {
      if (values[mode]) usageError(`--cheat and --${mode} cannot be combined`);
    }
    console.log(CHEAT);
    return;
  }

  const mode = outputMode(values);

  if (positionals.length === 0) usageError('needs at least one <file|dir>');
  let spec;
  try { spec = buildSpec(values); } catch (e) { usageError(e.message); }
  if (values.plan !== undefined && !PLAN_HEX.test(values.plan)) {
    usageError('--plan takes the 16 lowercase hex characters a dry run reports (state.plan in --json)');
  }
  if (values.plan !== undefined && !values.go) usageError('--plan only applies with --go: it checks the plan the dry run showed before writing');

  const env = checkEnvironment();
  if (!env.ok) environmentError(env.message);

  const go = !!values.go;
  const items = expandPaths(positionals).map((entry) => planOne(entry, spec));
  const state = { plan: planDigest(items) };

  let writable = true;
  if (go && values.plan !== undefined && values.plan !== state.plan) {
    writable = false;
    for (const item of items) {
      if (item.outcome !== 'change') continue;
      item.outcome = 'skip';
      item.summary = 'held back';
      item.reason = 'the plan changed since the dry run, so nothing was written';
      item.verdict = verdict(item);
    }
    items.push(planChangedItem(values.plan, state.plan));
  }
  if (go && writable) {
    for (const item of items) {
      if (item.outcome !== 'change') continue;
      writeOne(item);
      item.verdict = verdict(item);
    }
  }

  const command = 'apply';
  const effect = effectFor(command, go);
  const argv = process.argv.slice(2);
  const next = nextAction({ command, items, effect, state, argv });
  // The end of the run: the runtime exits with the reported code once stdout
  // has flushed, so every file write is finished before this line. Never
  // process.exit() after output, which drops what a pipe has not yet taken.
  report({ command, effect, items, next, state, mode, argv });
}

export {
  verdict, nextAction, editText, checkEdit, scalarText, buildSpec, expandPaths, planOne, planDigest, writeOne,
  MUTATING_COMMANDS, AUTO_RUN_COMMANDS, EXTRA_OVERRIDE_FLAGS, GO_ALIASES,
  glyph, briefLine, jsonItem, summarize, exitCodeFor, effectFor,
  nextStep, rerunArgv, defaultNextAction, assertSafeNext, nextLine, report,
};

// ---- mjs-tool runtime v3 (do not edit; replace wholesale) ----
// The shared machinery of contract mjs-tool/3, byte-identical in every tool
// built from mjs-tool-skeleton. It carries its own imports (namespaced, so they
// never collide with the tool's); its other top-level names are unprefixed, so
// a tool keeps no copies of them. The tool supplies, outside this block:
// MUTATING_COMMANDS, AUTO_RUN_COMMANDS, EXTRA_OVERRIDE_FLAGS, GO_ALIASES,
// main(), and a nextAction() policy whose result it hands to report(); the
// block checks their shapes as it loads. To move a tool to a later contract,
// swap this whole block.

import * as runtimeFs from 'node:fs';
import * as runtimePath from 'node:path';
import * as runtimeUrl from 'node:url';

const CONTRACT = 'mjs-tool/3';

// The realpath of this script, so a symlinked (npm-linked) invocation still
// reports the right name/version and finds its own header for --help.
const SCRIPT_PATH = (() => {
  const self = runtimeUrl.fileURLToPath(import.meta.url);
  try { return runtimeFs.realpathSync(self); } catch { return self; }
})();
const TOOL_NAME = runtimePath.basename(SCRIPT_PATH).replace(/\.mjs$/, '');

// The directory the run started in (next.cwd), read once as the module loads,
// so a run that removes its own working directory still reports. If it was
// gone before the start, the shell's $PWD stands in (or / without one).
const START_CWD = (() => {
  try { return process.cwd(); } catch {
    const pwd = process.env.PWD;
    return pwd && runtimePath.isAbsolute(pwd) ? pwd : '/';
  }
})();

// -- verdicts: symbols, counts, exit code

const GLYPH = { ok: '✓', warn: '⚠', skip: '•', refuse: '⊘', fail: '✗' };
function glyph(v) { return GLYPH[v] || '?'; }

function summarize(items) {
  const s = { ok: 0, warn: 0, skip: 0, refuse: 0, fail: 0 };
  for (const it of items) if (it.verdict in s) s[it.verdict] += 1;
  return s;
}

// 0 all ok (skips are not failures), 1 partial. The other two codes exit
// through usageError() (2), environmentError() and the entry guard (3).
function exitCodeFor(items) {
  const s = summarize(items);
  return s.warn || s.refuse || s.fail ? 1 : 0;
}

// -- effect: what this run was allowed to do to the world. An applied run may
// still change nothing (every item refused); the items' `changed` says what did.

function effectFor(command, go) {
  if (!MUTATING_COMMANDS.has(command)) return 'read-only';
  return go ? 'applied' : 'dry-run';
}

// -- next: the advice on the next step

// Who takes each action, derived and never chosen: run, wait and done are the
// agent's; ask and stop hand the run to a person.
const NEXT_WHO = { done: 'agent', run: 'agent', wait: 'agent', ask: 'human', stop: 'human' };
const NEXT_ACTIONS = Object.keys(NEXT_WHO);
const NEXT_KEYS = ['action', 'who', 'argv', 'afterSeconds', 'why', 'cwd'];
// Rule 4: the advice never contradicts the exit code, which stays authoritative.
// Exit 0 allows ask: a clean run can still end at a person's decision.
const ACTIONS_FOR_EXIT = { 0: ['done', 'run', 'wait', 'ask'], 1: NEXT_ACTIONS, 2: ['stop'], 3: ['stop'] };
// Rule 2: a flag that confirms or overrides a gate never appears in next.argv.
// Long flags match case-insensitively: the built-in classes by prefix (so
// --yes-really and --forced), --allow and the tool's EXTRA_OVERRIDE_FLAGS
// exactly, with or without =value. An EXTRA_OVERRIDE_FLAGS entry may also be a
// bare word, which blocks that verb. --no-yes and --iamdan are not listed:
// parseArgs rejects them as unknown options, so no run could carry them.
const OVERRIDE_FLAGS = ['--allow'];
const OVERRIDE_PREFIXES = ['--yes', '--force', '--assume-yes', '--allow-', '--i-am-'];

function isOverrideFlag(token) {
  const t = String(token);
  const lower = t.toLowerCase();
  const isFlag = (f) => lower === f || lower.startsWith(`${f}=`);
  if (OVERRIDE_FLAGS.some(isFlag) || OVERRIDE_PREFIXES.some((p) => lower.startsWith(p))) return true;
  if (/^-[A-Za-z]*[yY][A-Za-z]*$/.test(t)) return true; // -y or -Y (the short --yes), alone or grouped
  return EXTRA_OVERRIDE_FLAGS.some((f) => (/^-[A-Za-z]$/.test(f)
    ? new RegExp(`^-[A-Za-z]*${f[1]}[A-Za-z]*$`).test(t) // a declared short flag, alone or grouped
    : isFlag(String(f).toLowerCase())));
}

// A --go alias the tool declares in GO_ALIASES, matched as a declared override
// flag is: a long one in any case, with or without =value; a short one alone or
// grouped. Aliases are input only: advice spells --go, which the checks read.
function isGoAlias(token) {
  const t = String(token);
  const low = t.toLowerCase();
  return GO_ALIASES.some((f) => (/^-[A-Za-z]$/.test(f)
    ? new RegExp(`^-[A-Za-z]*${f[1]}[A-Za-z]*$`).test(t)
    : low === f.toLowerCase() || low.startsWith(`${f.toLowerCase()}=`)));
}

// A next object with the fixed field set. `who` follows from the action and
// `cwd` is START_CWD, so neither is an option. `why` is escaped (a filename in
// it cannot break the line) and clipped, here rather than refused by the
// guard, which runs after the work is done.
function nextStep(action, why, options = {}) {
  const { argv = null, afterSeconds = null, ...rest } = options;
  if (Object.keys(rest).length) {
    throw new Error(`nextStep() takes argv and afterSeconds only, not ${Object.keys(rest).join(', ')}: who and cwd are derived`);
  }
  const line = typeof why === 'string' ? clipText(printable(why), 200) : why;
  return { action, who: NEXT_WHO[action] ?? null, argv, afterSeconds, why: line, cwd: START_CWD };
}

// The head of every re-run argv: this node, then this script as invoked, made
// absolute but not realpath'd (an npm-linked bin stays its bin path). Running
// the script through node needs no executable bit and no PATH lookup.
function selfArgv() {
  return [process.execPath, __entry === SCRIPT_PATH ? runtimePath.resolve(process.argv[1]) : SCRIPT_PATH];
}

// This tool's own command line again, as an argv array, with flags inserted
// before any `--` (after it they would be positionals).
function rerunArgv(argv, ...extra) {
  const end = argv.indexOf('--');
  return end < 0 ? [...selfArgv(), ...argv, ...extra] : [...selfArgv(), ...argv.slice(0, end), ...extra, ...argv.slice(end)];
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

// At most `max` characters of text, then … if any were cut.
function clipText(text, max) {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

// Names for `why` (which nextStep() escapes): each clipped to 80 characters,
// at most `max` of them within about 120, then a count of the rest, so the
// count survives the clip on the whole.
function listNames(items, max = 3) {
  const names = [];
  let length = 0;
  for (const it of items) {
    const name = clipText(String(it.name), 80);
    if (names.length === max || (names.length && length + name.length > 120)) break;
    names.push(name);
    length += name.length + 2;
  }
  const rest = items.length - names.length;
  return rest ? `${names.join(', ')} and ${rest} more` : names.join(', ');
}

// The generic policy (rule 3). A tool's nextAction() starts here and adds what
// only it knows. Pure: reads the command, the items, the effect and the argv.
function defaultNextAction({ command, items, effect, argv }) {
  const s = summarize(items);
  const findings = s.warn + s.refuse + s.fail;
  if (s.fail) {
    return nextStep('stop', `failed: ${listNames(items.filter((it) => it.verdict === 'fail'))}`);
  }
  if (effect === 'read-only') {
    return nextStep('done', findings ? `read-only: report the ${count(findings, 'finding')}` : 'read-only: nothing to apply');
  }
  if (effect === 'dry-run') {
    if (argv.some(isOverrideFlag)) {
      return nextStep('ask', 'the command carried an override flag, which next never repeats; a person decides');
    }
    if (s.warn || s.refuse) {
      return nextStep('ask', `dry run: review the ${count(s.warn + s.refuse, 'finding')} before --go`, { argv: rerunArgv(argv, '--go') });
    }
    if (!s.ok) return nextStep('done', 'dry run: nothing would change');
    // A clean dry run goes on to --go unattended only for a command the tool
    // has pre-approved in AUTO_RUN_COMMANDS; for any other it is a person's call.
    const action = AUTO_RUN_COMMANDS.has(command) ? 'run' : 'ask';
    return nextStep(action, `dry run clean: ${count(s.ok, 'item')} would change`, { argv: rerunArgv(argv, '--go') });
  }
  const changed = items.filter((it) => it.changed).length;
  return nextStep('done', findings
    ? `applied: ${changed} changed; report the ${count(findings, 'finding')}`
    : `applied: ${changed} changed`);
}

// Rules 2 and 4 (and the fixed shape), enforced on every `next` before it is
// rendered. A violation throws, and the run exits 3: a tool cannot ship advice
// that walks an agent past a gate, and its tests meet the violation first.
// `current` is the run the advice follows: its effect, and the argv it handed
// nextAction(). report() passes it, so a run goes to --go only on what that
// run just previewed; without it, no run may carry --go.
function assertSafeNext(next, exit, current = {}) {
  const unsafe = (why) => { throw new Error(`unsafe next: ${why}`); };
  if (next === null) return;
  if (!next || typeof next !== 'object' || Array.isArray(next)) unsafe('nextAction() must return a next object or null');
  const keys = Object.keys(next);
  if (keys.length !== NEXT_KEYS.length || !NEXT_KEYS.every((k) => keys.includes(k))) {
    unsafe(`the fields are exactly ${NEXT_KEYS.join(', ')}`);
  }
  const { action, who, argv, afterSeconds, why, cwd } = next;
  if (!NEXT_ACTIONS.includes(action)) unsafe(`unknown action ${printable(JSON.stringify(action))}`);
  if (who !== NEXT_WHO[action]) unsafe(`who is ${NEXT_WHO[action]} for ${action}, never chosen`);
  if (argv !== null && !(Array.isArray(argv) && argv.length && argv.every((a) => typeof a === 'string'))) {
    unsafe('argv is a non-empty array of strings, or null');
  }
  if ((action === 'run' || action === 'wait') && argv === null) unsafe(`${action} needs an argv`);
  if ((action === 'done' || action === 'stop') && argv !== null) unsafe(`${action} carries no argv`);
  // run, wait and any ask argv re-enter this tool and its own gates; a handoff
  // to another tool is done, with the next step in the runbook.
  const head = selfArgv();
  if (argv !== null && (argv[0] !== head[0] || argv[1] !== head[1])) {
    unsafe(`${action} re-invokes this tool: argv starts with ${printable(head.join(' '))}`);
  }
  const flag = (argv || []).find(isOverrideFlag);
  if (flag !== undefined) unsafe(`argv carries the override flag ${printable(flag)}; a step that needs one is ask`);
  const alias = (argv || []).find(isGoAlias);
  if (alias !== undefined) unsafe(`argv carries ${printable(alias)}, a --go alias in GO_ALIASES; advice spells --go`);
  if (action === 'run' && argv.slice(2).some((a) => a === '--go' || a.startsWith('--go='))) {
    // Advice goes straight to --go only on what this run just previewed: the
    // dry run's own argv with --go added, as rerunArgv(argv, '--go') builds it.
    // A step into another command, or after a run that was no dry run, is a
    // read-only or dry-run step, with no --go.
    if (current.effect !== 'dry-run') {
      unsafe(`run carries --go only straight after a dry run of the same command; this run was ${printable(current.effect ?? 'not given')}`);
    }
    const expected = Array.isArray(current.argv) ? rerunArgv(current.argv, '--go') : [];
    if (argv.length !== expected.length || argv.some((a, i) => a !== expected[i])) {
      unsafe("run carries --go only on the command just previewed: that dry run's argv with --go added, as rerunArgv(argv, '--go') builds it; a step into another command carries no --go");
    }
  }
  if (action === 'wait') {
    // wait re-polls, so it never mutates: no --go, and no mutating command,
    // matched as the same words in a row (command names may be phrases).
    const rest = argv.slice(2);
    if (rest.some((a) => a === '--go' || a.startsWith('--go='))) unsafe('wait never carries --go');
    const has = (words) => rest.some((_, i) => words.every((w, j) => rest[i + j] === w));
    const mutating = [...MUTATING_COMMANDS].find((c) => has(String(c).split(' ')));
    if (mutating !== undefined) unsafe(`wait never runs the mutating command ${printable(mutating)}`);
  }
  if (action === 'wait' ? !(Number.isInteger(afterSeconds) && afterSeconds > 0) : afterSeconds !== null) {
    unsafe('afterSeconds is a positive integer for wait, and null otherwise');
  }
  if (typeof why !== 'string' || !why.trim() || CONTROL_CHARS.test(why)) {
    unsafe('why is one non-empty line, with no control characters');
  }
  if (cwd !== START_CWD) unsafe('cwd is the working directory the run started in');
  if (!(ACTIONS_FOR_EXIT[exit] || []).includes(action)) unsafe(`action ${action} contradicts exit ${exit}`);
}

// Characters that could break, rewrite, reorder or hide part of a line of text
// output: C0 controls but TAB, DEL, C1 controls, the Unicode line and paragraph
// separators, and the bidi embedding, override and isolate controls. Item text
// is data, and styling is the renderer's: a tool puts no ANSI colour in it.
const CONTROL_CHARS = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

function escapeControl(c) {
  const code = c.charCodeAt(0);
  return { '\n': '\\n', '\r': '\\r' }[c]
    ?? (code < 0x80 ? `\\x${code.toString(16).padStart(2, '0')}` : `\\u${code.toString(16).padStart(4, '0')}`);
}

// A control character inside $'...': one past ASCII as its UTF-8 bytes (\xHH
// each), not \uXXXX, which bash 3.2 (macOS's /bin/sh and /bin/bash) does not
// decode; bash 4+ and zsh read \xHH too.
function escapeShell(c) {
  return c.charCodeAt(0) < 0x80 ? escapeControl(c)
    : [...Buffer.from(c, 'utf8')].map((b) => `\\x${b.toString(16)}`).join('');
}

// Text for a text-mode line: control characters shown as escapes, so an item
// is always one line and nothing in it can pose as another line. TAB passes.
function printable(text) {
  return String(text).replace(new RegExp(CONTROL_CHARS, 'g'), escapeControl);
}

// POSIX single-quoting, only where a token needs it; a token holding a control
// character is ANSI-C quoted ($'...') instead, so the line stays one line.
function shellQuote(token) {
  if (CONTROL_CHARS.test(token)) {
    return `$'${token.replace(/[\\']/g, (c) => `\\${c}`).replace(new RegExp(CONTROL_CHARS, 'g'), escapeShell)}'`;
  }
  return /^[A-Za-z0-9_\/.,:@%+-][A-Za-z0-9_\/.,:=@%+-]*$/.test(token) ? token : `'${token.split("'").join("'\\''")}'`;
}

// The text form of `next`, the last line of every text mode, and always exactly
// one line. A command is printed only where its reader may take it: run and
// wait always, led by `cd <cwd> &&` so the line runs as pasted from any
// directory; ask only for a person, in the default human mode, which says
// "your call" (--brief and --quiet print a bare ask, so an agent is never
// handed a command at a halt); done and stop never. argv is quoted for
// reading; --json carries the exact array, with cwd beside it.
function nextLine(next, mode) {
  const command = next.argv ? ` ${next.argv.map(shellQuote).join(' ')}` : '';
  const why = `  (${printable(next.why)})`;
  const here = `cd ${shellQuote(next.cwd)} &&`;
  if (next.action === 'run') return `next: run ${here}${command}${why}`;
  if (next.action === 'wait') return `next: wait ${next.afterSeconds}s ${here}${command}${why}`;
  if (next.action === 'ask' && mode === 'human') return `next: your call${command && `:${command}`}${why}`;
  return `next: ${next.action}${why}`;
}

// -- rendering (one item shape -> every mode)

const REASON_CUT = 160; // --brief cuts a reason after this many of its own characters (before escaping)

function summaryLine(s, effect) {
  const base = `summary: ok=${s.ok} warn=${s.warn} skip=${s.skip} refuse=${s.refuse} fail=${s.fail}`;
  return effect === 'dry-run' ? `${base}  (dry run: pass --go to apply)` : base;
}

// A reason for --brief: the whole of it, or its first REASON_CUT characters
// and a count of the rest, which --json carries in full. Characters are the
// reason's own code points, counted before escaping: a surrogate pair is never
// split, the cut never falls inside an escape (a control character is cut
// whole, then shown as its escape), and N is the code points --json holds past
// the cut. The cut applies only where it shortens the reason (a reason a few
// characters over the limit is shorter whole than with the note), so --brief
// is never longer than the human output.
function briefReason(reason) {
  const shown = printable(reason);
  const chars = Array.from(String(reason));
  if (chars.length <= REASON_CUT) return shown;
  const cut = `${printable(chars.slice(0, REASON_CUT).join(''))}… (+${chars.length - REASON_CUT} chars; --json for all)`;
  return Buffer.byteLength(cut) < Buffer.byteLength(shown) ? cut : shown;
}

// One line per item: the verdict word, the summary, then the name, with no
// padding and no glyph. The parenthesised reason appears only for a non-ok
// verdict.
function briefLine(item) {
  const showReason = item.verdict !== 'ok' && item.reason;
  return `${item.verdict} ${printable(item.summary)}  ${printable(item.name)}`
    + (showReason ? `  (${briefReason(item.reason)})` : '');
}

// The stable per-item JSON shape (top-level keys fixed; tool-specific facts go
// under `data`).
function jsonItem(item) {
  return {
    path: item.path,
    name: item.name,
    verdict: item.verdict,
    summary: item.summary,
    reason: item.reason || '',
    changed: !!item.changed,
    data: item.data || null,
  };
}

// The exit code of the report once written: a late error keeps it.
let reportedExit = null;

// The only writer of stdout, and the end of the run. Renders one run in the
// chosen mode from the one item list; when the tool runs as a command, the
// process then exits with exactly the code the report carries, once stdout has
// flushed (a bare process.exit() cuts a large report off mid-pipe; a pipe
// takes 64 KiB at a time on macOS), so an open handle cannot hold the run
// open. Returns the exit code. `next` passes assertSafeNext() before a byte is
// written; `state` (a status snapshot) is optional and appears in --json only.
// `argv` is the argv the tool handed nextAction(), normalised as it normalised
// it; left out, it is this process's own.
function report({ command, effect, items, next, state = null, mode, argv = process.argv.slice(2) }) {
  const summary = summarize(items);
  const exit = exitCodeFor(items);
  assertSafeNext(next, exit, { effect, argv });

  const emit = (text) => {
    reportedExit = exit;
    process.stdout.write(text, () => { if (__isMain) process.exit(exit); });
    return exit;
  };

  if (mode === 'json') {
    const out = { tool: TOOL_NAME, version: readVersion(), contract: CONTRACT, command, effect, exit };
    if (state !== null) out.state = state;
    Object.assign(out, { items: items.map(jsonItem), summary, next });
    return emit(`${JSON.stringify(out, null, 2)}\n`);
  }

  const lines = [];
  if (mode === 'brief') {
    for (const it of items) lines.push(briefLine(it));
  } else if (mode === 'human') {
    for (const it of items) {
      lines.push(`${glyph(it.verdict)} ${printable(it.name)}`, `    ${printable(it.summary)}`);
      for (const line of it.lines || []) lines.push(`    ${printable(line)}`);
      if (it.reason) lines.push(`    ${it.verdict === 'ok' ? 'note' : it.verdict}: ${printable(it.reason)}`);
    }
    lines.push('');
  }
  lines.push(summaryLine(summary, effect));
  if (next) lines.push(nextLine(next, mode));
  return emit(`${lines.join('\n')}\n`);
}

// -- modes, errors, help, version

// The output mode from the parsed flags. --json combines with neither --brief
// nor --quiet (a usage error); --brief wins over --quiet.
function outputMode(values) {
  for (const other of ['brief', 'quiet']) {
    if (values.json && values[other]) usageError(`--${other} and --json cannot be combined`);
  }
  return values.json ? 'json' : values.brief ? 'brief' : values.quiet ? 'quiet' : 'human';
}

// Diagnostics go to stderr; stdout stays empty on both. These two may exit at
// once: they run before report(), so there is no stdout left to flush.
function usageError(message) {
  console.error(`error: ${message}`);
  console.error(`run \`${TOOL_NAME} --help\` for usage`);
  process.exit(2);
}

function environmentError(message) {
  console.error(`error: ${message}`);
  process.exit(3);
}

// Read the leading comment block of THIS file as help text (contact-sheet-cli
// pattern): skip the shebang, take the contiguous `//` lines, strip the `// `.
function helpText() {
  const lines = runtimeFs.readFileSync(SCRIPT_PATH, 'utf8').split('\n');
  const out = [];
  for (const l of lines.slice(1)) {
    if (!l.startsWith('//')) break;
    out.push(l.slice(3));
  }
  return out.join('\n');
}

function readVersion() {
  let dir = runtimePath.dirname(SCRIPT_PATH);
  for (let i = 0; i < 20; i += 1) {
    const p = runtimePath.join(dir, 'package.json');
    if (runtimeFs.existsSync(p)) {
      try { return JSON.parse(runtimeFs.readFileSync(p, 'utf8')).version || '0.0.0'; }
      catch { return '0.0.0'; }
    }
    const parent = runtimePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

// Exit with `code` once stdout has flushed: process.exit() alone drops what a
// pipe has not yet taken, and waiting for the event loop to empty lets any
// open handle hold the run open.
function exitAfterFlush(code) {
  process.stdout.write('', () => process.exit(code));
}

// The hooks a tool declares above this block, checked as the module loads, so
// a missing or misshapen one fails by name (exit 3) instead of mid-run.
const HOOK_ERROR = (() => {
  const hooks = [
    ['MUTATING_COMMANDS', 'a Set of command names', () => MUTATING_COMMANDS instanceof Set],
    ['AUTO_RUN_COMMANDS', 'a Set of command names (empty for none)', () => AUTO_RUN_COMMANDS instanceof Set],
    ['EXTRA_OVERRIDE_FLAGS', 'an array of strings (empty for none)',
      () => Array.isArray(EXTRA_OVERRIDE_FLAGS) && EXTRA_OVERRIDE_FLAGS.every((f) => typeof f === 'string')],
    ['GO_ALIASES', 'an array of strings (empty for none)',
      () => Array.isArray(GO_ALIASES) && GO_ALIASES.every((f) => typeof f === 'string')],
    ['nextAction', 'a function', () => typeof nextAction === 'function'],
    ['main', 'a function', () => typeof main === 'function'],
  ];
  const wrong = hooks.filter(([, , ok]) => { try { return !ok(); } catch { return true; } });
  return wrong.length
    ? `contract ${CONTRACT}: declare ${wrong.map(([name, shape]) => `${name} as ${shape}`).join('; ')}, above the runtime block`
    : null;
})();

// Entry-point guard, the last statement of the file. Resolve symlinks first: an
// npm-linked bin is a symlink, so process.argv[1] is the link path while
// import.meta.url is the real path, and the naive guard silently skips main()
// (exit 0, no output). realpath both sides to compare. An exception escaping
// main(), or thrown from a timer, a floating promise or a stream with no
// 'error' handler before the report is written, exits 3: the run could not
// complete, which is not a partial result (1). One thrown after the report is
// still printed, but the run exits with the code the report gave, which nothing
// may contradict. A main() that returns without a report exits once stdout has
// flushed. An error while the module loads (a syntax error, a top-level use of
// a fence name above the fence) happens before this runs, and Node exits 1.
const __entry = process.argv[1]
  ? (() => { try { return runtimeFs.realpathSync(process.argv[1]); } catch { return process.argv[1]; } })()
  : null;
const __isMain = !!__entry && import.meta.url === runtimeUrl.pathToFileURL(__entry).href;
if (__isMain) {
  const fatal = (e) => {
    console.error(`error: ${e?.message ?? e}`);
    if (reportedExit === null) process.exit(3);
    exitAfterFlush(reportedExit);
  };
  process.on('uncaughtException', fatal);
  process.on('unhandledRejection', fatal);
  if (HOOK_ERROR) fatal(new Error(HOOK_ERROR));
  else Promise.resolve().then(main).then(() => { if (reportedExit === null) exitAfterFlush(process.exitCode ?? 0); }, fatal);
} else if (HOOK_ERROR) {
  throw new Error(HOOK_ERROR);
}
// ---- end mjs-tool runtime v3 ----
