import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkHost, parseRelease, scrubProbeLog } from '../scripts/check-dsh-host.mjs';

test('DSH releases accept canonical versions and dsh-v tags only', () => {
  assert.deepEqual(parseRelease('dsh-v0.2.2-rc.1'), {
    version: '0.2.2-rc.1',
    tag: 'dsh-v0.2.2-rc.1',
  });
  assert.equal(parseRelease('1.0.0+build.01').tag, 'dsh-v1.0.0+build.01');
  for (const value of ['', 'latest', 'v0.2.2', '0.02.2', '0.2.2-rc.01',
    '0.2.2;echo injected', '0.2.2\nchanged=true', '0.2.2\n', undefined]) {
    assert.throws(() => parseRelease(value), /release/);
  }
});

/** The heredoc the workflow writes its inline configuration from. */
function inlineConfig(workflow) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line.includes("<<'YAML'"));
  assert.notEqual(start, -1, 'the workflow must write its configuration inline');
  const end = lines.findIndex((line, index) => index > start && line.trim() === 'YAML');
  assert.notEqual(end, -1, 'the inline configuration must be terminated');
  const body = lines.slice(start + 1, end);
  const indented = body.filter((line) => line.trim() !== '');
  const indent = Math.min(...indented.map((line) => line.length - line.trimStart().length));
  return body.map((line) => line.slice(indent)).join('\n');
}

test('The workflow uses pinned QZLin v3 state and proposal semantics', async () => {
  const [workflow, manifest, probe] = await Promise.all([
    readFile(new URL('../.github/workflows/dsh-migrate.yml', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../scripts/check-dsh-host.mjs', import.meta.url), 'utf8'),
  ]);
  const config = inlineConfig(workflow);

  assert.match(workflow, /QZLin\/dsh-migrate-bot@(?:[a-f0-9]{40}|v3)\b/);
  assert.match(workflow, /command: bump/);
  assert.match(workflow, /config: \.tmp\/dsh-migrate-config\.yml/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /pull-requests: write/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.doesNotMatch(workflow, /royenheart|ghcr\.io|docker run|git push|scripts\/dsh-migrate\.mjs/);

  // The configuration is inline only: no separate file carries it.
  assert.doesNotMatch(workflow, /\.github\/dsh-migrate-config\.yml/);
  await assert.rejects(readFile(new URL('../.github/dsh-migrate-config.yml', import.meta.url), 'utf8'));

  assert.match(config, /^target: latest$/m);
  assert.match(config, /^\s+ownVersion: false$/m);
  assert.match(config, /^\s+- go -C cli test \.\/\.\.\.$/m);
  assert.match(config, /CGO_ENABLED=0 go -C cli build/);
  assert.match(config, /^\s+- node scripts\/check-dsh-host\.mjs$/m);
  assert.match(config, /^\s+commandMs: 900000$/m);
  assert.doesNotMatch(config, /^\s*(cards|e2e|agent|reports|deploy):/m);
  assert.doesNotMatch(config, /\t/);

  assert.equal(manifest.engines.dsh, '>=0.2.0 <0.3.0');
  assert.match(probe, /DSH_MIGRATE_TARGET_VERSION/);
  assert.match(probe, /GITHUB_ACTION_PATH/);
  assert.match(probe, /DSH_MIGRATE_PROBE_API_KEY/);
});

test('The Host probe requires the real Web profile and a read-only native IPC handshake', async () => {
  let home;
  let stopped = 0;
  const checked = await checkHost({
    version: '0.2.2-rc.1',
    cacheRoot: 'test-dsh-cache',
    install: (version, cacheRoot) => {
      assert.equal(version, '0.2.2-rc.1');
      assert.equal(cacheRoot, 'test-dsh-cache');
      return { ok: true, bin: 'unused-test-dsh' };
    },
    start: async (options) => {
      assert.equal(options.profile, 'probe-web');
      home = options.homeDir;
      return { ok: true, host: { stop() { stopped++; } } };
    },
    runCli: (binary, args) => {
      assert.equal(binary.endsWith('dsh-workspace-probe'), true);
      assert.deepEqual(args, ['ping', '--dshHome', home, '--json']);
      return {
        status: 0,
        stdout: JSON.stringify({ service: 'dsh-workspace', protocolVersion: 1, profile: null }),
      };
    },
  });
  assert.equal(checked.tag, 'dsh-v0.2.2-rc.1');
  assert.equal(stopped, 1);
});

test('A Web profile that cannot provide the plugin services fails instead of skipping', async () => {
  await assert.rejects(checkHost({
    version: '0.2.2-rc.1',
    install: () => ({ ok: true, bin: 'unused-test-dsh' }),
    start: async () => ({
      ok: false,
      failure: { signature: 'pending: workspaceRegistry', detail: 'missing provider' },
    }),
    runCli: () => assert.fail('A failed boot must not reach the native CLI'),
  }), /pending: workspaceRegistry/);
});

test('A server-ready line alone is insufficient when IPC is absent or has the wrong identity', async () => {
  for (const reply of [
    { status: 3, stderr: 'connection refused' },
    { status: 0, stdout: JSON.stringify({ service: 'other-service', protocolVersion: 1 }) },
  ]) {
    let stopped = 0;
    await assert.rejects(checkHost({
      version: '0.2.2-rc.1',
      install: () => ({ ok: true, bin: 'unused-test-dsh' }),
      start: async () => ({ ok: true, host: { stop() { stopped++; } } }),
      runCli: () => reply,
    }), /IPC ping failed|unexpected workspace IPC identity/);
    assert.equal(stopped, 1);
  }
});

test('Web launch credentials are redacted before diagnostics are persisted', () => {
  const sensitive = ['test', 'only', 'sensitive'].join('-');
  const log = scrubProbeLog(`URL: http://127.0.0.1:123/?token=${sensitive}`);
  assert.equal(log.includes(sensitive), false);
  assert.match(log, /token=<redacted>/);
});

test('The probe exits non-zero and records why when the v3 Action context is missing', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-host-probe-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, DSH_MIGRATE_HOME: home };
  delete env.DSH_MIGRATE_APP_ROOT;
  delete env.GITHUB_ACTION_PATH;
  delete env.DSH_MIGRATE_TARGET_VERSION;
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-dsh-host.mjs', import.meta.url))], {
    env, cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /web-host: fail/);
  assert.match(result.stdout, /QZLin\/dsh-migrate-bot v3 Action/);
  const log = await readFile(join(home, 'runs/host-probe/checks/02-web-host.log'), 'utf8');
  assert.match(log, /web-host: fail/);
});

test('The probe rejects a target release the v3 mechanical check cannot have produced', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-host-probe-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/check-dsh-host.mjs', import.meta.url))], {
    env: { ...process.env, DSH_MIGRATE_HOME: home, DSH_MIGRATE_APP_ROOT: home,
      DSH_MIGRATE_TARGET_VERSION: '0.2.2;echo injected' },
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Invalid DSH release/);
});
