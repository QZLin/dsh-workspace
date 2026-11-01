import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { resolveEndpoint } from '../src/endpoint.js';

const PIPE_PREFIX = '\\\\.\\pipe\\dsh-workspace-';
const WIN_CWD = 'C:\\sandbox\\current';
const WIN_HOME = 'C:\\Users\\Tester';
const UNIX_CWD = '/sandbox/current';
const UNIX_HOME = '/users/tester';

function pipeFor(identity) {
  // Expected identities are written independently of the implementation's canonicalizer.
  return PIPE_PREFIX + createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 24);
}

function windows(options = {}) {
  return resolveEndpoint({ platform: 'win32', env: {}, cwd: WIN_CWD, home: WIN_HOME, ...options });
}

function unix(options = {}) {
  return resolveEndpoint({ platform: 'linux', env: {}, cwd: UNIX_CWD, home: UNIX_HOME, ...options });
}

test('Windows defaults use one local SHA-256 pipe for the resolved DSH home', () => {
  assert.equal(windows(), pipeFor('c:\\users\\tester\\.dsh'));
  assert.match(windows(), /^\\\\\.\\pipe\\dsh-workspace-[0-9a-f]{24}$/);
  assert.equal(windows({ env: { DSH_HOME: 'C:\\Profiles\\active' } }), pipeFor('c:\\profiles\\active'));
  assert.equal(windows({
    dshHome: 'C:\\Profiles\\explicit',
    env: { DSH_HOME: 'C:\\Profiles\\environment' },
  }), pipeFor('c:\\profiles\\explicit'));
  assert.equal(windows({ env: { DSH_HOME: ' \t\r\n' } }), windows());
});

test('Windows pipe identity cleans absolute paths and removes every trailing separator', () => {
  const expected = pipeFor('c:\\profiles\\active');
  for (const dshHome of [
    'C:\\Profiles\\Active',
    'c:/profiles/Active/',
    'C:\\Profiles\\unused\\..\\ACTIVE\\\\\\',
  ]) assert.equal(windows({ dshHome }), expected, dshHome);
  assert.equal(windows({ dshHome: 'profiles\\..\\Active' }), pipeFor('c:\\sandbox\\current\\active'));
  assert.equal(windows({ dshHome: 'C:\\' }), pipeFor('c:'));
  assert.equal(windows({ dshHome: 'C:\\\\\\' }), pipeFor('c:'));
  assert.equal(windows({ dshHome: '\\\\SERVER\\Share\\Profile\\\\' }), pipeFor('\\\\server\\share\\profile'));
});

test('Windows identity folds ASCII letters only, preserving Unicode case', () => {
  const uppercaseUnicode = windows({ dshHome: 'C:\\Profiles\\ÄÖΣİẞ\\ABC' });
  assert.equal(uppercaseUnicode, pipeFor('c:\\profiles\\ÄÖΣİẞ\\abc'));
  assert.equal(uppercaseUnicode, windows({ dshHome: 'c:\\profiles\\ÄÖΣİẞ\\abc' }));
  assert.notEqual(uppercaseUnicode, windows({ dshHome: 'c:\\profiles\\äöσi̇ß\\abc' }));
});

test('Windows explicit local pipe outranks only the Windows endpoint environment variable', () => {
  const explicit = '\\\\.\\pipe\\explicit-workspace';
  const environment = '\\\\.\\pipe\\environment-workspace';
  assert.equal(windows({ endpoint: explicit, env: { DSH_WORKSPACE_PIPE: environment } }), explicit);
  assert.equal(windows({ env: { DSH_WORKSPACE_PIPE: environment } }), environment);
  assert.equal(windows({ env: { DSH_WORKSPACE_SOCKET: '/ignored/unix.sock' } }), windows());
  assert.equal(windows({ env: { DSH_WORKSPACE_PIPE: '\t ' } }), windows());
});

test('Windows endpoint validation rejects remote, incomplete, filesystem and TCP endpoints', () => {
  for (const endpoint of [
    '\\\\remote-host\\pipe\\workspace',
    '\\\\localhost\\pipe\\workspace',
    '\\\\?\\pipe\\workspace',
    '\\\\.\\pipe\\',
    '\\\\.\\pipe\\nested\\workspace',
    'pipe\\workspace',
    'C:\\workspace.sock',
    '//./pipe/workspace',
    'tcp://127.0.0.1:12345',
    '127.0.0.1:12345',
    '\\\\.\\pipe\\nul\0name',
  ]) assert.throws(() => windows({ endpoint }), undefined, endpoint);
  assert.throws(() => windows({ env: { DSH_WORKSPACE_PIPE: '\\\\remote\\pipe\\workspace' } }));
});

test('Endpoint and DSH-home configuration must be nonblank strings', () => {
  for (const value of ['', '  ', null, 12, true, [], {}]) {
    assert.throws(() => windows({ endpoint: value }), undefined, `endpoint ${JSON.stringify(value)}`);
    assert.throws(() => windows({ dshHome: value }), undefined, `dshHome ${JSON.stringify(value)}`);
  }
});

test('Windows transport configuration expands tilde without affecting business paths', () => {
  assert.equal(windows({ dshHome: '~' }), pipeFor('c:\\users\\tester'));
  assert.equal(windows({ dshHome: '~/profiles/active' }), pipeFor('c:\\users\\tester\\profiles\\active'));
  assert.equal(windows({ dshHome: '~\\profiles\\active' }), pipeFor('c:\\users\\tester\\profiles\\active'));
  assert.equal(windows({ env: { DSH_HOME: '~\\environment' } }), pipeFor('c:\\users\\tester\\environment'));
});

test('Unix endpoint priority uses explicit configuration, then socket environment, then DSH home', () => {
  assert.equal(unix(), '/users/tester/.dsh/.dsh-workspace.sock');
  assert.equal(unix({ env: { DSH_HOME: '/profiles/environment' } }), '/profiles/environment/.dsh-workspace.sock');
  assert.equal(unix({
    dshHome: '/profiles/explicit',
    env: { DSH_HOME: '/profiles/environment' },
  }), '/profiles/explicit/.dsh-workspace.sock');
  assert.equal(unix({
    endpoint: '/ipc/explicit.sock',
    dshHome: '/profiles/explicit',
    env: { DSH_WORKSPACE_SOCKET: '/ipc/environment.sock' },
  }), '/ipc/explicit.sock');
  assert.equal(unix({ env: { DSH_WORKSPACE_SOCKET: '/ipc/environment.sock' } }), '/ipc/environment.sock');
  assert.equal(unix({ env: { DSH_WORKSPACE_PIPE: '\\\\.\\pipe\\ignored' } }), unix());
  assert.equal(unix({ env: { DSH_HOME: '\t ', DSH_WORKSPACE_SOCKET: '\r\n' } }), unix());
});

test('Unix transport configuration resolves relative paths and expands tilde', () => {
  assert.equal(unix({ dshHome: './profiles/../active' }), '/sandbox/current/active/.dsh-workspace.sock');
  assert.equal(unix({ dshHome: '~' }), '/users/tester/.dsh-workspace.sock');
  assert.equal(unix({ dshHome: '~/profiles/active' }), '/users/tester/profiles/active/.dsh-workspace.sock');
  assert.equal(unix({ endpoint: './ipc.sock' }), '/sandbox/current/ipc.sock');
  assert.equal(unix({ endpoint: '~/ipc.sock' }), '/users/tester/ipc.sock');
  assert.equal(unix({ env: { DSH_HOME: '~/environment' } }), '/users/tester/environment/.dsh-workspace.sock');
  assert.equal(unix({ env: { DSH_WORKSPACE_SOCKET: '~/environment.sock' } }), '/users/tester/environment.sock');
});

test('Unix endpoint path validation measures UTF-8 bytes for platform-specific socket limits', () => {
  const linuxBoundary = '/' + 's'.repeat(106);
  assert.equal(unix({ endpoint: linuxBoundary }), linuxBoundary);
  assert.throws(() => unix({ endpoint: linuxBoundary + 's' }));
  const darwinBoundary = '/' + 's'.repeat(102);
  assert.equal(unix({ platform: 'darwin', endpoint: darwinBoundary }), darwinBoundary);
  assert.throws(() => unix({ platform: 'darwin', endpoint: darwinBoundary + 's' }));
  assert.throws(() => unix({ endpoint: '/' + '😀'.repeat(27) }));
  assert.throws(() => unix({ endpoint: '/ipc/nul\0.sock' }));
});

test('Windows rejects NUL in the chosen resolved DSH home before hashing its identity', () => {
  for (const options of [
    { dshHome: 'C:\\Profiles\\nul\0home' },
    { env: { DSH_HOME: 'C:\\Profiles\\nul\0home' } },
    { home: 'C:\\Users\\nul\0home' },
    { dshHome: '~\\active', home: 'C:\\Users\\nul\0home' },
    { dshHome: 'relative', cwd: 'C:\\sandbox\\nul\0cwd' },
  ]) assert.throws(() => windows(options));
});

test('FreeBSD socket paths use the 103-byte non-Linux Unix boundary', () => {
  const asciiBoundary = '/' + 's'.repeat(102);
  const utf8Boundary = '/' + 'é'.repeat(51);
  for (const endpoint of [asciiBoundary, utf8Boundary]) {
    assert.equal(Buffer.byteLength(endpoint), 103);
    assert.equal(unix({ platform: 'freebsd', endpoint }), endpoint);
    assert.throws(() => unix({ platform: 'freebsd', endpoint: endpoint + 's' }));
  }
});

test('Endpoint resolution is independent of profile and unrelated process environment', () => {
  assert.equal(windows({ env: { DSH_PROFILE: 'alpha', DSH_PROFILE_DIR: 'C:\\alpha' } }), windows());
  assert.equal(unix({ env: { DSH_PROFILE: 'beta', DSH_PROFILE_DIR: '/beta' } }), unix());
  const env = Object.freeze({ DSH_HOME: '/profiles/stable' });
  assert.equal(unix({ env }), path.posix.join(env.DSH_HOME, '.dsh-workspace.sock'));
  assert.deepEqual(env, { DSH_HOME: '/profiles/stable' });
});
