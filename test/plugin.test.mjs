import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { apply, inject } from '../index.js';
import {
  FakeRegistry, JsonPeer, TEST_TIMEOUT, assertResult, deadline, fixture,
  isolatedEndpoint, removeScratchDirectory, scratchDirectory,
} from './support/fixtures.mjs';

const options = { timeout: TEST_TIMEOUT };
const ping = {
  service: 'dsh-workspace', protocolVersion: 1, profile: process.env.DSH_PROFILE || null,
};

async function contextFixture(t, { registry = new FakeRegistry(), logger } = {}) {
  const directory = await scratchDirectory();
  const endpoint = isolatedEndpoint(directory);
  const effects = [];
  const cleanups = [];
  const peers = [];
  const logs = [];
  const ctx = {
    workspaceRegistry: registry,
    logger: logger ?? { info: (message) => logs.push(message), error: (error) => logs.push(error) },
    async effect(start, label) {
      effects.push({ start, label });
      const cleanup = await start();
      cleanups.push(cleanup);
      return cleanup;
    },
  };
  t.after(async () => {
    try {
      await Promise.all(peers.map((peer) => peer.dispose()));
      for (const cleanup of cleanups) await deadline(cleanup(), 'dispose plugin-owned effect');
    } finally {
      await removeScratchDirectory(directory);
    }
  });
  return {
    ctx, directory, endpoint, registry, effects, cleanups, logs,
    async connect() {
      const peer = await JsonPeer.connect(endpoint);
      peers.push(peer);
      return peer;
    },
  };
}

test('The Host plugin declares workspaceRegistry as its sole hard injection', () => {
  assert.deepEqual(inject, ['workspaceRegistry']);
  assert.equal(typeof apply, 'function');
});

test('apply awaits startup, uses the injected registry and registers its listener cleanup with ctx.effect', options, async (t) => {
  const fx = await contextFixture(t);
  await apply(fx.ctx, { endpoint: fx.endpoint, dshHome: fx.directory });
  assert.equal(fx.effects.length, 1);
  assert.equal(typeof fx.effects[0].start, 'function');
  assert.equal(fx.cleanups.length, 1);
  assert.equal(typeof fx.cleanups[0], 'function');
  const peer = await fx.connect();
  assertResult(await peer.call('workspace.ping', {}, 'plugin-ping'), 'plugin-ping', ping);
  const rawPath = path.join(fx.directory, 'registered-project');
  const response = await peer.call('workspace.add', { path: rawPath, title: 'Via plugin' }, 'plugin-add');
  assertResult(response, 'plugin-add', { id: response.result.id, path: rawPath, title: 'Via plugin' });
  assert.deepEqual(fx.registry.callsFor('create').map((call) => call.args), [[rawPath, 'Via plugin']]);
  assert.equal(fx.logs.some((line) => typeof line === 'string' && line.includes(fx.endpoint)), true);
  await fx.cleanups[0]();
  await fx.cleanups[0]();
  await peer.closed();
  await assert.rejects(JsonPeer.connect(fx.endpoint));
});

test('An informational logger failure does not lose the registered listener disposer', options, async (t) => {
  const fx = await contextFixture(t, { logger: {
    info() { throw new Error('Diagnostic sink unavailable'); },
    error() { throw new Error('Diagnostic sink unavailable'); },
  } });
  await apply(fx.ctx, { endpoint: fx.endpoint });
  assert.equal(fx.cleanups.length, 1);
  const peer = await fx.connect();
  assertResult(await peer.call('workspace.ping', {}, 'logger-failure'), 'logger-failure', ping);
  await fx.cleanups[0]();
  await peer.closed();
  await assert.rejects(JsonPeer.connect(fx.endpoint));
});

test('Missing injection rejects plugin startup without publishing an endpoint', options, async (t) => {
  const fx = await contextFixture(t);
  delete fx.ctx.workspaceRegistry;
  await assert.rejects(apply(fx.ctx, { endpoint: fx.endpoint }), TypeError);
  assert.equal(fx.cleanups.length, 0);
  await assert.rejects(JsonPeer.connect(fx.endpoint));
});

test('Plugin startup collision propagates failure without replacing the existing listener', options, async (t) => {
  const original = await fixture(t, { profile: null });
  const attempted = await contextFixture(t);
  await assert.rejects(apply(attempted.ctx, { endpoint: original.endpoint }), { code: 'EADDRINUSE' });
  assert.equal(attempted.cleanups.length, 0);
  assert.equal(attempted.registry.calls.length, 0);
  assertResult(await (await original.connect()).call('workspace.ping', {}, 'still-original'), 'still-original', {
    ...ping, profile: null,
  });
});
