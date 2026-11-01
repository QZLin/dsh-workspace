import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { createWorkspaceIpcServer } from '../src/server.js';
import {
  FakeRegistry, JsonPeer, TEST_TIMEOUT, assertError, assertResult, closeServer,
  deadline, deferred, fixture, isolatedEndpoint, listen, removeScratchDirectory,
  request, scratchDirectory,
} from './support/fixtures.mjs';

const options = { timeout: TEST_TIMEOUT };
const unixOnly = { ...options, skip: process.platform === 'win32' ? 'Unix filesystem socket behavior' : false };
const ping = { service: 'dsh-workspace', protocolVersion: 1, profile: null };
const PRIVATE_ALIAS = /^\._dwi[0-9a-f]{12}$/;

async function ownedPrivateLayout(directory, endpoint) {
  const publicStat = await fs.lstat(endpoint);
  assert.equal(publicStat.isSocket(), true);
  const matches = [];
  for (const name of (await fs.readdir(directory)).filter((entry) => PRIVATE_ALIAS.test(entry))) {
    const privateDirectory = path.join(directory, name);
    const directoryStat = await fs.lstat(privateDirectory);
    if (!directoryStat.isDirectory()) continue; // Foreign legacy sockets/files are not bind dirs.
    const privateSocket = path.join(privateDirectory, 's');
    let socketStat;
    try {
      socketStat = await fs.lstat(privateSocket);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (socketStat.isSocket() && socketStat.ino === publicStat.ino
      && socketStat.dev === publicStat.dev && socketStat.uid === publicStat.uid) {
      matches.push({ privateDirectory, privateSocket, directoryStat, socketStat });
    }
  }
  assert.equal(matches.length, 1, 'one private-directory child socket owns the public hard link');
  const layout = matches[0];
  assert.equal(layout.directoryStat.mode & 0o777, 0o700);
  assert.equal(layout.directoryStat.uid, publicStat.uid);
  assert.equal(layout.socketStat.mode & 0o777, 0o600);
  assert.ok(layout.socketStat.nlink >= 2, 'private and public socket names share one inode');
  return layout;
}

async function assertNoAliases(directory) {
  const aliases = (await fs.readdir(directory)).filter((name) => PRIVATE_ALIAS.test(name));
  assert.deepEqual(aliases, [], 'instance-owned private bind files/directories must be removed');
}

test('Dispose closes every peer and the listener, is concurrent/idempotent, and rejects new connections', options, async (t) => {
  const fx = await fixture(t, { profile: null });
  const first = await fx.connect();
  const second = await fx.connect();
  assertResult(await first.call('workspace.ping', {}, 'first'), 'first', ping);
  assertResult(await second.call('workspace.ping', {}, 'second'), 'second', ping);
  await deadline(Promise.all([fx.handle.dispose(), fx.handle.dispose(), fx.handle.dispose()]), 'concurrent disposal');
  await Promise.all([first.closed(), second.closed()]);
  assert.equal(fx.handle.server.listening, false);
  await fx.handle.dispose();
  await assert.rejects(JsonPeer.connect(fx.endpoint));
  if (process.platform !== 'win32') {
    await assert.rejects(fs.lstat(fx.endpoint), { code: 'ENOENT' });
    await assertNoAliases(fx.directory);
  }
});

test('Bind collision refuses a live endpoint without disrupting its existing owner or executing probe requests', options, async (t) => {
  const fx = await fixture(t, { profile: null });
  let unexpected;
  t.after(async () => { if (unexpected) await unexpected.dispose(); });
  await assert.rejects(async () => {
    unexpected = await createWorkspaceIpcServer({ registry: new FakeRegistry(), endpoint: fx.endpoint, profile: 'other' });
  }, { code: 'EADDRINUSE' });
  assert.equal(fx.registry.calls.length, 0, 'liveness probes do not call business methods');
  assertResult(await (await fx.connect()).call('workspace.ping', {}, 'original'), 'original', ping);
  assert.equal(fx.handle.server.listening, true);
});

test('Simultaneous binds produce exactly one owner and preserve its usable endpoint', options, async (t) => {
  const directory = await scratchDirectory();
  const endpoint = isolatedEndpoint(directory);
  const handles = [];
  let peer;
  t.after(async () => {
    try {
      if (peer) await peer.dispose();
      await Promise.all(handles.map((handle) => handle.dispose()));
    } finally {
      await removeScratchDirectory(directory);
    }
  });
  const outcomes = await Promise.allSettled([
    createWorkspaceIpcServer({ registry: new FakeRegistry(), endpoint, profile: null }),
    createWorkspaceIpcServer({ registry: new FakeRegistry(), endpoint, profile: null }),
  ]);
  handles.push(...outcomes.filter((outcome) => outcome.status === 'fulfilled').map((outcome) => outcome.value));
  assert.equal(handles.length, 1, 'only one start may claim an endpoint');
  assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
  peer = await JsonPeer.connect(endpoint);
  assertResult(await peer.call('workspace.ping', {}, 'race-winner'), 'race-winner', ping);
});

test('A disposed endpoint can be rebound by a new isolated listener', options, async (t) => {
  const directory = await scratchDirectory();
  const endpoint = isolatedEndpoint(directory);
  const handles = [];
  const peers = [];
  t.after(async () => {
    try {
      await Promise.all(peers.map((peer) => peer.dispose()));
      await Promise.all(handles.map((handle) => handle.dispose()));
    } finally {
      await removeScratchDirectory(directory);
    }
  });
  const first = await createWorkspaceIpcServer({ registry: new FakeRegistry(), endpoint, profile: 'first' });
  handles.push(first);
  await first.dispose();
  const second = await createWorkspaceIpcServer({ registry: new FakeRegistry(), endpoint, profile: 'second' });
  handles.push(second);
  const peer = await JsonPeer.connect(endpoint);
  peers.push(peer);
  assertResult(await peer.call('workspace.ping', {}, 'rebound'), 'rebound', { ...ping, profile: 'second' });
});

test('Incomplete final frames are not executed and are not replayed after reconnect', options, async (t) => {
  const fx = await fixture(t, { profile: null });
  const peer = await fx.connect();
  await peer.write(Buffer.from(JSON.stringify(request('workspace.add', { path: './never-execute' }, 'incomplete'))));
  peer.socket.end();
  const outcome = await peer.nextOutcome();
  // Windows named-pipe shutdown closes both directions; raw net replies after EOF get EPIPE.
  if (process.platform === 'win32' && outcome.kind === 'closed') {
    assert.equal(peer.receivedBytes, 0);
  } else {
    assert.equal(outcome.kind, 'frame');
    assertError(outcome.value, -32700, null);
  }
  await peer.closed();
  assert.equal(fx.registry.calls.length, 0);
  const fresh = await fx.connect();
  assertResult(await fresh.call('workspace.ping', {}, 'after-incomplete'), 'after-incomplete', ping);
  assert.equal(fx.registry.calls.length, 0);
});

test('An accepted complete frame commits once across write-end shutdown', options, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const registry = new FakeRegistry({ hooks: {
    async create(rawPath, title, self) {
      entered.resolve();
      await release.promise;
      return self.seed({ id: 'half-closed-once', path: rawPath, title });
    },
  } });
  const fx = await fixture(t, { registry });
  const peer = await fx.connect();
  const rawPath = path.join(fx.directory, 'half-close-project');
  const workspace = { id: 'half-closed-once', path: rawPath, title: 'Half-closed' };
  await peer.send(request('workspace.add', { path: rawPath, title: workspace.title }, 'half-close'));
  await deadline(entered.promise, 'complete frame enters registry before write-end shutdown');
  peer.socket.end();
  release.resolve();
  const outcome = await peer.nextOutcome();
  if (outcome.kind === 'frame') assertResult(outcome.value, 'half-close', workspace);
  else assert.equal(process.platform, 'win32', 'Unix half-closed streams can still receive replies');
  await peer.closed();
  const fresh = await fx.connect();
  assertResult(await fresh.call('workspace.list', {}, 'read-committed'), 'read-committed', [workspace]);
  assert.equal(registry.callsFor('create').length, 1);
});

test('Disposal does not replay or roll back an executing mutation and skips operations still queued', options, async (t) => {
  const entered = deferred();
  const release = deferred();
  const committed = deferred();
  t.after(() => release.resolve());
  const registry = new FakeRegistry({ hooks: {
    async create(rawPath, title, self) {
      entered.resolve();
      await release.promise;
      const workspace = self.seed({ id: 'executed-once', path: rawPath, title });
      committed.resolve(workspace);
      return workspace;
    },
  } });
  const fx = await fixture(t, { registry });
  const peer = await fx.connect();
  const runningPath = path.join(fx.directory, 'running');
  const queuedPath = path.join(fx.directory, 'queued');
  await peer.send(request('workspace.add', { path: runningPath, title: 'Running' }, 'running'));
  await deadline(entered.promise, 'executing mutation enters registry');
  await peer.send(request('workspace.add', { path: queuedPath, title: 'Queued' }, 'queued'));
  await deadline(fx.handle.dispose(), 'dispose while an operation is blocked');
  await peer.closed();
  release.resolve();
  await deadline(committed.promise, 'accepted mutation finishes once');
  // One scheduler-turn fence drains the old listener's promise continuations; no sleep or polling.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(registry.callsFor('create').map((call) => call.args[0]), [runningPath]);
  assert.equal(registry.records.get('executed-once').path, runningPath);
});

async function rejectedFilesystemEndpoint(t, prepare) {
  const directory = await scratchDirectory();
  const endpoint = isolatedEndpoint(directory);
  let unexpected;
  t.after(async () => {
    try { if (unexpected) await unexpected.dispose(); }
    finally { await removeScratchDirectory(directory); }
  });
  await prepare(directory, endpoint);
  await assert.rejects(async () => {
    unexpected = await createWorkspaceIpcServer({ registry: new FakeRegistry(), endpoint });
  });
  return { directory, endpoint };
}

test('Unix startup refuses a regular file without changing its contents', unixOnly, async (t) => {
  const { endpoint } = await rejectedFilesystemEndpoint(t, async (_, endpoint) => {
    await fs.writeFile(endpoint, 'regular-file-sentinel');
  });
  assert.equal((await fs.lstat(endpoint)).isFile(), true);
  assert.equal(await fs.readFile(endpoint, 'utf8'), 'regular-file-sentinel');
});

test('Unix startup refuses a symlink without following or removing it', unixOnly, async (t) => {
  let target;
  const { endpoint } = await rejectedFilesystemEndpoint(t, async (directory, endpoint) => {
    target = path.join(directory, 'target.txt');
    await fs.writeFile(target, 'symlink-target-sentinel');
    await fs.symlink(target, endpoint);
  });
  assert.equal((await fs.lstat(endpoint)).isSymbolicLink(), true);
  assert.equal(await fs.readlink(endpoint), target);
  assert.equal(await fs.readFile(target, 'utf8'), 'symlink-target-sentinel');
});

test('Unix startup refuses directories at the endpoint', unixOnly, async (t) => {
  const { endpoint } = await rejectedFilesystemEndpoint(t, async (_, endpoint) => {
    await fs.mkdir(endpoint);
    await fs.writeFile(path.join(endpoint, 'sentinel'), 'directory-sentinel');
  });
  assert.equal((await fs.lstat(endpoint)).isDirectory(), true);
  assert.equal(await fs.readFile(path.join(endpoint, 'sentinel'), 'utf8'), 'directory-sentinel');
});

test('Unix public sockets are 0600, private bind directories are 0700, and disposal removes owned names', unixOnly, async (t) => {
  const fx = await fixture(t, { profile: null });
  const stat = await fs.lstat(fx.endpoint);
  assert.equal(stat.isSocket(), true);
  assert.equal(stat.mode & 0o777, 0o600);
  await ownedPrivateLayout(fx.directory, fx.endpoint);
  assertResult(await (await fx.connect()).call('workspace.ping', {}, 'secure-socket'), 'secure-socket', ping);
  await fx.handle.dispose();
  await assert.rejects(fs.lstat(fx.endpoint), { code: 'ENOENT' });
  await assertNoAliases(fx.directory);
});

test('Unix startup and disposal preserve the original process umask without setter calls', unixOnly, async (t) => {
  const nativeUmask = process.umask.bind(process);
  const originalMask = nativeUmask();
  const observed = t.mock.method(process, 'umask', (...args) => {
    assert.ok(args.length === 0 || args[0] === undefined, 'IPC must never change the process-global umask');
    return nativeUmask();
  });
  const fx = await fixture(t, { profile: null });
  await ownedPrivateLayout(fx.directory, fx.endpoint);
  assert.equal(nativeUmask(), originalMask);
  await fx.handle.dispose();
  assert.equal(nativeUmask(), originalMask);
  assert.equal(observed.mock.calls.some((call) => call.arguments[0] !== undefined), false);
  await assertNoAliases(fx.directory);
});

test('Unix disposal preserves a replacement regular file and removes only its own private alias', unixOnly, async (t) => {
  const fx = await fixture(t);
  assert.equal(path.dirname(fx.endpoint), fx.directory);
  await fs.unlink(fx.endpoint);
  await fs.writeFile(fx.endpoint, 'replacement-file-sentinel');
  await fx.handle.dispose();
  assert.equal((await fs.lstat(fx.endpoint)).isFile(), true);
  assert.equal(await fs.readFile(fx.endpoint, 'utf8'), 'replacement-file-sentinel');
  await assertNoAliases(fx.directory);
});

test('Unix disposal preserves a replacement symlink and its target', unixOnly, async (t) => {
  const fx = await fixture(t);
  const target = path.join(fx.directory, 'replacement-target');
  await fs.writeFile(target, 'replacement-target-sentinel');
  assert.equal(path.dirname(fx.endpoint), fx.directory);
  await fs.unlink(fx.endpoint);
  await fs.symlink(target, fx.endpoint);
  await fx.handle.dispose();
  assert.equal((await fs.lstat(fx.endpoint)).isSymbolicLink(), true);
  assert.equal(await fs.readlink(fx.endpoint), target);
  assert.equal(await fs.readFile(target, 'utf8'), 'replacement-target-sentinel');
  await assertNoAliases(fx.directory);
});

test('Unix disposal cannot unlink another live socket published at the old public path', unixOnly, async (t) => {
  const replacement = net.createServer((socket) => socket.end('{"jsonrpc":"2.0","id":"owner","result":"replacement"}\n'));
  t.after(() => closeServer(replacement));
  const fx = await fixture(t);
  assert.equal(path.dirname(fx.endpoint), fx.directory);
  await fs.unlink(fx.endpoint);
  await listen(replacement, fx.endpoint);
  const replacementStat = await fs.lstat(fx.endpoint);
  await fx.handle.dispose();
  const after = await fs.lstat(fx.endpoint);
  assert.equal(after.isSocket(), true);
  assert.equal(after.ino, replacementStat.ino);
  assert.equal(after.dev, replacementStat.dev);
  const peer = await fx.connect();
  assertResult(await peer.next(), 'owner', 'replacement');
  await peer.closed();
  await assertNoAliases(fx.directory);
});

async function startSocketChild(endpoint, plugin) {
  const source = plugin
    ? `import { createWorkspaceIpcServer } from ${JSON.stringify(new URL('../src/server.js', import.meta.url).href)};\nawait createWorkspaceIpcServer({ registry: { create() {} }, endpoint: process.argv[1], profile: null });\nprocess.stdout.write('ready\\n');`
    : `import net from 'node:net';\nnet.createServer(socket => socket.destroy()).listen(process.argv[1], () => process.stdout.write('ready\\n'));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, endpoint], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = deferred();
  let output = '';
  let errorOutput = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
    if (output.includes('ready\n')) ready.resolve();
  });
  child.stderr.on('data', (chunk) => { errorOutput += chunk.toString(); });
  child.once('error', ready.reject);
  child.once('exit', (code, signal) => {
    ready.reject(new Error(`Socket fixture exited before ready: ${code ?? signal}; ${errorOutput}`));
  });
  try {
    await deadline(ready.promise, 'isolated child socket bind acknowledgement');
    return child;
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await deadline(exited, 'terminate failed socket fixture');
    }
    throw error;
  }
}

async function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await deadline(exited, 'kill isolated socket fixture to produce a stale inode');
}

async function staleFixture(t, plugin, legacyFlat = false) {
  const directory = await scratchDirectory();
  const endpoint = isolatedEndpoint(directory);
  let child;
  let handle;
  let peer;
  let foreignOwner;
  t.after(async () => {
    try {
      await killChild(child);
      if (peer) await peer.dispose();
      if (handle) await handle.dispose();
      if (foreignOwner) await closeServer(foreignOwner);
    } finally {
      await removeScratchDirectory(directory);
    }
  });
  child = await startSocketChild(endpoint, plugin);
  const oldAliases = (await fs.readdir(directory)).filter((name) => PRIVATE_ALIAS.test(name));
  if (plugin) {
    assert.equal(oldAliases.length, 1, 'listener owns one private bind directory');
    await ownedPrivateLayout(directory, endpoint);
  }
  if (legacyFlat) {
    const name = '._dwiaaaaaaaaaaaa';
    await fs.link(endpoint, path.join(directory, name));
    oldAliases.push(name);
  }
  await killChild(child);
  assert.equal((await fs.lstat(endpoint)).isSocket(), true, 'SIGKILL leaves a real stale socket inode');
  const foreignAlias = path.join(directory, '._dwiffffffffffff');
  const foreignSocket = path.join(directory, '._dwieeeeeeeeeeee');
  let foreignStat;
  if (plugin) {
    await fs.writeFile(foreignAlias, 'foreign-alias-sentinel');
    foreignOwner = net.createServer((socket) => socket.destroy());
    await listen(foreignOwner, foreignSocket);
    foreignStat = await fs.lstat(foreignSocket);
  }
  handle = await createWorkspaceIpcServer({ registry: new FakeRegistry(), endpoint, profile: null });
  await ownedPrivateLayout(directory, endpoint);
  peer = await JsonPeer.connect(endpoint);
  assertResult(await peer.call('workspace.ping', {}, 'reclaimed'), 'reclaimed', ping);
  for (const name of oldAliases) await assert.rejects(fs.lstat(path.join(directory, name)), { code: 'ENOENT' });
  if (plugin) {
    assert.equal(await fs.readFile(foreignAlias, 'utf8'), 'foreign-alias-sentinel');
    const currentForeign = await fs.lstat(foreignSocket);
    assert.equal(currentForeign.isSocket(), true);
    assert.equal(currentForeign.ino, foreignStat.ino);
    assert.equal(currentForeign.dev, foreignStat.dev);
    assert.equal(foreignOwner.listening, true);
  }
  await handle.dispose();
  await assert.rejects(fs.lstat(endpoint), { code: 'ENOENT' });
  if (plugin) {
    assert.equal(await fs.readFile(foreignAlias, 'utf8'), 'foreign-alias-sentinel');
    assert.equal((await fs.lstat(foreignSocket)).isSocket(), true);
    assert.deepEqual((await fs.readdir(directory)).filter((name) => PRIVATE_ALIAS.test(name)).sort(), [
      '._dwieeeeeeeeeeee', '._dwiffffffffffff',
    ]);
  } else {
    await assertNoAliases(directory);
  }
}

test('Unix stale recovery also removes a matching legacy flat private socket alias', unixOnly, async (t) => {
  await staleFixture(t, false, true);
});

test('Unix startup reclaims a genuinely stale same-user raw socket', unixOnly, async (t) => {
  await staleFixture(t, false);
});

test('Unix crash recovery removes only matching-inode private aliases and preserves foreign prefix files', unixOnly, async (t) => {
  await staleFixture(t, true);
});

test('Unix permission errors during liveness probing never justify unlinking the existing socket', {
  ...options,
  skip: process.platform === 'win32' ? 'Unix permission behavior'
    : process.getuid?.() === 0 ? 'Root bypasses Unix socket mode checks' : false,
}, async (t) => {
  const directory = await scratchDirectory();
  const endpoint = isolatedEndpoint(directory);
  const owner = net.createServer((socket) => socket.destroy());
  let unexpected;
  t.after(async () => {
    try {
      if (unexpected) await unexpected.dispose();
      if (owner.listening) {
        await fs.chmod(endpoint, 0o600);
        await closeServer(owner);
      }
    } finally {
      await removeScratchDirectory(directory);
    }
  });
  await listen(owner, endpoint);
  await fs.chmod(endpoint, 0o000);
  const before = await fs.lstat(endpoint);
  await assert.rejects(async () => {
    unexpected = await createWorkspaceIpcServer({ registry: new FakeRegistry(), endpoint });
  }, (error) => ['EACCES', 'EPERM'].includes(error.code));
  const after = await fs.lstat(endpoint);
  assert.equal(after.isSocket(), true);
  assert.equal(after.ino, before.ino);
  assert.equal(after.dev, before.dev);
  assert.equal(owner.listening, true);
});
