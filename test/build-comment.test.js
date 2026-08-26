const { test } = require('node:test');
const assert = require('node:assert');
const {
  buildComment,
  MARKER,
} = require('../.github/actions/tf-plan-comment/build-comment.js');

const fakeFs = (files) => ({
  existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
  readFileSync: (p) => files[p],
});

test('starts with marker and heading, footer has short sha and run link', () => {
  const out = buildComment({
    stacks: ['storage'],
    plansDir: '/plans',
    headSha: 'abcdef1234567890',
    runUrl: 'https://example/run',
    ranAt: '2026-08-25 00:00:00 UTC',
    fs: fakeFs({
      '/plans/storage.txt':
        'No changes. Your infrastructure matches the configuration.',
    }),
  });
  assert.ok(out.startsWith(MARKER));
  assert.match(out, /### Terraform Plan/);
  assert.match(out, /commit abcdef1 /);
  assert.match(out, /\[run\]\(https:\/\/example\/run\)/);
  assert.match(out, /✅ Stack: <code>storage<\/code>/); // green check = no changes
});

test('changes render the book emoji', () => {
  const out = buildComment({
    stacks: ['catalog'],
    plansDir: '/plans',
    headSha: '1234567',
    runUrl: 'u',
    ranAt: 't',
    fs: fakeFs({ '/plans/catalog.txt': 'Plan: 1 to add, 0 to change, 0 to destroy.' }),
  });
  assert.match(out, /📖 Stack: <code>catalog<\/code>/);
});

test('missing plan file renders no-plan and warning emoji', () => {
  const out = buildComment({
    stacks: ['mwaa'],
    plansDir: '/plans',
    headSha: '0000000',
    runUrl: 'u',
    ranAt: 't',
    fs: fakeFs({}),
  });
  assert.match(out, /\(no plan produced\)/);
  assert.match(out, /⚠️ Stack: <code>mwaa<\/code>/);
});

test('bodies over 50k chars are truncated', () => {
  const big = 'x'.repeat(60000);
  const out = buildComment({
    stacks: ['big'],
    plansDir: '/plans',
    headSha: '0000000',
    runUrl: 'u',
    ranAt: 't',
    fs: fakeFs({ '/plans/big.txt': big }),
  });
  assert.match(out, /\.\.\. \(truncated\)/);
});

test('many stacks with large bodies stay under 65536 total', () => {
  const stacks = Array.from({ length: 8 }, (_, i) => `stack${i}`);
  const files = {};
  stacks.forEach((s) => {
    files[`/plans/${s}.txt`] = 'x'.repeat(50000);
  });
  const out = buildComment({
    stacks,
    plansDir: '/plans',
    headSha: '0000000',
    runUrl: 'u',
    ranAt: 't',
    fs: fakeFs(files),
  });
  assert.ok(out.length < 65536, `comment body is ${out.length} chars (must be < 65536)`);
});
