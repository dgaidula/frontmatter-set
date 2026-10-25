// The runtime fence is the skeleton's, unedited. Pinning its hash (rather than
// porting the skeleton's runtime suite, which re-tests identical bytes) is the
// "lighter path" in mjs-tool-skeleton's ADOPTING.md section 6.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_PATH = fileURLToPath(new URL('../frontmatter-set.mjs', import.meta.url));
const START = '// ---- mjs-tool runtime v3 (do not edit; replace wholesale) ----';
const END = '// ---- end mjs-tool runtime v3 ----';
// sha256 of the fence, from its start marker through its end marker, as it
// stands in mjs-tool-skeleton 0.4.0 (skeleton/tool.mjs).
const FENCE_SHA256 = '1f1c5c19df209089efd5e19a5b6a98535be2dfb5b97f7013410567cec133fa4a';

function fenceOf(file) {
  const src = readFileSync(file, 'utf8');
  const from = src.indexOf(START);
  const to = src.indexOf(END);
  assert.ok(from >= 0 && to > from, 'fence markers present');
  return src.slice(from, to + END.length) + '\n';
}
const sha = (s) => createHash('sha256').update(s).digest('hex');

test('fence: the runtime block is byte-identical to the skeleton (pinned by hash)', () => {
  assert.equal(sha(fenceOf(TOOL_PATH)), FENCE_SHA256);
});

test('fence: matches the live skeleton checkout too, when one is present', (t) => {
  const skeleton = path.join(homedir(), 'sw/github-public/mjs-tool-skeleton/skeleton/tool.mjs');
  if (!existsSync(skeleton)) return t.skip('no skeleton checkout on this machine');
  assert.equal(sha(fenceOf(TOOL_PATH)), sha(fenceOf(skeleton)));
});

test('fence: nothing follows the end marker', () => {
  const src = readFileSync(TOOL_PATH, 'utf8');
  assert.equal(src.slice(src.indexOf(END) + END.length), '\n');
});
