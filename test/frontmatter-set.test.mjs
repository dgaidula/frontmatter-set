import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  symlinkSync, lstatSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync, statSync, chmodSync,
  linkSync, existsSync, writeSync, ftruncateSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scalarText, planOne, buildSpec, writeOne, verdict } from '../frontmatter-set.mjs';

const TOOL_PATH = fileURLToPath(new URL('../frontmatter-set.mjs', import.meta.url));
const NODE = process.execPath;

// Backups go to a temp folder, never the real one in ~/Library.
const BACKUP_DIR = mkdtempSync(path.join(tmpdir(), 'fmset-backup-'));
after(() => rmSync(BACKUP_DIR, { recursive: true, force: true }));
process.env.FRONTMATTER_SET_BACKUP_DIR = BACKUP_DIR; // for writeOne() called in this process
const ENV = { ...process.env };

function run(args, opts = {}) {
  return spawnSync(NODE, [TOOL_PATH, ...args], { encoding: 'utf8', timeout: 15000, env: ENV, ...opts });
}

// A scratch folder; every test writes only inside one and removes it.
function scratch(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'fmset-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const put = (dir, name, content) => { const p = path.join(dir, name); writeFileSync(p, content); return p; };
const get = (p) => readFileSync(p, 'utf8');
const snapshot = (dir) => Object.fromEntries(readdirSync(dir)
  .filter((n) => statSync(path.join(dir, n)).isFile())
  .map((n) => [n, sha(readFileSync(path.join(dir, n)))]));

// A doc-shaped file (a design proposal), in LF.
const DOC = [
  '---',
  'title: "Widget Cache Proposal"',
  'author: Ada Lovelace  # the writer',
  'status: open',
  'priority: medium',
  'note: |',
  '  Line one: with a colon.',
  '',
  '  Line two.',
  'tags:',
  '  - design',
  '  - tools',
  'category: design',
  '---',
  '',
  '# Body',
  '',
  'status: open in the body must not change.',
  '',
].join('\n');

// The lines that differ between two texts, as [before, after] by position
// (the two have the same number of lines in the replace tests).
function changedLines(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const out = [];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) if (x[i] !== y[i]) out.push([x[i], y[i]]);
  return out;
}

test('replace: --set changes only that key’s line', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const r = run([f, '--set', 'status=closed', '--go']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(changedLines(DOC, get(f)), [['status: open', 'status: closed']]);
}));

test('insert: a missing key goes just before the closing ---', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  assert.equal(run([f, '--set', 'related=notes-v2.md', '--go']).status, 0);
  assert.equal(get(f), DOC.replace('category: design\n---', 'category: design\nrelated: notes-v2.md\n---'));
}));

test('unset: removes the key and its continuation lines, nothing else', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  assert.equal(run([f, '--unset', 'note', '--unset', 'tags', '--unset', 'absent_key', '--go']).status, 0);
  assert.equal(get(f), DOC
    .replace('note: |\n  Line one: with a colon.\n\n  Line two.\n', '')
    .replace('tags:\n  - design\n  - tools\n', ''));
}));

test('replace: a block scalar’s continuation lines are replaced with it', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  assert.equal(run([f, '--set', 'note=Short.', '--go']).status, 0);
  assert.equal(get(f), DOC.replace('note: |\n  Line one: with a colon.\n\n  Line two.\n', 'note: Short.\n'));
}));

test('where: conditions are ANDed, and a file that misses one is skipped', () => scratch((dir) => {
  const a = put(dir, 'a.md', DOC);
  const b = put(dir, 'b.md', DOC.replace('priority: medium', 'priority: high'));
  const c = put(dir, 'c.md', DOC.replace('status: open\n', ''));
  const r = run([a, b, c, '--set', 'status=closed', '--where', 'status=open', '--where', 'priority=medium', '--json']);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.items.map((i) => i.verdict), ['ok', 'skip', 'skip']);
  assert.deepEqual(out.items.map((i) => i.summary), ['would change status', 'where not met', 'where not met']);
  assert.match(out.items[1].reason, /priority is "high"/);
  assert.match(out.items[2].reason, /no status key/);
  assert.equal(r.status, 0); // a skip is not a failure
}));

test('quoting: a value is quoted only where YAML would misread it plain', () => {
  const plain = ['closed', 'Reviewed 2026-10-16, no changes.', 'a-b', 'x#y', 'path/to/file.md', 'café', 'true story'];
  for (const v of plain) assert.equal(scalarText(v), v, `${v} stays plain`);
  const quoted = [
    'a: b', '# no', '- item', '[x]', '{x}', '*star', '&amp', '!tag', '| pipe', '> fold', "'q'", '"q"', '%pct', '@at', '`tick`',
    'yes', 'no', 'true', 'false', 'null', '~', '150000', '1.5', ' lead', 'trail ', '', '2026-10-16',
  ];
  for (const v of quoted) assert.match(scalarText(v), /^["']/, `${JSON.stringify(v)} is quoted: ${scalarText(v)}`);
});

test('quoting: end to end, every value reads back as the exact string given', () => scratch((dir) => {
  const values = ['a: b', '# no', 'yes', 'null', '150000', ' padded ', 'say "hi"', "it's", '[x]', '', 'a very long line '.repeat(12).trim()];
  const f = put(dir, 'a.md', '---\ntitle: T\n---\nbody\n');
  const args = values.flatMap((v, i) => ['--set', `k${i}=${v}`]);
  const r = run([f, ...args, '--go', '--json']);
  assert.equal(r.status, 0, r.stdout);
  // read it back through the tool itself: --where compares the parsed value
  for (const [i, v] of values.entries()) {
    const probe = JSON.parse(run([f, '--set', 'zz=1', '--where', `k${i}=${v}`, '--json']).stdout);
    assert.equal(probe.items[0].verdict, 'ok', `k${i} reads back as ${JSON.stringify(v)}`);
  }
  assert.equal(get(f).split('\n').filter((l) => l.startsWith('k')).length, values.length); // no line was folded
}));

test('a number given to --set is written as a string, and replaces a numeric value (a warn)', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\nwords: 1200\n---\nbody\n');
  const r = run([f, '--set', 'words=1500', '--go', '--brief']);
  assert.equal(r.status, 1, r.stdout); // the type change is a finding, and still written
  assert.match(r.stdout, /^warn .*\(words was the number 1200 and is written as a string;/m);
  assert.equal(get(f), '---\nwords: "1500"\n---\nbody\n');
}));

test('CRLF: line endings are kept, on a replaced line and on an inserted one', () => scratch((dir) => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  const f = put(dir, 'a.md', crlf);
  assert.equal(run([f, '--set', 'status=closed', '--set', 'related=x.md', '--go']).status, 0);
  assert.equal(get(f), crlf.replace('status: open', 'status: closed').replace('category: design\r\n---', 'category: design\r\nrelated: x.md\r\n---'));
}));

test('CRLF: a last key with continuation lines is replaced without a doubled \\r', () => scratch((dir) => {
  const crlf = '---\r\ntitle: T\r\nnote: |\r\n  first\r\n  second\r\n---\r\nBody\r\n';
  const f = put(dir, 'a.md', crlf);
  assert.equal(run([f, '--set', 'note=Short.', '--go']).status, 0);
  const text = get(f);
  assert.equal(text, '---\r\ntitle: T\r\nnote: Short.\r\n---\r\nBody\r\n');
  assert.ok(!text.includes('\r\r'));
}));

test('BOM: a leading byte-order mark is kept and the frontmatter is still found', () => scratch((dir) => {
  const f = put(dir, 'a.md', '﻿---\nstatus: open\n---\nbody\n');
  assert.equal(run([f, '--set', 'status=closed', '--go']).status, 0);
  const bytes = readFileSync(f);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.toString('utf8'), '﻿---\nstatus: closed\n---\nbody\n');
}));

test('comments: a trailing comment on an untouched line stays; on a replaced one-line value it stays too', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC.replace('status: open', 'status: open  # as of Oct'));
  assert.equal(run([f, '--set', 'status=closed', '--set', 'category=notes', '--go']).status, 0);
  const text = get(f);
  assert.match(text, /^author: Ada Lovelace {2}# the writer$/m);
  assert.match(text, /^status: closed {2}# as of Oct$/m);
}));

test('re-parse guard: an edit that would change another key is refused and nothing is written', () => scratch((dir) => {
  const src = '---\nbase: &b shared\nuse: *b\nstatus: open\n---\nbody\n';
  const f = put(dir, 'a.md', src);
  const r = run([f, '--unset', 'base', '--go', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.items[0].verdict, 'refuse');
  assert.match(out.items[0].reason, /does not parse: Unresolved alias/);
  assert.equal(r.status, 1);
  assert.equal(get(f), src);
}));

test('invalid YAML: the file is refused with the parser’s message, and the others still go', () => scratch((dir) => {
  const bad = put(dir, 'bad.md', '---\ntitle: x\n  oops: [unclosed\n---\nbody\n');
  const good = put(dir, 'good.md', '---\nstatus: open\n---\nbody\n');
  const r = run([bad, good, '--set', 'status=closed', '--go', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.items[0].verdict, 'refuse');
  assert.match(out.items[0].reason, /Nested mappings are not allowed.*\(line 2\)/);
  assert.equal(out.items[1].verdict, 'ok');
  assert.equal(r.status, 1);
  assert.equal(get(bad), '---\ntitle: x\n  oops: [unclosed\n---\nbody\n');
  assert.equal(get(good), '---\nstatus: closed\n---\nbody\n');
}));

test('no frontmatter, already so, and a missing path each have a verdict of their own', () => scratch((dir) => {
  const none = put(dir, 'none.md', 'just text\n');
  const so = put(dir, 'so.md', '---\nstatus: closed\n---\nbody\n');
  const r = run([none, so, path.join(dir, 'gone.md'), '--set', 'status=closed', '--json']);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.items.map((i) => [i.verdict, i.summary]), [['skip', 'no frontmatter'], ['skip', 'already so'], ['refuse', 'no such path']]);
  assert.equal(r.status, 1);
}));

test('dry run: writes nothing, shows the diff, and reports a plan', () => scratch((dir) => {
  put(dir, 'a.md', DOC);
  put(dir, 'b.md', DOC.replace(/\n/g, '\r\n'));
  const before = snapshot(dir);
  const r = run([dir, '--set', 'status=closed', '--unset', 'tags', '--json']);
  assert.equal(r.status, 0);
  assert.deepEqual(snapshot(dir), before); // no file changed, no temp file left
  const out = JSON.parse(r.stdout);
  assert.equal(out.effect, 'dry-run');
  assert.match(out.state.plan, /^[0-9a-f]{16}$/);
  assert.match(out.items[0].data.diff, /^@@ .* @@\n/);
  assert.match(out.items[0].data.diff, /^-status: open$/m);
  assert.match(out.items[0].data.diff, /^\+status: closed$/m);
  assert.ok(!out.items[1].data.diff.includes('\r')); // the diff is for reading: no stray \r
  assert.deepEqual(out.next.argv.slice(-3), ['--go', '--plan', out.state.plan]);
  assert.equal(out.next.action, 'ask');
}));

test('--go changes only the touched lines: a byte comparison, body and other keys untouched', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const mode = 0o640;
  chmodSync(f, mode);
  const dry = JSON.parse(run([f, '--set', 'status=closed', '--set', 'priority=skip', '--json']).stdout);
  const r = run([f, '--set', 'status=closed', '--set', 'priority=skip', '--go', '--plan', dry.state.plan]);
  assert.equal(r.status, 0, r.stdout);
  const after = get(f);
  assert.deepEqual(changedLines(DOC, after), [['status: open', 'status: closed'], ['priority: medium', 'priority: skip']]);
  assert.equal(statSync(f).mode & 0o777, mode); // the mode survives the rename
  assert.deepEqual(readdirSync(dir), ['a.md']); // no temp file left behind
}));

test('plan: a file that changed since the dry run is refused, and nothing is written', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const g = put(dir, 'b.md', DOC);
  const dry = JSON.parse(run([dir, '--set', 'status=closed', '--json']).stdout);
  writeFileSync(g, DOC.replace('priority: medium', 'priority: high')); // changes after the review
  const before = snapshot(dir);
  const r = run([dir, '--set', 'status=closed', '--go', '--plan', dry.state.plan, '--json']);
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.ok(out.items.some((i) => i.verdict === 'refuse' && i.summary === 'plan changed since the dry run'));
  assert.ok(out.items.every((i) => !i.changed));
  assert.deepEqual(snapshot(dir), before);
  assert.equal(out.next.action, 'ask');
  assert.ok(!out.next.argv.includes('--go')); // the advice is a fresh dry run
  assert.equal(get(f), DOC);
}));

test('plan: different edits give a different plan, and a malformed --plan is a usage error', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const one = JSON.parse(run([f, '--set', 'status=closed', '--json']).stdout).state.plan;
  const two = JSON.parse(run([f, '--set', 'status=merged', '--json']).stdout).state.plan;
  assert.notEqual(one, two);
  assert.equal(run([f, '--set', 'status=closed', '--go', '--plan', 'nothex']).status, 2);
  assert.equal(run([f, '--set', 'status=closed', '--plan', one]).status, 2); // --plan needs --go
}));

test('plain --go still works without --plan', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  assert.equal(run([f, '--set', 'status=closed', '--go']).status, 0);
  assert.match(get(f), /^status: closed$/m);
}));

test('directory: its *.md files only, not recursive, dotfiles and other types left alone', () => scratch((dir) => {
  put(dir, 'a.md', DOC);
  put(dir, 'b.MD', DOC);
  put(dir, 'notes.txt', DOC);
  put(dir, '.hidden.md', DOC);
  mkdirSync(path.join(dir, 'sub'));
  put(path.join(dir, 'sub'), 'c.md', DOC);
  const before = snapshot(dir);
  const out = JSON.parse(run([dir, '--set', 'status=closed', '--go', '--json']).stdout);
  assert.deepEqual(out.items.map((i) => path.basename(i.path)), ['a.md', 'b.MD']);
  const after = snapshot(dir);
  assert.notEqual(after['a.md'], before['a.md']);
  assert.notEqual(after['b.MD'], before['b.MD']);
  for (const n of ['notes.txt', '.hidden.md']) assert.equal(after[n], before[n]);
  assert.equal(sha(readFileSync(path.join(dir, 'sub', 'c.md'))), sha(Buffer.from(DOC)));
  // an empty folder is a skip with a reason, not silence
  const empty = path.join(dir, 'sub2');
  mkdirSync(empty);
  assert.equal(JSON.parse(run([empty, '--set', 'a=b', '--json']).stdout).items[0].summary, 'no .md files');
}));

test('contract: --brief is one line per file, --quiet the summary line, every text mode ends with next:', () => scratch((dir) => {
  const a = put(dir, 'a.md', DOC);
  const b = put(dir, 'b.md', 'plain\n');
  const brief = run([a, b, '--set', 'status=closed', '--brief']).stdout.trim().split('\n');
  assert.equal(brief.length, 4); // two files, a summary line, a next line
  assert.match(brief[0], /^ok would change status {2}/);
  assert.match(brief[1], /^skip .*\(the file does not start with a --- line\)$/);
  assert.match(brief[2], /^summary: ok=1 warn=0 skip=1 refuse=0 fail=0/);
  assert.match(brief[3], /^next: ask/);
  const quiet = run([a, b, '--set', 'status=closed', '--quiet']).stdout.trim().split('\n');
  assert.equal(quiet.length, 2);
  assert.match(quiet[0], /^summary:/);
  const human = run([a, '--set', 'status=closed']).stdout.trim().split('\n');
  assert.match(human[human.length - 1], /^next: your call: .* --go --plan [0-9a-f]{16}/);
}));

test('contract: usage errors exit 2 with nothing on stdout', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const cases = [
    [f], // nothing to do
    ['--set', 'a=b'], // no path
    [f, '--set', 'novalue'],
    [f, '--set', 'a=b', '--set', 'a=c'],
    [f, '--set', 'a=b', '--unset', 'a'],
    [f, '--set', 'a=b\nc'],
    [f, '--set', 'a=b', '--yes'], // there is no confirmation to pre-answer
    [f, '--set', 'a=b', '--json', '--brief'],
  ];
  for (const args of cases) {
    const r = run(args);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.stdout, '');
  }
}));

test('contract: --json carries the exit code, never prompts, and a --go over refusals exits 1', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const bad = put(dir, 'bad.md', '---\n: : :\n  - [\n---\n');
  const r = run([f, bad, '--set', 'status=closed', '--go', '--json'], { input: '' }); // stdin is not a TTY
  const out = JSON.parse(r.stdout);
  assert.equal(out.exit, r.status);
  assert.equal(out.exit, 1);
  assert.equal(out.contract, 'mjs-tool/3');
  assert.equal(out.effect, 'applied');
  assert.deepEqual(out.summary, { ok: 1, warn: 0, skip: 0, refuse: 1, fail: 0 });
  assert.equal(out.items[0].changed, true);
}));

test('a symlink is edited through, the link stays a link, and a missing final newline is kept', () => scratch((dir) => {
  const real = put(dir, 'real.md', '---\nstatus: open\n---');
  const link = path.join(dir, 'link.md');
  symlinkSync('real.md', link);
  assert.equal(run([link, '--set', 'status=closed', '--go']).status, 0);
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(get(real), '---\nstatus: closed\n---');
}));

// ---- fix round 1 (the gate's follow-ups; numbers are the gate's) ------------

// A backup folder of the test's own, outside the target folder.
function withBackup(fn) {
  const bk = mkdtempSync(path.join(tmpdir(), 'fmset-bk-'));
  try { return fn(bk, { env: { ...process.env, FRONTMATTER_SET_BACKUP_DIR: bk } }); } finally { rmSync(bk, { recursive: true, force: true }); }
}
const filesUnder = (dir) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((n) => statSync(path.join(dir, n)).isFile()) : []);

test('2: in place: the inode is the same after --go', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const ino = statSync(f).ino;
  assert.equal(run([f, '--set', 'status=closed', '--go']).status, 0);
  assert.equal(statSync(f).ino, ino);
  assert.match(get(f), /^status: closed$/m);
}));

test('2: in place: an extended attribute survives --go (xattr on macOS, setfattr/getfattr in user. on Linux)', (t) => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const tools = [
    { set: ['xattr', '-w', 'com.example.fmset', 'kept', f], get: ['xattr', '-p', 'com.example.fmset', f] },
    { set: ['setfattr', '-n', 'user.fmset', '-v', 'kept', f], get: ['getfattr', '--only-values', '-n', 'user.fmset', f] },
  ];
  const tool = tools.find(({ set: [cmd, ...args] }) => { const w = spawnSync(cmd, args, { encoding: 'utf8' }); return !w.error && w.status === 0; });
  if (!tool) { t.skip('neither xattr nor setfattr can set an attribute here'); return; }
  assert.equal(run([f, '--set', 'status=closed', '--go']).status, 0);
  const [cmd, ...args] = tool.get;
  assert.equal(spawnSync(cmd, args, { encoding: 'utf8' }).stdout.trim(), 'kept');
}));

test('2: in place: a hard link stays one file, and both names see the edit', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const g = path.join(dir, 'b.md');
  linkSync(f, g);
  assert.equal(run([f, '--set', 'status=closed', '--go']).status, 0);
  assert.equal(statSync(f).nlink, 2);
  assert.equal(get(g), get(f));
  assert.match(get(g), /^status: closed$/m);
}));

test('2: the backup holds the original bytes, outside the folder, and --json names it', () => scratch((dir) => withBackup((bk, opts) => {
  const f = put(dir, 'a.md', DOC);
  const out = JSON.parse(run([f, '--set', 'status=closed', '--go', '--json'], opts).stdout);
  const backup = out.items[0].data.backup;
  assert.ok(backup.startsWith(bk + path.sep), backup);
  assert.match(path.relative(bk, backup), /^\d{4}-\d{2}-\d{2}\/\d{6}-\d+\/[^/]+-[0-9a-f]{8}\/a\.md$/);
  assert.equal(readFileSync(backup, 'utf8'), DOC);
  assert.match(out.items[0].reason, /the original is backed up to /);
  assert.deepEqual(readdirSync(dir), ['a.md']);
  // a second run keeps the first backup and makes its own, under the same name
  const again = JSON.parse(run([f, '--set', 'status=merged', '--go', '--json'], opts).stdout);
  assert.notEqual(path.dirname(path.dirname(again.items[0].data.backup)), path.dirname(path.dirname(backup)));
  assert.equal(path.basename(again.items[0].data.backup), 'a.md');
  assert.equal(readFileSync(backup, 'utf8'), DOC);
})));

test('6 (backups): a.md and a real a.1.md over two runs each keep their own name, one folder per run', () => scratch((dir) => withBackup((bk, opts) => {
  put(dir, 'a.md', DOC);
  put(dir, 'a.1.md', DOC.replace('priority: medium', 'priority: high'));
  for (const v of ['closed', 'merged']) assert.equal(run([dir, '--set', `status=${v}`, '--go'], opts).status, 0);
  const backups = filesUnder(bk).sort();
  assert.equal(backups.length, 4);
  const runOf = (b) => b.split(path.sep).slice(0, 2).join(path.sep); // <date>/<HHMMSS>-<pid>
  const runs = new Set(backups.map(runOf));
  assert.equal(runs.size, 2);
  for (const r of runs) assert.deepEqual(backups.filter((b) => runOf(b) === r).map((b) => path.basename(b)).sort(), ['a.1.md', 'a.md']);
  for (const b of backups) {
    const want = path.basename(b) === 'a.md' ? 'priority: medium' : 'priority: high';
    assert.match(readFileSync(path.join(bk, b), 'utf8'), new RegExp(`^${want}$`, 'm'), b);
  }
})));

test('W7: a backup name already taken in this run is never overwritten; the write fails and the file is left alone', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const first = planOne({ path: f }, buildSpec({ set: ['status=closed'] }));
  writeOne(first);
  assert.equal(first.changed, true);
  const second = planOne({ path: f }, buildSpec({ set: ['status=merged'] }));
  const before = get(f);
  writeOne(second); // the same file again, in the same process: the same run folder
  assert.equal(second.summary, 'backup failed');
  assert.equal(get(f), before);
  assert.equal(readFileSync(first.data.backup, 'utf8'), DOC);
}));

test('W8: the backup folders are private (0700)', () => scratch((dir) => withBackup((bk, opts) => {
  put(dir, 'a.md', DOC);
  const out = JSON.parse(run([dir, '--set', 'status=closed', '--go', '--json'], opts).stdout);
  const rel = path.relative(bk, path.dirname(out.items[0].data.backup)).split(path.sep);
  assert.equal(rel.length, 3); // <date>/<HHMMSS>-<pid>/<folder>-<hash>
  for (let i = 1; i <= rel.length; i += 1) {
    const d = path.join(bk, ...rel.slice(0, i));
    assert.equal(statSync(d).mode & 0o777, 0o700, d);
  }
})));

test('W10: a symlink’s backup is named and filed by the file it points to', () => scratch((dir) => withBackup((bk, opts) => {
  mkdirSync(path.join(dir, 'real'));
  mkdirSync(path.join(dir, 'links'));
  put(path.join(dir, 'real'), 'r.md', DOC);
  const link = path.join(dir, 'links', 'l.md');
  symlinkSync(path.join('..', 'real', 'r.md'), link);
  const out = JSON.parse(run([link, '--set', 'status=closed', '--go', '--json'], opts).stdout);
  const backup = out.items[0].data.backup;
  assert.equal(path.basename(backup), 'r.md');
  assert.match(path.basename(path.dirname(backup)), /^real-[0-9a-f]{8}$/);
})));

test('2: a write that does not read back is restored from the backup, and the item fails naming it', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const item = planOne({ path: f }, buildSpec({ set: ['status=closed'] }));
  let calls = 0;
  writeOne(item, { readBack: () => { calls += 1; return calls === 1 ? Buffer.from('torn') : readFileSync(f); } });
  assert.equal(get(f), DOC);
  assert.equal(item.changed, false);
  assert.match(item.error, /did not read back as written, so it was restored from the backup .*a\.md$/);
  assert.equal(readFileSync(item.data.backup, 'utf8'), DOC);
}));

test('2: the dry run writes no backup', () => scratch((dir) => withBackup((bk, opts) => {
  put(dir, 'a.md', DOC);
  assert.equal(run([dir, '--set', 'status=closed'], opts).status, 0);
  assert.deepEqual(filesUnder(bk), []);
})));

test('1: an interrupted --go (SIGINT, SIGKILL) leaves no extra file in the target folder', async (t) => {
  for (const signal of ['SIGINT', 'SIGKILL']) {
    const dir = mkdtempSync(path.join(tmpdir(), 'fmset-test-'));
    const bk = mkdtempSync(path.join(tmpdir(), 'fmset-bk-'));
    try {
      const names = Array.from({ length: 400 }, (_, i) => `f${String(i).padStart(3, '0')}.md`);
      for (const n of names) put(dir, n, DOC);
      const child = spawn(NODE, [TOOL_PATH, dir, '--set', 'status=closed', '--go'], {
        env: { ...process.env, FRONTMATTER_SET_BACKUP_DIR: bk }, stdio: 'ignore',
      });
      const exited = new Promise((done) => child.on('exit', (code, sig) => done({ code, sig })));
      const start = Date.now();
      // kill it mid-run: once the 20th file (they go in name order) has been written
      const twentieth = path.join(dir, names[19]);
      while (!get(twentieth).includes('status: closed') && Date.now() - start < 10000) await new Promise((r) => setTimeout(r, 2));
      child.kill(signal);
      const { sig } = await exited;
      const done = names.filter((n) => get(path.join(dir, n)).includes('status: closed')).length;
      t.diagnostic(`${signal}: ${done} of 400 files written when it stopped (${sig ?? 'exited'})`);
      if (sig === null && done === 400) {
        t.skip(`this machine wrote all 400 files before ${signal} landed, so the interrupt was not caught`);
        return;
      }
      assert.equal(sig, signal); // the run was stopped by the signal, not finished
      assert.ok(done > 0 && done < 400, `${done} of 400 written`);
      assert.deepEqual(readdirSync(dir).sort(), names);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(bk, { recursive: true, force: true });
    }
  }
});

test('3: a file that is not writable (0444) is refused and left alone', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  chmodSync(f, 0o444);
  const r = run([f, '--set', 'status=closed', '--go', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(r.status, 1);
  assert.deepEqual([out.items[0].verdict, out.items[0].summary], ['refuse', 'not writable']);
  assert.equal(get(f), DOC);
}));

test('4: a number or boolean whose YAML text is the --set value is already so', () => scratch((dir) => {
  const src = '---\nwords: 1500\ndraft: true\n---\nbody\n';
  const f = put(dir, 'a.md', src);
  const out = JSON.parse(run([f, '--set', 'words=1500', '--set', 'draft=true', '--go', '--json']).stdout);
  assert.deepEqual([out.items[0].verdict, out.items[0].summary], ['skip', 'already so']);
  assert.equal(out.exit, 0);
  assert.equal(get(f), src);
}));

test('4: a boolean replaced by a string is a warn, and --go still writes it', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\ndraft: true\n---\nbody\n');
  const out = JSON.parse(run([f, '--set', 'draft=pending', '--go', '--json']).stdout);
  assert.equal(out.items[0].verdict, 'warn');
  assert.match(out.items[0].reason, /draft was the boolean true and is written as a string/);
  assert.equal(out.exit, 1);
  assert.equal(get(f), '---\ndraft: pending\n---\nbody\n');
}));

test('4b: --set-yaml writes a number', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\ntitle: T\n---\n');
  assert.equal(run([f, '--set-yaml', 'words=1500', '--go']).status, 0);
  assert.equal(get(f), '---\ntitle: T\nwords: 1500\n---\n');
}));

test('4b: --set-yaml writes a boolean', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\ndraft: false\n---\n');
  assert.equal(run([f, '--set-yaml', 'draft=true', '--go']).status, 0);
  assert.equal(get(f), '---\ndraft: true\n---\n');
}));

test('4b: --set-yaml writes null', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\ntitle: T\n---\n');
  assert.equal(run([f, '--set-yaml', 'note=null', '--go']).status, 0);
  assert.equal(get(f), '---\ntitle: T\nnote: null\n---\n');
}));

test('4b: --set-yaml writes a quoted string as a string', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\ntitle: T\n---\n');
  assert.equal(run([f, '--set-yaml', 'title="A: B"', '--go']).status, 0);
  assert.equal(get(f), '---\ntitle: "A: B"\n---\n');
}));

test('4b: --set-yaml refuses a map (exit 2)', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const r = run([f, '--set-yaml', 'k={a: 1}']);
  assert.equal(r.status, 2);
  assert.equal(r.stdout, '');
}));

test('4b: --set-yaml refuses a sequence (exit 2)', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  for (const v of ['[1, 2]', '- a']) assert.equal(run([f, '--set-yaml', `k=${v}`]).status, 2, v);
}));

test('4b: --set-yaml refuses a value that does not parse, an alias or a tag (exit 2)', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  for (const v of ['"unclosed', '*a', '!!str 5', '&a 5']) assert.equal(run([f, '--set-yaml', `k=${v}`]).status, 2, v);
  assert.equal(run([f, '--set-yaml', 'k=1', '--set', 'k=2']).status, 2); // one key, two options
}));

test('4b: --set-yaml on an equal number is already so', () => scratch((dir) => {
  const src = '---\nwords: 1500\n---\n';
  const f = put(dir, 'a.md', src);
  const out = JSON.parse(run([f, '--set-yaml', 'words=1500', '--go', '--json']).stdout);
  assert.deepEqual([out.items[0].verdict, out.items[0].summary], ['skip', 'already so']);
  assert.equal(get(f), src);
}));

test('4b: --set-yaml replacing a string with a number is a warn, and written', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\nwords: "1500"\n---\n');
  const out = JSON.parse(run([f, '--set-yaml', 'words=1500', '--go', '--json']).stdout);
  assert.equal(out.items[0].verdict, 'warn');
  assert.match(out.items[0].reason, /words was the string "1500" and is written as the number 1500/);
  assert.equal(get(f), '---\nwords: 1500\n---\n');
}));

test('E11: --set-yaml of a quoted string over a number written the same is a type change, not already so', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\nwords: 1500\n---\n');
  const out = JSON.parse(run([f, '--set-yaml', 'words="1500"', '--go', '--json']).stdout);
  assert.equal(out.items[0].verdict, 'warn');
  assert.match(out.items[0].reason, /words was the number 1500 and is written as a string/);
  assert.equal(get(f), '---\nwords: "1500"\n---\n');
}));

test('4 (types): a list or mapping replaced by a scalar, or a value replaced by null, is a warn', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\ntags:\n  - a\n  - b\nmeta:\n  x: 1\nnums: [1, 2]\ntitle: T\nempty:\nnone: null\n---\n');
  const r = run([f, '--set', 'tags=x', '--set', 'meta=y', '--set-yaml', 'nums=5', '--set-yaml', 'title=null',
    '--set', 'empty=filled', '--set-yaml', 'none=3', '--brief']);
  assert.equal(r.status, 1, r.stdout);
  const line = r.stdout.split('\n')[0];
  assert.match(line, /^warn /);
  for (const w of ['tags was a list and is written as a string', 'meta was a mapping and is written as a string',
    'nums was a list and is written as the number 5', 'title was the string "T" and is written as null']) assert.ok(line.includes(w), w);
  assert.ok(!/empty was|none was|the null null/.test(line), line); // filling an empty or null value is not a type change
}));

test('5 (--set-yaml): an empty value, a bare --- or ..., a comment, or a number that overflows is a usage error', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\ntitle: T\n---\n');
  for (const v of ['', '  ', '---', '...', 'a # c', '5 # five', '1e400', '-1e400', '1e-400']) {
    const r = run([f, '--set-yaml', `k=${v}`, '--go']);
    assert.equal(r.status, 2, JSON.stringify(v));
    assert.equal(r.stdout, '');
  }
  assert.match(run([f, '--set-yaml', 'k=a # c']).stderr, /use --set/);
  assert.equal(get(f), '---\ntitle: T\n---\n');
  for (const v of ['null', '~']) {
    const g = put(dir, 'n.md', '---\ntitle: T\n---\n');
    assert.equal(run([g, '--set-yaml', `k=${v}`, '--go']).status, 0, v);
    assert.equal(get(g), '---\ntitle: T\nk: null\n---\n');
  }
}));

test('5 (--set-yaml): a number written in another form than given is a warn naming both texts, in --brief', () => scratch((dir) => {
  const cases = [['1.10', '1.1'], ['0x1F', '31'], ['007', '7'], ['1e3', '1000']];
  for (const [given, written] of cases) {
    const f = put(dir, 'a.md', '---\ntitle: T\nv: 0\n---\n');
    const r = run([f, '--set-yaml', `v=${given}`, '--set-yaml', `w=${given}`, '--go', '--brief']);
    assert.equal(r.status, 1, given);
    assert.ok(r.stdout.split('\n')[0].includes(`v: ${given} is written as ${written}`), r.stdout);
    assert.ok(r.stdout.split('\n')[0].includes(`w: ${given} is written as ${written}`), r.stdout); // on an insert too
    assert.equal(get(f), `---\ntitle: T\nv: ${written}\nw: ${written}\n---\n`);
  }
  const f = put(dir, 'b.md', '---\ntitle: T\n---\n');
  assert.equal(run([f, '--set-yaml', 'v=1.5', '--brief']).status, 0); // written as given: no warn
}));

test('5: a key with leading or trailing whitespace is a usage error', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  for (const args of [['--set', 'status =closed'], ['--set', ' status=closed'], ['--unset', 'status '], ['--set', 'a=b', '--where', 'status =open']]) {
    const r = run([f, ...args]);
    assert.equal(r.status, 2, JSON.stringify(args));
    assert.equal(r.stdout, '');
  }
}));

test('6 (M06): an edit that changes another key through an anchor is refused', () => scratch((dir) => {
  const src = '---\nbase: &b x\nuse: *b\n---\n';
  const f = put(dir, 'a.md', src);
  const out = JSON.parse(run([f, '--set', 'base=y', '--go', '--json']).stdout);
  assert.equal(out.items[0].verdict, 'refuse');
  assert.match(out.items[0].reason, /the untouched key use reads differently/);
  assert.equal(get(f), src);
}));

test('6 (M09): a tag that would make the set value read back as a number is refused', () => scratch((dir) => {
  const src = '---\nm: !!int 7\n---\n';
  const f = put(dir, 'a.md', src);
  const out = JSON.parse(run([f, '--set', 'm=8', '--go', '--json']).stdout);
  assert.equal(out.items[0].verdict, 'refuse');
  assert.match(out.items[0].reason, /m reads back as 8, not the value set/);
  assert.equal(get(f), src);
}));

test('6 (M12): the plan covers the bytes read, so a file changed to the same result is still held back', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\nstatus: open\n---\nbody\n');
  const plan = JSON.parse(run([f, '--set', 'status=closed', '--json']).stdout).state.plan;
  writeFileSync(f, '---\nstatus: pending\n---\nbody\n');
  assert.equal(run([f, '--set', 'status=closed', '--go', '--plan', plan]).status, 1);
  assert.equal(get(f), '---\nstatus: pending\n---\nbody\n');
}));

test('6 (M17): the same file named twice is one item', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\nstatus: open\n---\n');
  const out = JSON.parse(run([f, path.join(dir, '.', 'a.md'), '--set', 'status=closed', '--go', '--json']).stdout);
  assert.equal(out.items.length, 1);
  assert.equal(out.exit, 0);
}));

test('6 (M19): a file with a NUL byte is refused and left alone', () => scratch((dir) => {
  const b = Buffer.from('---\nstatus: open\n---\nx\u0000y\n');
  const f = put(dir, 'a.md', b);
  const out = JSON.parse(run([f, '--set', 'status=closed', '--go', '--json']).stdout);
  assert.deepEqual([out.items[0].verdict, out.items[0].summary], ['refuse', 'binary file']);
  assert.ok(readFileSync(f).equals(b));
}));

test('6 (M20): a Latin-1 body is refused as not UTF-8 and left alone', () => scratch((dir) => {
  const b = Buffer.concat([Buffer.from('---\nstatus: open\n---\ncaf'), Buffer.from([0xe9]), Buffer.from('\n')]);
  const f = put(dir, 'a.md', b);
  const out = JSON.parse(run([f, '--set', 'status=closed', '--go', '--json']).stdout);
  assert.deepEqual([out.items[0].verdict, out.items[0].summary], ['refuse', 'not UTF-8']);
  assert.ok(readFileSync(f).equals(b));
}));

test('6 (M21): an empty value matches --where k=', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\nk:\n---\n');
  assert.equal(JSON.parse(run([f, '--set', 'z=1', '--where', 'k=', '--json']).stdout).items[0].verdict, 'ok');
}));

test('6 (M22): a list never matches --where', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\nk: [a]\n---\n');
  const item = JSON.parse(run([f, '--set', 'z=1', '--where', 'k=a', '--json']).stdout).items[0];
  assert.deepEqual([item.verdict, item.reason], ['skip', '--where k=a: k is a list or mapping']);
}));

test('6 (M28): an inserted key takes the indent of the first key', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\n  a: 1\n---\n');
  assert.equal(run([f, '--set', 'nk=v', '--go']).status, 0);
  assert.equal(get(f), '---\n  a: 1\n  nk: v\n---\n');
}));

test('7: --where matches a number or null by its source text', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\nn1: null\nn2: ~\ne:\nz: 0123\nbig: 12345678901234567890\n---\n');
  const holds = (cond) => JSON.parse(run([f, '--set', 'q=1', '--where', cond, '--json']).stdout).items[0].verdict === 'ok';
  for (const cond of ['n1=null', 'n2=~', 'e=', 'z=0123', 'big=12345678901234567890']) assert.ok(holds(cond), cond);
  for (const cond of ['n1=', 'n2=', 'n2=null', 'e=null', 'z=123', 'big=12345678901234567000']) assert.ok(!holds(cond), cond);
}));

test('8: a comment after the colon stays when the value is empty or on the next lines', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\nempty:   # fill me\ntags: # one per line\n  - a\n  - b\n---\n');
  const r = run([f, '--set', 'empty=v', '--set', 'tags=x', '--go', '--brief']);
  assert.equal(r.status, 1, r.stdout); // a list replaced by a string is a warn
  assert.match(r.stdout, /^warn .*\(tags was a list and is written as a string;/m);
  assert.equal(get(f), '---\nempty: v   # fill me\ntags: x # one per line\n---\n');
}));

test('9: an NFD key in the file is the same key as an NFC --set', () => scratch((dir) => {
  const nfd = `cafe${String.fromCharCode(0x301)}`; // e + combining acute
  const f = put(dir, 'a.md', `---\n${nfd}: old\n---\n`);
  assert.equal(run([f, '--set', `${nfd.normalize('NFC')}=new`, '--go']).status, 0);
  assert.equal(get(f), `---\n${nfd}: new\n---\n`);
  const g = put(dir, 'b.md', `---\n${nfd.normalize('NFC')}: old\n---\n`); // and the other way round
  assert.equal(run([g, '--set', `${nfd}=new`, '--go']).status, 0);
  assert.equal(get(g), `---\n${nfd.normalize('NFC')}: new\n---\n`);
}));

test('10: two names of one file (a hard link, another letter case) are one item', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\nstatus: open\n---\n');
  const g = path.join(dir, 'b.md');
  linkSync(f, g);
  const names = [f, g];
  const upper = path.join(dir, 'A.md');
  if (existsSync(upper)) names.push(upper); // a case-insensitive volume
  const out = JSON.parse(run([...names, '--set', 'status=closed', '--go', '--json']).stdout);
  assert.equal(out.items.length, 1);
  assert.equal(out.exit, 0);
  assert.equal(get(g), '---\nstatus: closed\n---\n');
}));

test('11: a value or key with a control character, U+2028 or U+2029 is a usage error', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  for (const code of [0x2028, 0x2029, 0x01, 0x1b, 0x7f, 0x85]) {
    const c = String.fromCharCode(code);
    assert.equal(run([f, '--set', `k=a${c}b`]).status, 2, code.toString(16));
    assert.equal(run([f, '--set', `k${c}=b`]).status, 2, code.toString(16));
  }
  assert.equal(run([f, '--set', 'k=a\tb']).status, 0); // a tab is allowed
}));

test('12: a value YAML 1.2 reads as a number (0o17) is quoted, and reads back as the string', () => scratch((dir) => {
  assert.equal(scalarText('0o17'), '"0o17"');
  const f = put(dir, 'a.md', '---\ntitle: T\n---\n');
  assert.equal(run([f, '--set', 'mode=0o17', '--go']).status, 0);
  assert.equal(get(f), '---\ntitle: T\nmode: "0o17"\n---\n');
}));

test('F1: a write that fails partway is restored from the backup, and the item fails saying so', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const item = planOne({ path: f }, buildSpec({ set: ['status=closed'] }));
  // the fake write tears the file (cuts it short, then writes other bytes), then throws
  writeOne(item, { write: (fd) => { ftruncateSync(fd, 3); writeSync(fd, 'torn', 3); throw new Error('EFBIG: file too large'); } });
  assert.equal(get(f), DOC);
  assert.equal(item.summary, 'write failed');
  assert.match(item.reason, /restored from the backup /);
}));

test('F2: --set-yaml refuses an integer too large to write exactly', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\ntitle: T\n---\n');
  for (const big of ['12345678901234567890', '9007199254740993']) {
    const r = run([f, '--set-yaml', `id=${big}`, '--go']);
    assert.equal(r.status, 2, big);
    assert.match(r.stderr, /too large to write exactly/);
  }
  assert.equal(run([f, '--set-yaml', 'id=9007199254740991', '--go']).status, 0);
  assert.equal(get(f), '---\ntitle: T\nid: 9007199254740991\n---\n');
}));

// ---- release fix round 1 (the gate's findings and surviving mutants) --------

// writeOne() in this process, with a backup folder of the test's own.
function withOwnBackup(fn) {
  const bk = mkdtempSync(path.join(tmpdir(), 'fmset-bk-'));
  const was = process.env.FRONTMATTER_SET_BACKUP_DIR;
  process.env.FRONTMATTER_SET_BACKUP_DIR = bk;
  try { return fn(bk); } finally { process.env.FRONTMATTER_SET_BACKUP_DIR = was; rmSync(bk, { recursive: true, force: true }); }
}

test('W1: a file changed between the plan and the write keeps the other writer’s bytes, gets no backup, and fails', () => scratch((dir) => withOwnBackup((bk) => {
  const f = put(dir, 'a.md', '---\nstatus: open\n---\nbody\n');
  const item = planOne({ path: f }, buildSpec({ set: ['status=closed'] }));
  writeFileSync(f, '---\nstatus: pending\n---\nbody\n'); // another writer
  writeOne(item);
  assert.equal(get(f), '---\nstatus: pending\n---\nbody\n');
  assert.deepEqual(filesUnder(bk), []);
  assert.equal(item.summary, 'changed underneath');
  assert.equal(verdict(item), 'fail');
  assert.equal(item.changed, false);
})));

test('W2: a backup that does not read back as the file’s bytes fails the item, and the file is untouched', () => scratch((dir) => withOwnBackup(() => {
  const f = put(dir, 'a.md', DOC);
  const item = planOne({ path: f }, buildSpec({ set: ['status=closed'] }));
  writeOne(item, { copy: (src, dest) => writeFileSync(dest, 'other bytes') });
  assert.equal(item.summary, 'backup failed');
  assert.match(item.reason, /does not hold the file's bytes; nothing was written$/);
  assert.equal(verdict(item), 'fail');
  assert.equal(get(f), DOC);
})));

test('7: every option parseArgs takes is listed under Flags in --help', () => {
  const src = readFileSync(TOOL_PATH, 'utf8');
  const block = src.slice(src.indexOf('parseArgs({'), src.indexOf('});', src.indexOf('parseArgs({')));
  const options = [...block.matchAll(/^\s+'?([a-z][a-z-]*)'?: \{ type:/gm)].map((m) => m[1]);
  assert.ok(options.length >= 12, options.join(' '));
  const help = run(['--help']).stdout;
  const flags = help.slice(help.indexOf('\nFlags:'), help.indexOf('\n\n', help.indexOf('\nFlags:')));
  // A word boundary, so `--set` is not satisfied by `--set-yaml`.
  for (const name of options) assert.ok(new RegExp(`--${name}(?![-\\w])`).test(flags), `--${name} in Flags`);
});

test('V4: a --set-yaml string whose decoded value holds a control character or a line break is a usage error', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\ntitle: T\n---\n');
  for (const v of ['v="a\\u0001b"', 'v="a\\nb"', 'v="a\\u2028b"']) {
    const r = run([f, '--set-yaml', v, '--go']);
    assert.equal(r.status, 2, v);
  }
  assert.equal(get(f), '---\ntitle: T\n---\n');
}));

test('9: a relative XDG_STATE_HOME is ignored (the XDG spec); an absolute one is the backup root (not macOS)', () => scratch((home) => {
  const code = [
    "Object.defineProperty(process, 'platform', { value: 'linux' });",
    `const m = await import(${JSON.stringify(pathToFileURL(TOOL_PATH).href)});`,
    "const item = m.planOne({ path: process.env.FMSET_FILE }, m.buildSpec({ set: ['status=closed'] }));",
    'm.writeOne(item);',
    'console.log(item.data.backup ?? item.error);',
  ].join('\n');
  const backupFor = (xdg) => {
    const f = put(home, 'a.md', '---\nstatus: open\n---\n');
    const env = { ...process.env, HOME: home, XDG_STATE_HOME: xdg, FRONTMATTER_SET_BACKUP_DIR: '', FMSET_FILE: f };
    const r = spawnSync(NODE, ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: home, env, timeout: 15000 });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.ok(backupFor('relative/state').startsWith(path.join(home, '.local', 'state', 'frontmatter-set', 'backup') + path.sep));
  assert.ok(!existsSync(path.join(home, 'relative')));
  assert.ok(backupFor(path.join(home, 'xdg')).startsWith(path.join(home, 'xdg', 'frontmatter-set', 'backup') + path.sep));
}));

test('E13: two keys that are one key once NFC-normalised are refused', () => scratch((dir) => {
  const src = `---\ncafe${String.fromCharCode(0x301)}: a\ncafé: b\n---\n`;
  const f = put(dir, 'a.md', src);
  const out = JSON.parse(run([f, '--set', 'status=closed', '--go', '--json']).stdout);
  assert.deepEqual([out.items[0].verdict, out.items[0].summary], ['refuse', 'duplicate key']);
  assert.equal(get(f), src);
}));

test('P3: the plan covers each file’s path, so two files with the same bytes give two plans', () => scratch((dir) => {
  const a = put(dir, 'a.md', DOC);
  const b = put(dir, 'b.md', DOC);
  const plan = (f) => JSON.parse(run([f, '--set', 'status=closed', '--json']).stdout).state.plan;
  assert.notEqual(plan(a), plan(b));
}));

test('P6: after a plan mismatch given as --plan=<hex>, the advised dry run carries no --plan and no --go', () => scratch((dir) => {
  const f = put(dir, 'a.md', DOC);
  const out = JSON.parse(run([f, '--set', 'status=closed', '--go', '--plan=0000000000000000', '--json']).stdout);
  assert.equal(out.exit, 1);
  assert.equal(get(f), DOC);
  assert.ok(out.next.argv.every((a) => a !== '--go' && !a.startsWith('--plan')), out.next.argv.join(' '));
  assert.ok(out.next.argv.includes(f));
}));

test('F4: a sub-folder named like a Markdown file is not an item of its folder', () => scratch((dir) => {
  put(dir, 'a.md', DOC);
  mkdirSync(path.join(dir, 'sub.md'));
  const r = run([dir, '--set', 'status=closed', '--json']);
  assert.deepEqual(JSON.parse(r.stdout).items.map((i) => path.basename(i.path)), ['a.md']);
  assert.equal(r.status, 0);
}));

test('E16: a closing --- with trailing blanks still closes the frontmatter, and is kept', () => scratch((dir) => {
  const f = put(dir, 'a.md', '---\nstatus: open\n--- \t\nbody\n');
  assert.equal(run([f, '--set', 'status=closed', '--go']).status, 0);
  assert.equal(get(f), '---\nstatus: closed\n--- \t\nbody\n');
}));
