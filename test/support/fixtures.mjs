import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveEndpoint } from '../../src/endpoint.js';
import { createWorkspaceIpcServer } from '../../src/server.js';

export const TEST_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const TEST_TIMEOUT = 15_000;
export const REQUEST_LIMIT = 64 * 1024;
export const RESPONSE_LIMIT = 8 * 1024 * 1024;

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// Timers are failure deadlines, never a readiness probe or a test synchronization sleep.
export async function deadline(promise, description, milliseconds = 5_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function basic(workspace) {
  return { id: workspace.id, path: workspace.path, title: workspace.title };
}

/** An isolated structural double of the inspected public workspaceRegistry contract. */
export class FakeRegistry {
  constructor({ workspaces = [], aliases = {}, hooks = {} } = {}) {
    this.records = new Map();
    this.order = [];
    this.calls = [];
    this.aliases = new Map(Object.entries(aliases));
    this.hooks = { ...hooks };
    this.sequence = 0;
    for (const workspace of workspaces) this.seed(workspace);
  }

  seed(input = {}) {
    const registry = this;
    let id = input.id;
    if (id === undefined) {
      do { id = `workspace-${++this.sequence}`; } while (this.records.has(id));
    }
    const workspace = {
      id,
      path: input.path ?? path.join(TEST_ROOT, id),
      title: input.title ?? id,
      createdAt: input.createdAt ?? '2026-01-02T03:04:05.000Z',
      updatedAt: input.updatedAt ?? '2026-02-03T04:05:06.000Z',
      sessionIds: [...(input.sessionIds ?? ['session-a', 'session-b'])],
      internalSecret: 'must-not-be-exposed',
      async setTitle(title) {
        registry.record('setTitle', [id, title]);
        if (Object.hasOwn(registry.hooks, 'setTitle')) {
          await registry.hooks.setTitle(id, title, workspace);
        }
        workspace.title = title;
        workspace.updatedAt = '2026-03-04T05:06:07.000Z';
      },
      async status() {
        registry.record('status', [id]);
        if (Object.hasOwn(registry.hooks, 'status')) {
          return registry.hooks.status(id, workspace);
        }
        return input.status ?? 'ok';
      },
    };
    this.records.set(id, workspace);
    if (!this.order.includes(id)) this.order.push(id);
    return workspace;
  }

  record(method, args) {
    this.calls.push({ method, args });
  }

  callsFor(method) {
    return this.calls.filter((call) => call.method === method);
  }

  async create(rawPath, title) {
    this.record('create', [rawPath, title]);
    if (Object.hasOwn(this.hooks, 'create')) return this.hooks.create(rawPath, title, this);
    const canonicalPath = this.aliases.get(rawPath) ?? rawPath;
    const existing = [...this.records.values()].find((entry) => entry.path === canonicalPath);
    if (existing) return existing;
    const workspace = this.seed({ path: canonicalPath, title: title ?? path.basename(rawPath) });
    this.order = [workspace.id, ...this.order.filter((id) => id !== workspace.id)];
    return workspace;
  }

  get(id) {
    this.record('get', [id]);
    if (Object.hasOwn(this.hooks, 'get')) return this.hooks.get(id, this);
    return this.records.get(id);
  }

  list() {
    this.record('list', []);
    if (Object.hasOwn(this.hooks, 'list')) return this.hooks.list(this);
    return this.order.map((id) => this.records.get(id));
  }

  async delete(id) {
    this.record('delete', [id]);
    if (Object.hasOwn(this.hooks, 'delete')) return this.hooks.delete(id, this);
    const deleted = this.records.delete(id);
    this.order = this.order.filter((entry) => entry !== id);
    return deleted;
  }

  async insertBefore(id, beforeId) {
    this.record('insertBefore', [id, beforeId]);
    if (Object.hasOwn(this.hooks, 'insertBefore')) return this.hooks.insertBefore(id, beforeId, this);
    if (!this.records.has(id) || (beforeId !== undefined && !this.records.has(beforeId))) {
      const error = new Error('Unknown workspace');
      error.name = 'WorkspaceOrderInvalidError';
      throw error;
    }
    if (id === beforeId) return [...this.order];
    this.order = this.order.filter((entry) => entry !== id);
    const index = beforeId === undefined ? this.order.length : this.order.indexOf(beforeId);
    this.order.splice(index, 0, id);
    return [...this.order];
  }

  async resolveByPath(rawPath) {
    this.record('resolveByPath', [rawPath]);
    if (Object.hasOwn(this.hooks, 'resolveByPath')) return this.hooks.resolveByPath(rawPath, this);
    const canonicalPath = this.aliases.get(rawPath) ?? rawPath;
    return [...this.records.values()].find((entry) => entry.path === canonicalPath);
  }
}

export function request(method, params = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

export function assertResult(response, id, result) {
  assert.deepEqual(response, { jsonrpc: '2.0', id, result });
}

export function assertError(response, code, id) {
  assert.equal(response?.jsonrpc, '2.0');
  assert.equal(response?.error?.code, code);
  assert.equal(typeof response.error.message, 'string');
  assert.notEqual(response.error.message.length, 0);
  assert.equal(Object.hasOwn(response, 'result'), false);
  if (arguments.length >= 3) assert.deepEqual(response.id, id);
  assert.equal(Object.hasOwn(response, 'id'), true);
}

export class JsonPeer {
  constructor(socket) {
    this.socket = socket;
    this.frames = [];
    this.waiters = [];
    this.buffer = Buffer.alloc(0);
    this.receivedBytes = 0;
    this.error = undefined;
    this.isClosed = false;
    this.closeSignal = deferred();
    socket.on('error', (error) => { this.error = error; });
    socket.on('data', (chunk) => {
      this.receivedBytes += chunk.length;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const newline = this.buffer.indexOf(0x0a);
        if (newline === -1) break;
        const bytes = this.buffer.subarray(0, newline);
        this.buffer = this.buffer.subarray(newline + 1);
        try {
          const text = bytes.toString('utf8').replace(/\r$/, '');
          const frame = { kind: 'frame', value: JSON.parse(text), bytes: bytes.length };
          const waiter = this.waiters.shift();
          if (waiter) waiter.resolve(frame);
          else this.frames.push(frame);
        } catch (error) {
          this.error = new Error('Server emitted a non-JSON NDJSON frame', { cause: error });
          for (const waiter of this.waiters.splice(0)) waiter.reject(this.error);
          socket.destroy();
          return;
        }
      }
    });
    socket.on('close', () => {
      this.isClosed = true;
      const closed = { kind: 'closed', error: this.error };
      this.closeSignal.resolve(closed);
      for (const waiter of this.waiters.splice(0)) waiter.resolve(closed);
    });
  }

  static async connect(endpoint) {
    const socket = net.createConnection(endpoint);
    const peer = new JsonPeer(socket);
    try {
      await deadline(once(socket, 'connect'), 'connect to test IPC endpoint');
      return peer;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  async write(bytes) {
    await deadline(new Promise((resolve, reject) => {
      this.socket.write(bytes, (error) => error ? reject(error) : resolve());
    }), 'write IPC request');
  }

  async send(value, delimiter = '\n') {
    await this.write(Buffer.from(JSON.stringify(value) + delimiter));
  }

  async nextOutcome() {
    if (this.frames.length) return this.frames.shift();
    if (this.isClosed) return { kind: 'closed', error: this.error };
    const waiter = deferred();
    this.waiters.push(waiter);
    try {
      return await deadline(waiter.promise, 'receive IPC response or connection close');
    } finally {
      const index = this.waiters.indexOf(waiter);
      if (index !== -1) this.waiters.splice(index, 1);
    }
  }

  async next() {
    const outcome = await this.nextOutcome();
    assert.equal(outcome.kind, 'frame', `Connection closed before response: ${outcome.error?.message ?? ''}`);
    return outcome.value;
  }

  async call(method, params = {}, id = 1) {
    await this.send(request(method, params, id));
    return this.next();
  }

  async closed() {
    return deadline(this.closeSignal.promise, 'IPC peer close');
  }

  async dispose() {
    this.socket.destroy();
    await this.closed();
  }
}

export async function scratchDirectory() {
  const directory = await fs.mkdtemp(path.join(TEST_ROOT, '.ipc-test-'));
  // Every fixture creates and removes files strictly beneath the delegated test/** scope.
  assert.equal(path.dirname(path.resolve(directory)), TEST_ROOT);
  assert.match(path.basename(directory), /^\.ipc-test-/);
  return directory;
}

export async function removeScratchDirectory(directory) {
  // Verify the exact absolute target before recursive removal, including on failed tests.
  assert.equal(path.dirname(path.resolve(directory)), TEST_ROOT);
  assert.match(path.basename(directory), /^\.ipc-test-/);
  await fs.rm(directory, { recursive: true, force: true });
}

export function isolatedEndpoint(directory) {
  return resolveEndpoint({
    platform: process.platform,
    env: {},
    dshHome: directory,
    endpoint: process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-workspace-test-${randomUUID()}`
      : path.join(directory, 'workspace.sock'),
  });
}

export async function fixture(t, options = {}) {
  const directory = await scratchDirectory();
  const endpoint = isolatedEndpoint(directory);
  const registry = options.registry ?? new FakeRegistry();
  const peers = new Set();
  let handle;
  t.after(async () => {
    try {
      await Promise.all([...peers].map((peer) => peer.dispose()));
      if (handle) await deadline(handle.dispose(), 'dispose IPC server');
    } finally {
      await removeScratchDirectory(directory);
    }
  });
  handle = await createWorkspaceIpcServer({ ...options, registry, endpoint });
  assert.equal(handle.endpoint, endpoint);
  assert.equal(typeof handle.dispose, 'function');
  assert.equal(handle.server.listening, true);
  return {
    directory,
    endpoint,
    registry,
    handle,
    async connect() {
      const peer = await JsonPeer.connect(endpoint);
      peers.add(peer);
      return peer;
    },
  };
}

export async function listen(server, endpoint) {
  await deadline(new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve();
    });
  }), 'bind raw local test server');
}

export async function closeServer(server) {
  if (!server.listening) return;
  await deadline(new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }), 'close raw test server');
}
