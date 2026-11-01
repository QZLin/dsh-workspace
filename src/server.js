import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, readdir, rmdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateEndpoint } from './endpoint.js';
import {
  DEFAULT_MAX_REQUEST_BYTES, DEFAULT_MAX_RESPONSE_BYTES, FrameTooLargeError,
  LineFramer, RpcError, encodeResponse, parseRequest, prepareOperation,
} from './rpc.js';

function endpointError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

async function statOrMissing(path) {
  try { return await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function sameIdentity(left, right) {
  return left && right && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}
function sameSocket(left, right) {
  return left?.isSocket() && right?.isSocket() && sameIdentity(left, right);
}
function sameDirectory(left, right) {
  return left?.isDirectory() && right?.isDirectory() && sameIdentity(left, right);
}

/** A liveness probe never writes a request or invokes a DSH operation. */
function probeEndpoint(endpoint, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: endpoint });
    let settled = false;
    const timer = setTimeout(() => finish(endpointError('ETIMEDOUT', 'IPC endpoint liveness probe timed out')), timeoutMs);
    timer.unref();
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    }
    socket.once('connect', () => finish());
    socket.once('error', finish);
    socket.once('close', () => {
      if (!settled) finish(endpointError('ECONNRESET', 'IPC endpoint closed during liveness probe'));
    });
  });
}

async function removeStaleAliases(endpoint, previous) {
  // Keep the stale public inode alive throughout enumeration. Otherwise a raw
  // socket's last unlink could let an unrelated new socket reuse its inode.
  for (const name of await readdir(dirname(endpoint))) {
    if (!/^\._dwi[0-9a-f]{12}$/.test(name)) continue;
    const alias = join(dirname(endpoint), name);
    if (alias === endpoint) continue; // The public link is the inode keeper.
    const entry = await statOrMissing(alias);
    if (sameSocket(previous, entry)) {
      await unlink(alias); // compatible with a legacy flat private alias
    } else if (entry?.isDirectory() && entry.uid === previous.uid) {
      const socketPath = join(alias, 's');
      const socket = await statOrMissing(socketPath);
      if (!sameSocket(previous, socket)) continue;
      await unlink(socketPath);
      if (sameDirectory(entry, await statOrMissing(alias))) {
        try { await rmdir(alias); } catch (error) {
          // Never recursively remove unrelated files placed in an alias dir.
          if (error.code !== 'ENOTEMPTY' && error.code !== 'ENOENT') throw error;
        }
      }
    }
  }
}

async function prepareEndpoint(endpoint, platform, probeTimeoutMs) {
  if (platform === 'win32') {
    try { await probeEndpoint(endpoint, probeTimeoutMs); } catch (error) {
      if (error.code === 'ENOENT') return;
      throw endpointError(error.code, `Cannot safely claim IPC pipe '${endpoint}': ${error.message}`, error);
    }
    throw endpointError('EADDRINUSE', `IPC endpoint is already active: '${endpoint}'. Use DSH_WORKSPACE_PIPE for another running profile.`);
  }
  await mkdir(dirname(endpoint), { recursive: true, mode: 0o700 });
  const previous = await statOrMissing(endpoint);
  if (!previous) return;
  if (!previous.isSocket()) {
    throw endpointError('EEXIST', `Refusing to replace a regular file, directory, or symlink at IPC endpoint '${endpoint}'`);
  }
  if (typeof process.getuid === 'function' && previous.uid !== process.getuid()) {
    throw endpointError('EACCES', `Refusing to remove an IPC socket owned by another user: '${endpoint}'`);
  }
  try { await probeEndpoint(endpoint, probeTimeoutMs); } catch (error) {
    // Permission errors, busy endpoints and timeouts do not prove staleness.
    if (error.code !== 'ECONNREFUSED' && error.code !== 'ENOENT') {
      throw endpointError(error.code, `Cannot safely reclaim IPC socket '${endpoint}': ${error.message}`, error);
    }
    const current = await statOrMissing(endpoint);
    if (!current) return;
    if (!sameSocket(previous, current)) {
      throw endpointError('EADDRINUSE', `IPC endpoint changed during stale-socket check: '${endpoint}'`);
    }
    await removeStaleAliases(endpoint, previous);
    const confirmed = await statOrMissing(endpoint);
    if (!confirmed) return;
    if (!sameSocket(previous, confirmed)) {
      throw endpointError('EADDRINUSE', `IPC endpoint changed during stale-alias cleanup: '${endpoint}'`);
    }
    await unlink(endpoint);
    return;
  }
  throw endpointError('EADDRINUSE', `IPC endpoint is already active: '${endpoint}'. Use DSH_WORKSPACE_SOCKET for another running profile.`);
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive safe integer`);
}

/** Local-only NDJSON RPC over the injected registry; no launcher or storage. */
export async function createWorkspaceIpcServer({
  registry,
  endpoint,
  platform = process.platform,
  profile = process.env.DSH_PROFILE || null,
  logger,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxConnections = 32,
  maxPendingRequests = 128,
  maxPendingPerConnection = 16,
  maxBufferedResponseBytes = maxResponseBytes + 1024,
  idleTimeoutMs = 30_000,
  probeTimeoutMs = 250,
} = {}) {
  validateEndpoint(endpoint, platform);
  if (!registry || typeof registry.create !== 'function') throw new TypeError('An injected workspaceRegistry is required');
  for (const [name, value] of Object.entries({
    maxRequestBytes, maxResponseBytes, maxConnections, maxPendingRequests,
    maxPendingPerConnection, maxBufferedResponseBytes, idleTimeoutMs, probeTimeoutMs,
  })) positiveInteger(value, name);

  // libuv blindly unlinks its bind pathname on close. Bind in a private 0700
  // directory and publish a hard link only after chmod0600, then guard the
  // public inode ourselves. No Node private handles or process-wide umask edits.
  const privateDirectory = platform === 'win32' ? undefined
    : join(dirname(endpoint), `._dwi${randomBytes(6).toString('hex')}`);
  const listenEndpoint = privateDirectory ? join(privateDirectory, 's') : endpoint;
  validateEndpoint(listenEndpoint, platform);
  const connections = new Set();
  let ready = false;
  let closing = false;
  let pending = 0;
  let tail = Promise.resolve();
  let ownedSocket;
  let ownedDirectory;
  let disposal;
  let startupError;

  function logError(error) {
    try { logger?.error?.(error); } catch { /* Logging must not leak resources. */ }
  }
  function respond(state, id, result, error, end = false) {
    if (state.socket.destroyed || (state.rejecting && !end)) return;
    try {
      const line = encodeResponse(id, result, error, maxResponseBytes);
      if (!line || state.socket.writableLength + line.length > maxBufferedResponseBytes) {
        state.rejecting = true;
        state.socket.destroy();
        return;
      }
      if (end) state.socket.end(line);
      else state.socket.write(line);
    } catch (reason) { logError(reason); state.socket.destroy(); }
  }
  function stop(state, id, error) {
    state.rejecting = true;
    respond(state, id, undefined, error, true);
    state.socket.setTimeout(Math.min(idleTimeoutMs, 1000));
  }
  function finishIfEnded(state) {
    if (state.readEnded && state.pending === 0 && !state.socket.destroyed && !state.rejecting) state.socket.end();
  }
  function acceptFrame(state, line) {
    if (closing || state.rejecting) return false;
    let request;
    try { request = parseRequest(line); } catch (error) {
      respond(state, error.requestId ?? null, undefined, error);
      return !state.socket.destroyed;
    }
    let operation;
    try { operation = prepareOperation(registry, request, profile); } catch (error) {
      if (!request.notification) respond(state, request.id, undefined, error);
      return !state.socket.destroyed;
    }
    if (pending >= maxPendingRequests || state.pending >= maxPendingPerConnection) {
      if (request.notification) state.socket.destroy();
      else stop(state, request.id, new RpcError(-32005, 'IPC request queue is full'));
      return false;
    }
    pending += 1;
    state.pending += 1;
    // Serialize entity rename vs registry delete within the bounded IPC queue.
    const task = tail.then(() => {
      if (closing) throw new RpcError(-32006, 'IPC listener is disposing');
      return operation();
    });
    tail = task.catch(() => undefined);
    const release = () => { pending -= 1; state.pending -= 1; finishIfEnded(state); };
    void task.then((result) => {
      if (!request.notification) respond(state, request.id, result);
    }, (error) => {
      if (!request.notification) respond(state, request.id, undefined, error);
    }).then(release, release);
    return true;
  }

  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => { /* Peer disconnects are normal, even during startup. */ });
    if (!ready || closing || connections.size >= maxConnections) { socket.destroy(); return; }
    const state = { socket, framer: new LineFramer(maxRequestBytes), pending: 0, readEnded: false, rejecting: false };
    connections.add(state);
    socket.setTimeout(idleTimeoutMs);
    socket.on('timeout', () => socket.destroy());
    socket.on('data', (chunk) => {
      try { state.framer.push(chunk, (line) => acceptFrame(state, line)); } catch (error) {
        stop(state, null, error instanceof FrameTooLargeError
          ? new RpcError(-32005, error.message) : new RpcError(-32603, 'Internal framing error'));
      }
    });
    socket.on('end', () => {
      state.readEnded = true;
      if (state.framer.length > 0 && !state.rejecting) {
        respond(state, null, undefined, new RpcError(-32700, 'Incomplete JSON-RPC frame: newline required'));
      }
      finishIfEnded(state);
    });
    socket.on('close', () => { connections.delete(state); state.framer.parts = []; state.framer.length = 0; });
  });
  server.on('error', (error) => {
    logError(error);
    if (ready) void dispose().catch(logError);
    else startupError ??= error;
  });

  function dispose() {
    if (disposal) return disposal;
    closing = true;
    ready = false;
    disposal = (async () => {
      for (const state of connections) state.socket.destroy();
      let cleanupError;
      // Keep the private inode alive while checking/unlinking its public link.
      if (platform !== 'win32' && ownedSocket) {
        try {
          const current = await statOrMissing(endpoint);
          if (sameSocket(ownedSocket, current)) await unlink(endpoint);
        } catch (error) { cleanupError = error; }
      }
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
      });
      if (platform !== 'win32' && ownedSocket) {
        try {
          if (sameSocket(ownedSocket, await statOrMissing(listenEndpoint))) await unlink(listenEndpoint);
        } catch (error) { cleanupError ??= error; }
      }
      if (ownedDirectory) {
        try {
          if (sameDirectory(ownedDirectory, await statOrMissing(privateDirectory))) await rmdir(privateDirectory);
        } catch (error) { if (error.code !== 'ENOENT') cleanupError ??= error; }
      }
      if (cleanupError) throw cleanupError;
    })();
    return disposal;
  }

  try {
    await prepareEndpoint(endpoint, platform, probeTimeoutMs);
    if (privateDirectory) {
      await mkdir(privateDirectory, { mode: 0o700 });
      ownedDirectory = await lstat(privateDirectory);
      await chmod(privateDirectory, 0o700);
    }
    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      try { server.listen({ path: listenEndpoint, readableAll: false, writableAll: false }); } catch (error) {
        server.off('error', onError); server.off('listening', onListening); reject(error);
      }
    });
    if (platform !== 'win32') {
      ownedSocket = await lstat(listenEndpoint);
      if (!ownedSocket.isSocket()) throw endpointError('EEXIST', 'Bound IPC endpoint is no longer a socket');
      await chmod(listenEndpoint, 0o600);
      await link(listenEndpoint, endpoint);
    }
    if (startupError) throw startupError;
    ready = true;
    return { endpoint, server, dispose };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { logError(cleanupError); }
    throw error;
  }
}
