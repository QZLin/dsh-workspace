import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export const SOCKET_FILENAME = '.dsh-workspace.sock';
export const PIPE_PREFIX = '\\\\.\\pipe\\dsh-workspace-';

function nonblank(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// This is exclusively transport configuration. Never use it on workspace paths.
function expandHome(value, home, paths) {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return paths.join(home, value.slice(2));
  }
  return value;
}

function option(value, name) {
  if (value !== undefined && !nonblank(value)) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function asciiLower(value) {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

export function validateEndpoint(endpoint, platform = process.platform) {
  if (!nonblank(endpoint) || endpoint.includes('\0')) {
    throw new TypeError('IPC endpoint must be a non-empty string without NUL bytes');
  }
  if (platform === 'win32') {
    // Never allow TCP, remote pipes, or a process-dependent drive-relative pipe.
    if (!/^\\\\\.\\pipe\\[^\\/]+$/i.test(endpoint)) {
      throw new TypeError('Windows IPC endpoint must be a local named pipe: \\\\.\\pipe\\NAME');
    }
  } else {
    if (!posix.isAbsolute(endpoint)) {
      throw new TypeError('Unix IPC endpoint must be an absolute socket path');
    }
    const limit = platform === 'linux' ? 107 : 103;
    if (Buffer.byteLength(endpoint, 'utf8') > limit) {
      throw new TypeError(`Unix socket path exceeds ${limit} UTF-8 bytes; choose a shorter DSH_HOME or DSH_WORKSPACE_SOCKET`);
    }
  }
  return endpoint;
}

/**
 * Resolve only the IPC endpoint, never a business workspace path.
 * Explicit endpoint > platform-specific environment > resolved DSH home.
 * A home selects one endpoint; no profile scanning or fallback is performed.
 */
export function resolveEndpoint({
  platform = process.platform,
  env = process.env,
  dshHome,
  endpoint,
  home = homedir(),
  cwd = process.cwd(),
} = {}) {
  option(endpoint, 'endpoint');
  option(dshHome, 'dshHome');
  const paths = platform === 'win32' ? win32 : posix;
  const override = endpoint ?? (nonblank(env[platform === 'win32' ? 'DSH_WORKSPACE_PIPE' : 'DSH_WORKSPACE_SOCKET'])
    ? env[platform === 'win32' ? 'DSH_WORKSPACE_PIPE' : 'DSH_WORKSPACE_SOCKET'] : undefined);
  if (override !== undefined) {
    const resolved = platform === 'win32' ? override : paths.resolve(cwd, expandHome(override, home, paths));
    return validateEndpoint(resolved, platform);
  }
  const root = dshHome ?? (nonblank(env.DSH_HOME) ? env.DSH_HOME : paths.join(home, '.dsh'));
  const absoluteHome = paths.resolve(cwd, expandHome(root, home, paths));
  if (absoluteHome.includes('\0')) throw new TypeError('Resolved DSH home must not contain NUL bytes');
  if (platform !== 'win32') {
    return validateEndpoint(paths.join(absoluteHome, SOCKET_FILENAME), platform);
  }
  const identity = asciiLower(absoluteHome.replaceAll('/', '\\').replace(/\\+$/, ''));
  const suffix = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 24);
  return validateEndpoint(`${PIPE_PREFIX}${suffix}`, platform);
}
