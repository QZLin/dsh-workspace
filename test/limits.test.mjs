import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { createWorkspaceIpcServer } from '../src/server.js';
import {
  FakeRegistry, REQUEST_LIMIT, RESPONSE_LIMIT, TEST_ROOT, TEST_TIMEOUT,
  assertError, assertResult, basic, deadline, deferred, fixture,
  isolatedEndpoint, removeScratchDirectory, request, scratchDirectory,
} from './support/fixtures.mjs';

const options = { timeout: TEST_TIMEOUT };
const ping = { service: 'dsh-workspace', protocolVersion: 1, profile: null };

function sizedAdd(size, id, suffix = id) {
  const value = request('workspace.add', { path: path.join(TEST_ROOT, suffix), title: '' }, id);
  const overhead = Buffer.byteLength(JSON.stringify(value));
  assert.ok(size >= overhead);
  value.params.title = 'x'.repeat(size - overhead);
  const bytes = Buffer.from(JSON.stringify(value));
  assert.equal(bytes.length, size);
  return { value, bytes };
}

async function overflowFrame(peer, bytes) {
  try {
    await peer.write(bytes);
  } catch (error) {
    // A peer may learn about the deliberate close before its write callback completes.
    assert.ok(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(error.code), error.message);
  }
  const outcome = await peer.nextOutcome();
  assert.equal(outcome.kind, 'frame');
  assertError(outcome.value, -32005, null);
  await peer.closed();
}

test('The default 64-KiB request limit excludes LF and terminal CR, even with fragmented CRLF', options, async (t) => {
  const fx = await fixture(t, { profile: null });
  const peer = await fx.connect();
  const frames = [
    { ...sizedAdd(REQUEST_LIMIT - 1, 'below'), delimiter: '\n' },
    { ...sizedAdd(REQUEST_LIMIT, 'exact-lf'), delimiter: '\n' },
    { ...sizedAdd(REQUEST_LIMIT, 'exact-crlf'), delimiter: '\r\n' },
  ];
  for (const frame of frames) {
    await peer.write(Buffer.concat([frame.bytes, Buffer.from(frame.delimiter)]));
    const response = await peer.next();
    assert.equal(response.id, frame.value.id);
    assertResult(response, frame.value.id, {
      id: response.result.id, path: frame.value.params.path, title: frame.value.params.title,
    });
  }

  const fragmented = sizedAdd(REQUEST_LIMIT, 'fragmented-crlf');
  await peer.write(Buffer.concat([
    Buffer.from(JSON.stringify(request('workspace.ping', {}, 'cr-barrier')) + '\n'),
    fragmented.bytes,
  ]));
  assertResult(await peer.next(), 'cr-barrier', ping);
  await peer.write(Buffer.from('\r'));
  await peer.write(Buffer.from('\n'));
  const response = await peer.next();
  assertResult(response, 'fragmented-crlf', {
    id: response.result.id, path: fragmented.value.params.path, title: fragmented.value.params.title,
  });
  assert.equal(fx.registry.callsFor('create').length, 4);
});

test('Only one optional terminal CR is excluded from a bounded request frame', options, async (t) => {
  const fx = await fixture(t, { maxRequestBytes: 512, profile: null });
  const peer = await fx.connect();
  const frame = sizedAdd(512, 'extra-cr');
  await overflowFrame(peer, Buffer.concat([frame.bytes, Buffer.from('\r\r\n')]));
  assert.equal(fx.registry.calls.length, 0);
});

test('Oversized default request frames are rejected once, close the peer, and never execute', options, async (t) => {
  const fx = await fixture(t, { profile: null });
  const peer = await fx.connect();
  const frame = sizedAdd(REQUEST_LIMIT + 1, 'over-limit');
  await overflowFrame(peer, Buffer.concat([frame.bytes, Buffer.from('\n')]));
  assert.equal(fx.registry.calls.length, 0);
  const fresh = await fx.connect();
  assertResult(await fresh.call('workspace.ping', {}, 'fresh'), 'fresh', ping);
  assert.equal(fx.registry.calls.length, 0, 'reconnecting never replays an oversized frame');
});

test('Request bounds count UTF-8 bytes rather than UTF-16 characters', options, async (t) => {
  const fx = await fixture(t, { profile: null });
  const peer = await fx.connect();
  const line = JSON.stringify(request('workspace.add', {
    path: path.join(TEST_ROOT, 'unicode-byte-limit'), title: '😀'.repeat(REQUEST_LIMIT / 4),
  }, 'unicode-over'));
  assert.ok(line.length < REQUEST_LIMIT);
  assert.ok(Buffer.byteLength(line) > REQUEST_LIMIT);
  await overflowFrame(peer, Buffer.from(line + '\n'));
  assert.equal(fx.registry.calls.length, 0);
});

test('Incremental unterminated input is bounded before a newline arrives', options, async (t) => {
  const fx = await fixture(t, { maxRequestBytes: 512, profile: null });
  const peer = await fx.connect();
  await peer.write(Buffer.from(JSON.stringify(request('workspace.ping', {}, 'prefix-barrier')) + '\n' + 'x'.repeat(500)));
  assertResult(await peer.next(), 'prefix-barrier', ping);
  await overflowFrame(peer, Buffer.from('x'.repeat(13)));
  assert.equal(fx.registry.calls.length, 0);
});

test('The default 8-MiB result limit emits a bounded -32005 response and keeps the peer reusable', options, async (t) => {
  const registry = new FakeRegistry({ workspaces: [{ id: 'huge', title: 'x'.repeat(RESPONSE_LIMIT) }] });
  const fx = await fixture(t, { registry, profile: null });
  const peer = await fx.connect();
  await peer.send(request('workspace.list', {}, 'too-large'));
  const outcome = await peer.nextOutcome();
  assert.equal(outcome.kind, 'frame');
  assertError(outcome.value, -32005, 'too-large');
  assert.ok(outcome.bytes <= RESPONSE_LIMIT);
  assert.ok(peer.receivedBytes < 1024, 'the oversized result is not partially transmitted');
  assertResult(await peer.call('workspace.ping', {}, 'reusable'), 'reusable', ping);
});

test('A configured response limit accepts exact byte boundaries and rejects UTF-8 overflow', options, async (t) => {
  const limit = 4096;
  const registry = new FakeRegistry({ workspaces: [{ id: 'boundary', title: '' }] });
  const workspace = registry.records.get('boundary');
  const expected = { jsonrpc: '2.0', id: 'boundary', result: basic(workspace) };
  const overhead = Buffer.byteLength(JSON.stringify(expected));
  workspace.title = 'x'.repeat(limit - overhead);
  const fx = await fixture(t, { registry, maxResponseBytes: limit, profile: null });
  const peer = await fx.connect();
  await peer.send(request('workspace.rename', { id: 'boundary', title: workspace.title }, 'boundary'));
  const exact = await peer.nextOutcome();
  assert.equal(exact.kind, 'frame');
  assert.equal(exact.bytes, limit);
  assertResult(exact.value, 'boundary', basic(workspace));
  assert.equal(registry.callsFor('setTitle').length, 0);

  workspace.title += '😀';
  const tooLarge = await peer.call('workspace.rename', { id: 'boundary', title: workspace.title }, 'boundary');
  assertError(tooLarge, -32005, 'boundary');
  assertResult(await peer.call('workspace.ping', {}, 'after-overflow'), 'after-overflow', ping);
});

test('The listener closes without output if even the error envelope cannot fit a tiny response limit', options, async (t) => {
  const fx = await fixture(t, { maxResponseBytes: 16, profile: null });
  const peer = await fx.connect();
  await peer.send(request('workspace.list', {}, 'tiny'));
  const outcome = await peer.nextOutcome();
  assert.equal(outcome.kind, 'closed');
  assert.equal(peer.receivedBytes, 0);
});

test('The outbound buffer bound closes a peer instead of writing an over-budget result', options, async (t) => {
  const registry = new FakeRegistry({ workspaces: [{ id: 'buffer-budget', title: 'x'.repeat(1000) }] });
  const fx = await fixture(t, { registry, maxResponseBytes: 4096, maxBufferedResponseBytes: 256, profile: null });
  const peer = await fx.connect();
  await peer.send(request('workspace.list', {}, 'buffer-over'));
  assert.equal((await peer.nextOutcome()).kind, 'closed');
  assert.equal(peer.receivedBytes, 0);
  const fresh = await fx.connect();
  assertResult(await fresh.call('workspace.ping', {}, 'still-serving'), 'still-serving', ping);
});

function blockedRegistry(entered, release) {
  let executions = 0;
  return new FakeRegistry({ hooks: {
    async create(rawPath, title, self) {
      executions += 1;
      if (executions === 1) {
        entered.resolve();
        await release.promise;
      }
      return self.seed({ path: rawPath, title });
    },
  } });
}

function assertNoOverflowMutation(registry, forbiddenPath, maximumCalls) {
  const calls = registry.callsFor('create');
  assert.ok(calls.length >= 1 && calls.length <= maximumCalls);
  assert.equal(calls.filter((call) => call.args[0] === forbiddenPath).length, 0);
  const paths = calls.map((call) => call.args[0]);
  assert.equal(new Set(paths).size, paths.length, 'accepted operations are never replayed');
}

test('A per-peer queue cap rejects the current request once and does not execute overflow frames', options, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const registry = blockedRegistry(entered, release);
  const fx = await fixture(t, { registry, maxPendingPerConnection: 2, maxPendingRequests: 8, profile: null });
  const peer = await fx.connect();
  const paths = ['accepted-first', 'accepted-second', 'forbidden-third'].map((name) => path.join(TEST_ROOT, name));
  const lines = paths.map((rawPath, index) => JSON.stringify(request('workspace.add', { path: rawPath }, index + 1)));
  await peer.write(Buffer.from(lines.join('\n') + '\n'));
  assertError(await peer.next(), -32005, 3);
  await deadline(entered.promise, 'first queued mutation begins');
  await peer.closed();
  release.resolve();
  const fresh = await fx.connect();
  assertResult(await fresh.call('workspace.ping', {}, 'drain-barrier'), 'drain-barrier', ping);
  assertNoOverflowMutation(registry, paths[2], 2);
});

test('The global queue cap applies across peers without closing an unaffected peer', options, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const registry = blockedRegistry(entered, release);
  const fx = await fixture(t, { registry, maxPendingRequests: 2, maxPendingPerConnection: 8, profile: null });
  const first = await fx.connect();
  const second = await fx.connect();
  const paths = ['global-first', 'global-second', 'global-forbidden'].map((name) => path.join(TEST_ROOT, name));
  await first.send(request('workspace.add', { path: paths[0] }, 'global-one'));
  await deadline(entered.promise, 'first global mutation begins');
  await second.write(Buffer.from([
    JSON.stringify(request('workspace.add', { path: paths[1] }, 'global-two')),
    JSON.stringify(request('workspace.add', { path: paths[2] }, 'global-three')),
    '',
  ].join('\n')));
  assertError(await second.next(), -32005, 'global-three');
  await second.closed();
  release.resolve();
  const firstResult = await first.next();
  assert.equal(firstResult.id, 'global-one');
  assert.equal(firstResult.result.path, paths[0]);
  assertResult(await first.call('workspace.ping', {}, 'global-barrier'), 'global-barrier', ping);
  assertNoOverflowMutation(registry, paths[2], 2);
});

test('Notification queue overflow closes silently and does not replay rejected mutations', options, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const registry = blockedRegistry(entered, release);
  const fx = await fixture(t, { registry, maxPendingPerConnection: 1, profile: null });
  const peer = await fx.connect();
  const firstPath = path.join(TEST_ROOT, 'notification-first');
  const forbiddenPath = path.join(TEST_ROOT, 'notification-forbidden');
  await peer.send({ jsonrpc: '2.0', method: 'workspace.add', params: { path: firstPath } });
  await deadline(entered.promise, 'notification mutation begins');
  await peer.send({ jsonrpc: '2.0', method: 'workspace.add', params: { path: forbiddenPath } });
  assert.equal((await peer.nextOutcome()).kind, 'closed');
  assert.equal(peer.receivedBytes, 0);
  release.resolve();
  const fresh = await fx.connect();
  assertResult(await fresh.call('workspace.ping', {}, 'notification-overflow-barrier'), 'notification-overflow-barrier', ping);
  assertNoOverflowMutation(registry, forbiddenPath, 1);
});

test('The connection cap rejects excess peers while the admitted peer stays usable', options, async (t) => {
  const fx = await fixture(t, { maxConnections: 1, profile: null });
  const admitted = await fx.connect();
  assertResult(await admitted.call('workspace.ping', {}, 'admitted'), 'admitted', ping);
  const excess = await fx.connect();
  assert.equal((await excess.nextOutcome()).kind, 'closed');
  assert.equal(excess.receivedBytes, 0);
  assertResult(await admitted.call('workspace.ping', {}, 'unaffected'), 'unaffected', ping);
});

test('Idle peers are closed by the configured timeout using an event-driven wait', options, async (t) => {
  const fx = await fixture(t, { idleTimeoutMs: 100, profile: null });
  const idle = await fx.connect();
  await idle.closed();
  assert.equal(idle.receivedBytes, 0);
  const fresh = await fx.connect();
  assertResult(await fresh.call('workspace.ping', {}, 'after-idle'), 'after-idle', ping);
});

test('Every transport limit rejects invalid values before attempting to bind', options, async (t) => {
  const directory = await scratchDirectory();
  t.after(() => removeScratchDirectory(directory));
  const endpoint = isolatedEndpoint(directory);
  for (const name of [
    'maxRequestBytes', 'maxResponseBytes', 'maxConnections', 'maxPendingRequests',
    'maxPendingPerConnection', 'maxBufferedResponseBytes', 'idleTimeoutMs', 'probeTimeoutMs',
  ]) {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
      await assert.rejects(createWorkspaceIpcServer({ registry: new FakeRegistry(), endpoint, [name]: value }), TypeError);
    }
  }
  await assert.rejects(createWorkspaceIpcServer({ endpoint }), TypeError);
  for (const endpointValue of [12345, { host: '127.0.0.1', port: 12345 }, null]) {
    await assert.rejects(createWorkspaceIpcServer({ registry: new FakeRegistry(), endpoint: endpointValue }), TypeError);
  }
});
