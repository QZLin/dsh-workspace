import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEndpoint } from '../src/endpoint.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const binary = resolve(process.argv[2] ?? join(root, 'dist', process.platform === 'win32' ? 'dsh-workspace.exe' : 'dsh-workspace'));
const scratchRoot = join(root, '.tmp');
const report = { profile: null, endpoint: null, checks: [], restored: false };
let baseline;
let fixture;
let fixtureRealpath;
let ownedId;
let removed = false;
let uncertainMutation = false;

async function cli(command, { expectedExit = 0, mutation = false } = {}) {
  const args = ['--json', '--timeout', '5000', ...command];
  const execution = await new Promise((resolveExecution, reject) => {
    const child = spawn(binary, args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let forced = false;
    const timeout = setTimeout(() => { forced = true; child.kill(); }, 8000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timeout); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolveExecution({ stdout, stderr, code, signal, forced });
    });
  }).catch((error) => {
    if (mutation) uncertainMutation = true;
    throw error;
  });
  if (mutation && (execution.forced || execution.signal || [3, 4, 5].includes(execution.code))) {
    uncertainMutation = true;
  }
  assert.equal(execution.code, expectedExit, `CLI ${command[0]} exited ${execution.code}: ${execution.stderr}`);
  if (expectedExit !== 0) {
    assert.equal(execution.stdout, '', 'Errors must not be written to stdout');
    assert.ok(execution.stderr.trim(), 'Errors must explain failure on stderr');
    return execution;
  }
  try {
    return JSON.parse(execution.stdout);
  } catch (error) {
    if (mutation) uncertainMutation = true;
    throw new Error(`CLI ${command[0]} returned malformed JSON; do not replay the request`, { cause: error });
  }
}

function check(name) {
  report.checks.push(name);
  console.log(`OK ${name}`);
}

async function verifyRestored() {
  const restored = await cli(['list']);
  assert.deepEqual(restored, baseline, 'Existing workspace records/order must be restored exactly');
  report.restored = true;
}

async function removeFixtureDirectory() {
  if (!fixture || !removed || uncertainMutation) return;
  // Verify both the lexical target and the unchanged physical directory before
  // deleting test-only files. Never delete a computed or redirected user path.
  const absoluteTarget = resolve(fixture);
  assert.ok(absoluteTarget.startsWith(`${resolve(scratchRoot)}${sep}`));
  assert.equal(absoluteTarget, fixture);
  assert.equal(await realpath(absoluteTarget), fixtureRealpath);
  assert.ok((await stat(absoluteTarget)).isDirectory());
  console.log(`Remove verified test-only directory: ${absoluteTarget}`);
  await rm(absoluteTarget, { recursive: true, force: false });
}

try {
  assert.ok((await stat(binary)).isFile(), 'Build the native CLI before live verification');
  report.endpoint = await cli(['endpoint']);
  assert.equal(report.endpoint, resolveEndpoint(), 'Go/Node endpoint discovery must match');
  const ping = await cli(['ping']);
  assert.equal(ping.service, 'dsh-workspace');
  assert.equal(ping.protocolVersion, 1);
  report.profile = ping.profile;
  check('native CLI connects to the installed current-profile plugin');
  baseline = await cli(['list']);
  assert.ok(Array.isArray(baseline));
  await mkdir(scratchRoot, { recursive: true });
  fixture = await mkdtemp(join(scratchRoot, 'ipc-live-'));
  fixtureRealpath = await realpath(fixture);
  const title = 'IPC 实机验证 原始标题';
  const added = await cli(['add', fixture, '--title', title], { mutation: true });
  assert.equal(typeof added.id, 'string');
  assert.ok(!baseline.some((workspace) => workspace.id === added.id), 'Test may not own an existing workspace');
  ownedId = added.id;
  report.testWorkspaceId = ownedId;
  assert.deepEqual(added, { id: ownedId, path: fixtureRealpath, title });
  check('add registers via workspaceRegistry and returns its canonical result');
  const again = await cli(['add', `${fixture}${sep}.`, '--title', '不会覆盖'], { mutation: true });
  assert.deepEqual(again, added);
  check('repeated add preserves id and original title');
  assert.deepEqual(await cli(['resolve', `${fixture}${sep}.`]), added);
  const detail = await cli(['get', ownedId]);
  assert.equal(detail.path, fixtureRealpath);
  assert.equal(typeof detail.createdAt, 'string');
  assert.equal(typeof detail.updatedAt, 'string');
  assert.deepEqual(detail.sessionIds, []);
  assert.deepEqual(await cli(['status', ownedId]), { id: ownedId, status: 'ok' });
  check('list/get/resolve/status use the same live registry');
  const renamed = await cli(['rename', ownedId, 'IPC 验证新标题'], { mutation: true });
  assert.equal(renamed.title, 'IPC 验证新标题');
  const beforeNoop = await cli(['get', ownedId]);
  await cli(['rename', ownedId, 'IPC 验证新标题'], { mutation: true });
  assert.equal((await cli(['get', ownedId])).updatedAt, beforeNoop.updatedAt);
  check('rename works and identical rename is a no-op');
  if (baseline.length) {
    const order = await cli(['move', ownedId, '--before', baseline[0].id], { mutation: true });
    assert.equal(order.order[0], ownedId);
  }
  const appended = await cli(['move', ownedId], { mutation: true });
  assert.equal(appended.order.at(-1), ownedId);
  assert.deepEqual(appended.order.filter((id) => id !== ownedId), baseline.map((workspace) => workspace.id));
  check('move changes only the test workspace position');
  await cli(['add', 'relative/业务路径'], { expectedExit: 1 });
  const regularFile = join(fixture, 'not-a-directory.txt');
  await writeFile(regularFile, 'test-only file\n', 'utf8');
  await cli(['add', regularFile], { expectedExit: 1 });
  await cli(['get', `unknown-${randomUUID()}`], { expectedExit: 1 });
  check('relative paths/files/unknown ids fail remotely with exit 1');
  assert.deepEqual(await cli(['remove', ownedId], { mutation: true }), { id: ownedId, deleted: true });
  removed = true;
  assert.deepEqual(await cli(['remove', ownedId], { mutation: true }), { id: ownedId, deleted: false });
  assert.equal(await cli(['resolve', fixture]), null);
  assert.equal(await (stat(regularFile)).then((value) => value.isFile()), true);
  check('remove is idempotent and retains files/directory');
  await verifyRestored();
  check('original workspace records and order restored exactly');
  await removeFixtureDirectory();
  report.completedAt = new Date().toISOString();
  await mkdir(join(root, 'dist'), { recursive: true });
  await writeFile(join(root, 'dist', 'live-verification.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.stack ?? String(error));
  // A known successful test registration may be cleaned up once, but uncertain
  // writes are never reconnected/replayed, not even to hide a failed test.
  if (ownedId && !removed && !uncertainMutation) {
    try {
      await cli(['remove', ownedId], { mutation: true });
      removed = true;
      await verifyRestored();
      await removeFixtureDirectory();
    } catch (cleanupError) {
      console.error(`Test cleanup failed; inspect workspace ${ownedId}: ${cleanupError.message}`);
    }
  }
  if (uncertainMutation) {
    console.error(`No mutation retried. Inspect test workspace id=${ownedId ?? 'unknown'}, path=${fixture ?? 'not created'} with list/resolve before any manual cleanup.`);
  }
  process.exitCode = 1;
}
