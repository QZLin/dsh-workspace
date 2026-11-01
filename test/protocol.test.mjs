import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import {
  FakeRegistry, TEST_ROOT, TEST_TIMEOUT, assertError, assertResult, basic,
  deferred, fixture, request,
} from './support/fixtures.mjs';

const options = { timeout: TEST_TIMEOUT };
const ping = (profile = null) => ({ service: 'dsh-workspace', protocolVersion: 1, profile });

test('All workspace methods use the injected registry and expose only public projections', options, async (t) => {
  const canonical = path.join(TEST_ROOT, 'canonical-project');
  const alias = path.join(TEST_ROOT, 'alias-project');
  const registry = new FakeRegistry({ aliases: { [alias]: canonical } });
  const fx = await fixture(t, { registry, profile: 'isolated-test-profile' });
  const peer = await fx.connect();

  assertResult(await peer.call('workspace.ping', {}, 'ping'), 'ping', ping('isolated-test-profile'));
  assertResult(await peer.call('workspace.list', {}, 'empty'), 'empty', []);

  const added = await peer.call('workspace.add', { path: alias, title: 'First title' }, 'add');
  const first = registry.records.get(added.result.id);
  assertResult(added, 'add', basic(first));
  assert.equal(first.path, canonical);
  assert.deepEqual(registry.callsFor('create')[0].args, [alias, 'First title']);

  assertResult(await peer.call('workspace.add', { path: canonical, title: 'Do not retitle' }, 'again'), 'again', basic(first));
  assert.equal(first.title, 'First title');
  assert.equal(registry.records.size, 1);
  assert.equal(registry.callsFor('setTitle').length, 0);

  assertResult(await peer.call('workspace.get', { id: first.id }, 'get'), 'get', {
    ...basic(first), createdAt: first.createdAt, updatedAt: first.updatedAt,
    sessionIds: [...first.sessionIds],
  });
  assertResult(await peer.call('workspace.list', {}, 'list'), 'list', [basic(first)]);
  assertResult(await peer.call('workspace.resolve', { path: alias }, 'resolve'), 'resolve', basic(first));
  assertResult(await peer.call('workspace.resolve', { path: path.join(TEST_ROOT, 'unowned') }, 'unowned'), 'unowned', null);
  assertResult(await peer.call('workspace.status', { id: first.id }, 'status'), 'status', { id: first.id, status: 'ok' });

  assertResult(await peer.call('workspace.rename', { id: first.id, title: 'First title' }, 'same-title'), 'same-title', basic(first));
  assert.equal(registry.callsFor('setTitle').length, 0, 'identical rename must not write');
  assertResult(await peer.call('workspace.rename', { id: first.id, title: 'Renamed 😀' }, 'rename'), 'rename', basic(first));
  assert.equal(first.title, 'Renamed 😀');
  assert.deepEqual(registry.callsFor('setTitle').map((call) => call.args), [[first.id, 'Renamed 😀']]);

  const secondResponse = await peer.call('workspace.add', { path: path.join(TEST_ROOT, 'second') }, 'second');
  const second = registry.records.get(secondResponse.result.id);
  assertResult(secondResponse, 'second', basic(second));
  assert.deepEqual(registry.callsFor('create').at(-1).args, [second.path, undefined]);
  assertResult(await peer.call('workspace.move', { id: first.id, beforeId: second.id }, 'move'), 'move', {
    order: [first.id, second.id],
  });
  assertResult(await peer.call('workspace.move', { id: first.id, beforeId: first.id }, 'self'), 'self', {
    order: [first.id, second.id],
  });
  assertResult(await peer.call('workspace.move', { id: first.id }, 'append'), 'append', {
    order: [second.id, first.id],
  });

  assertResult(await peer.call('workspace.remove', { id: first.id }, 'remove'), 'remove', { id: first.id, deleted: true });
  assertResult(await peer.call('workspace.remove', { id: first.id }, 'remove-again'), 'remove-again', { id: first.id, deleted: false });
  assertResult(await peer.call('workspace.list', {}, 'remaining'), 'remaining', [basic(second)]);
  assertResult(await peer.call('workspace.remove', { id: 'never-registered' }, 'unknown-remove'), 'unknown-remove', {
    id: 'never-registered', deleted: false,
  });
});

test('Workspace status reflects missing-dir without fabricated successful data', options, async (t) => {
  const registry = new FakeRegistry({ workspaces: [{ id: 'missing', status: 'missing-dir' }] });
  const peer = await (await fixture(t, { registry })).connect();
  assertResult(await peer.call('workspace.status', { id: 'missing' }, 0), 0, { id: 'missing', status: 'missing-dir' });
});

test('Business path strings, including relative, tilde and NUL, reach the registry untouched', options, async (t) => {
  const registry = new FakeRegistry({ hooks: {
    create() { throw new Error('Absolute existing directory required'); },
    resolveByPath() { throw new Error('Absolute existing directory required'); },
  } });
  const peer = await (await fixture(t, { registry })).connect();
  for (const rawPath of ['./relative', '../parent', '~/project', '~\\project', '  spaced 雪😀  ', '/nul\0business', '']) {
    assertError(await peer.call('workspace.add', { path: rawPath, title: '  Raw title  ' }, `add:${rawPath}`), -32001, `add:${rawPath}`);
    assert.deepEqual(registry.callsFor('create').at(-1).args, [rawPath, '  Raw title  ']);
    assertError(await peer.call('workspace.resolve', { path: rawPath }, `resolve:${rawPath}`), -32001, `resolve:${rawPath}`);
    assert.deepEqual(registry.callsFor('resolveByPath').at(-1).args, [rawPath]);
  }
});

test('String, finite numeric, fractional and null response IDs preserve exact values', options, async (t) => {
  const peer = await (await fixture(t, { profile: null })).connect();
  for (const id of [0, -7, 1.25, null, '', 'unicode-雪😀', 'constructor']) {
    assertResult(await peer.call('workspace.ping', {}, id), id, ping());
  }
});

test('Fragmented UTF-8 requests, CRLF, and multiple frames work on an actual local transport', options, async (t) => {
  const fx = await fixture(t, { profile: null });
  const peer = await fx.connect();
  const rawPath = path.join(TEST_ROOT, '雪😀project');
  const title = 'café 中文 🌟 title';
  const frame = Buffer.from(JSON.stringify(request('workspace.add', { path: rawPath, title }, 'fragmented')));
  const emojiOffset = frame.indexOf(Buffer.from('😀'));
  assert.notEqual(emojiOffset, -1);
  const split = emojiOffset + 1;

  // A completed preceding ping acknowledges the write containing the partial UTF-8 frame.
  await peer.write(Buffer.concat([
    Buffer.from(JSON.stringify(request('workspace.ping', {}, 'before')) + '\r\n'),
    frame.subarray(0, split),
  ]));
  assertResult(await peer.next(), 'before', ping());
  await peer.write(frame.subarray(split, split + 1));
  await peer.write(frame.subarray(split + 1, split + 2));
  await peer.write(Buffer.concat([
    frame.subarray(split + 2), Buffer.from('\r\n'),
    Buffer.from(JSON.stringify(request('workspace.list', {}, 'after')) + '\n'),
    Buffer.from(JSON.stringify(request('workspace.ping', {}, 'last')) + '\r\n'),
  ]));
  const added = await peer.next();
  const workspace = registryWorkspace(fx.registry, rawPath);
  assertResult(added, 'fragmented', { id: workspace.id, path: rawPath, title });
  assertResult(await peer.next(), 'after', [basic(workspace)]);
  assertResult(await peer.next(), 'last', ping());
  assert.deepEqual(fx.registry.callsFor('create')[0].args, [rawPath, title]);
});

function registryWorkspace(registry, rawPath) {
  const workspace = [...registry.records.values()].find((entry) => entry.path === rawPath);
  assert.ok(workspace, 'registry received the add operation');
  return workspace;
}

test('Malformed JSON, invalid UTF-8, nonobjects and batches return errors without poisoning the peer', options, async (t) => {
  const fx = await fixture(t, { profile: null });
  const peer = await fx.connect();
  for (const line of ['{', '{"jsonrpc":', '', '   ', '{"trailing":true,}']) {
    await peer.write(Buffer.from(line + '\n'));
    assertError(await peer.next(), -32700, null);
  }
  await peer.write(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]));
  assertError(await peer.next(), -32700, null);
  for (const value of [null, false, 42, 'not an object', [], [request('workspace.ping', {}, 'batch')]]) {
    await peer.send(value);
    assertError(await peer.next(), -32600, null);
  }
  assert.equal(fx.registry.calls.length, 0, 'invalid input must not reach the registry');
  assertResult(await peer.call('workspace.ping', {}, 'recovered'), 'recovered', ping());
});

test('Invalid JSON-RPC envelope and ID types are rejected with a detectable valid ID or null', options, async (t) => {
  const fx = await fixture(t, { profile: null });
  const peer = await fx.connect();
  const invalidEnvelopes = [
    { id: 'missing-version', method: 'workspace.ping', params: {} },
    { jsonrpc: '1.0', id: 'old-version', method: 'workspace.ping', params: {} },
    { jsonrpc: 2, id: 'numeric-version', method: 'workspace.ping', params: {} },
    { jsonrpc: '2.0', id: 'missing-method', params: {} },
    { jsonrpc: '2.0', id: 'numeric-method', method: 1, params: {} },
    { jsonrpc: '2.0', id: 'null-method', method: null, params: {} },
  ];
  for (const value of invalidEnvelopes) {
    await peer.send(value);
    assertError(await peer.next(), -32600, value.id);
  }
  for (const id of [true, false, {}, [], ['id']]) {
    await peer.send(request('workspace.ping', {}, id));
    assertError(await peer.next(), -32600, null);
  }
  await peer.write(Buffer.from('{"jsonrpc":"2.0","id":1e999,"method":"workspace.ping","params":{}}\n'));
  assertError(await peer.next(), -32600, null);
  await peer.send({ jsonrpc: '2.0', params: {} });
  assertError(await peer.next(), -32600, null);
  assert.equal(fx.registry.calls.length, 0);
});

test('Unknown and prototype-like method names produce method-not-found without service access', options, async (t) => {
  const fx = await fixture(t);
  const peer = await fx.connect();
  for (const method of ['workspace.unknown', 'workspace.archiveSession', 'list', '__proto__', 'constructor', 'toString']) {
    assertError(await peer.call(method, {}, `unknown:${method}`), -32601, `unknown:${method}`);
  }
  assert.equal(fx.registry.calls.length, 0);
});

test('Every workspace method rejects missing, extra and incorrectly typed params before business calls', options, async (t) => {
  const fx = await fixture(t);
  const peer = await fx.connect();
  const cases = [
    ['workspace.add', {}], ['workspace.add', { path: 1 }],
    ['workspace.add', { path: '/p', title: null }], ['workspace.add', { path: '/p', extra: true }],
    ['workspace.list', { extra: true }],
    ['workspace.get', {}], ['workspace.get', { id: 1 }], ['workspace.get', { id: 'w', extra: true }],
    ['workspace.rename', { id: 'w' }], ['workspace.rename', { title: 't' }],
    ['workspace.rename', { id: 'w', title: false }], ['workspace.rename', { id: 'w', title: 't', extra: true }],
    ['workspace.remove', {}], ['workspace.remove', { id: [] }], ['workspace.remove', { id: 'w', path: '/p' }],
    ['workspace.move', {}], ['workspace.move', { id: 'w', beforeId: null }],
    ['workspace.move', { id: 'w', beforeId: 1 }], ['workspace.move', { id: 'w', extra: true }],
    ['workspace.resolve', {}], ['workspace.resolve', { path: {} }], ['workspace.resolve', { path: '/p', id: 'w' }],
    ['workspace.status', {}], ['workspace.status', { id: null }], ['workspace.status', { id: 'w', extra: true }],
    ['workspace.ping', { extra: true }],
  ];
  for (const [index, [method, params]] of cases.entries()) {
    assertError(await peer.call(method, params, `params-${index}`), -32602, `params-${index}`);
  }
  for (const params of [null, [], 'params', false, 0]) {
    assertError(await peer.call('workspace.ping', params, `type-${JSON.stringify(params)}`), -32602, `type-${JSON.stringify(params)}`);
  }
  assert.equal(fx.registry.calls.length, 0);
});

test('Absent params mean an empty object, not absent required workspace fields', options, async (t) => {
  const fx = await fixture(t, { profile: null });
  const peer = await fx.connect();
  await peer.send({ jsonrpc: '2.0', id: 'ping', method: 'workspace.ping' });
  assertResult(await peer.next(), 'ping', ping());
  await peer.send({ jsonrpc: '2.0', id: 'list', method: 'workspace.list' });
  assertResult(await peer.next(), 'list', []);
  await peer.send({ jsonrpc: '2.0', id: 'add', method: 'workspace.add' });
  assertError(await peer.next(), -32602, 'add');
});

test('Unknown workspace lookups and move anchors return -32004', options, async (t) => {
  const registry = new FakeRegistry({ workspaces: [{ id: 'known' }] });
  const peer = await (await fixture(t, { registry })).connect();
  for (const [method, params] of [
    ['workspace.get', { id: 'unknown' }],
    ['workspace.rename', { id: 'unknown', title: 'New' }],
    ['workspace.status', { id: 'unknown' }],
    ['workspace.move', { id: 'unknown' }],
    ['workspace.move', { id: 'known', beforeId: 'unknown' }],
  ]) assertError(await peer.call(method, params, method), -32004, method);
  assert.equal(registry.callsFor('setTitle').length, 0);
  assert.equal(registry.callsFor('status').length, 0);
});

test('All registry domain failures map to -32001 without exposing internal state or stacks', options, async (t) => {
  const registry = new FakeRegistry({ workspaces: [{ id: 'known' }] });
  const fx = await fixture(t, { registry, profile: null });
  const peer = await fx.connect();
  const failure = Object.assign(new Error('Deliberate domain failure'), { code: 'EACCES', privateSecret: 'hidden' });
  const cases = [
    ['create', 'workspace.add', { path: '/project' }],
    ['list', 'workspace.list', {}],
    ['get', 'workspace.get', { id: 'known' }],
    ['setTitle', 'workspace.rename', { id: 'known', title: 'Changed' }],
    ['delete', 'workspace.remove', { id: 'known' }],
    ['insertBefore', 'workspace.move', { id: 'known' }],
    ['resolveByPath', 'workspace.resolve', { path: '/project' }],
    ['status', 'workspace.status', { id: 'known' }],
  ];
  for (const [hook, method, params] of cases) {
    registry.hooks[hook] = () => { throw failure; };
    const response = await peer.call(method, params, `failure:${hook}`);
    assertError(response, -32001, `failure:${hook}`);
    const encoded = JSON.stringify(response);
    assert.equal(encoded.includes('privateSecret'), false);
    assert.equal(encoded.includes('internalSecret'), false);
    assert.equal(encoded.includes('hidden'), false);
    assert.equal(encoded.includes('at TestContext'), false);
    delete registry.hooks[hook];
  }
  assertResult(await peer.call('workspace.ping', {}, 'alive'), 'alive', ping());
});

test('Valid notifications execute once and never produce success, method, params or domain error responses', options, async (t) => {
  const registry = new FakeRegistry();
  const fx = await fixture(t, { registry, profile: null });
  const peer = await fx.connect();
  const rawPath = path.join(TEST_ROOT, 'notification-project');
  await peer.send({ jsonrpc: '2.0', method: 'workspace.add', params: { path: rawPath, title: 'Notified' } });
  await peer.send({ jsonrpc: '2.0', method: 'workspace.unknown', params: {} });
  await peer.send({ jsonrpc: '2.0', method: 'workspace.add', params: {} });
  await peer.send({ jsonrpc: '2.0', method: 'workspace.get', params: { id: 'unknown' } });
  registry.hooks.delete = () => { throw new Error('Notification domain failure'); };
  await peer.send({ jsonrpc: '2.0', method: 'workspace.remove', params: { id: 'unknown' } });
  assertResult(await peer.call('workspace.ping', {}, 'notification-barrier'), 'notification-barrier', ping());
  assert.equal(registry.callsFor('delete').length, 1);
  assert.equal(registry.callsFor('create').length, 1);
  assert.equal(registry.records.size, 1);
  assert.equal(peer.frames.length, 0);
  assertResult(await peer.call('workspace.list', {}, 'second-barrier'), 'second-barrier', [basic(registryWorkspace(registry, rawPath))]);
});

test('Accepted mutations are not replayed when their peer disconnects before completion', options, async (t) => {
  const entered = deferred();
  const complete = deferred();
  t.after(() => complete.resolve());
  const registry = new FakeRegistry({ hooks: {
    async create(rawPath, title, self) {
      entered.resolve();
      await complete.promise;
      return self.seed({ id: 'committed-once', path: rawPath, title });
    },
  } });
  const fx = await fixture(t, { registry, profile: null });
  const peer = await fx.connect();
  const rawPath = path.join(TEST_ROOT, 'disconnect-project');
  await peer.send(request('workspace.add', { path: rawPath, title: 'Committed' }, 'lost-response'));
  await entered.promise;
  await peer.dispose();
  complete.resolve();
  const fresh = await fx.connect();
  assertResult(await fresh.call('workspace.list', {}, 'fresh-read'), 'fresh-read', [
    { id: 'committed-once', path: rawPath, title: 'Committed' },
  ]);
  assert.equal(registry.callsFor('create').length, 1);
  assertResult(await fresh.call('workspace.ping', {}, 'no-replay'), 'no-replay', ping());
  assert.equal(registry.callsFor('create').length, 1);
});
