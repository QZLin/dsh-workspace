import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareReleases, latestRelease, parseRelease, planUpgrade, prepareUpgrade } from '../scripts/dsh-migrate.mjs';
import { checkHost, scrubProbeLog } from '../scripts/check-dsh-host.mjs';

const fixture = () => ({
  name: 'dsh-workspace-ipc', version: '0.1.0',
  engines: { node: '>=22', dsh: '>=0.2.1-rc.2 <0.3.0' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
});

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mechanical-upgrade-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('DSH releases accept canonical versions and tags, and reject unsafe input', () => {
  assert.equal(parseRelease('dsh-v0.2.2-rc.1').version, '0.2.2-rc.1');
  assert.equal(parseRelease('0.2.2-rc.1').tag, 'dsh-v0.2.2-rc.1');
  assert.equal(parseRelease('1.0.0+build.01').version, '1.0.0+build.01');
  for (const value of ['', 'latest', 'v0.2.2', '0.02.2', '0.2.2-rc.01', '0.2.2;echo injected',
    '0.2.2\nchanged=true', '0.2.2\n', '0.2.2\r\n', `0.2.2-${'a'.repeat(256)}`, '0.2.2-', '9007199254740992.0.0', undefined]) {
    assert.throws(() => parseRelease(value), /release/);
  }
});

test('Release ordering follows semver, not tag names or publication order', () => {
  const ordered = ['0.2.2-alpha.2', '0.2.2-alpha.10', '0.2.2-beta', '0.2.2-rc.1',
    '0.2.2-rc.2', '0.2.2-rc.10', '0.2.2', '0.2.3-alpha.1', '0.3.0', '1.0.0'];
  for (let index = 1; index < ordered.length; index++) {
    assert.equal(compareReleases(ordered[index - 1], ordered[index]), -1);
    assert.equal(compareReleases(ordered[index], ordered[index - 1]), 1);
  }
  assert.equal(compareReleases('1.0.0+abc', '1.0.0+def'), 0);
  assert.equal(compareReleases('1.0.0-1', '1.0.0-alpha'), -1);
  assert.equal(compareReleases('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareReleases('1.0.0-99999999999999999999', '1.0.0-100000000000000000000'), -1);
});

test('Only engines.dsh changes and existing upper compatibility bounds are preserved', () => {
  const original = fixture();
  const before = structuredClone(original);
  const plan = planUpgrade(original, 'dsh-v0.2.2-rc.1');
  assert.equal(plan.changed, true);
  assert.equal(plan.shouldCheck, true);
  assert.equal(plan.manifest.engines.dsh, '>=0.2.2-rc.1 <0.3.0');
  const expected = fixture();
  expected.engines.dsh = plan.manifest.engines.dsh;
  assert.deepEqual(plan.manifest, expected);
  assert.deepEqual(original, before);
});

test('Crossing a compatibility boundary uses next minor for 0.x and next major for 1.x', () => {
  assert.equal(planUpgrade(fixture(), '0.3.0').manifest.engines.dsh, '>=0.3.0 <0.4.0');
  assert.equal(planUpgrade(fixture(), '1.2.3').manifest.engines.dsh, '>=1.2.3 <2.0.0');
});

test('An already verified release skips by default; force only rechecks, never downgrades', () => {
  const original = fixture();
  assert.equal(planUpgrade(original, '0.2.1-rc.2').shouldCheck, false);
  const forced = planUpgrade(original, '0.2.1-rc.2', { force: true });
  assert.equal(forced.changed, false);
  assert.equal(forced.shouldCheck, true);
  assert.deepEqual(forced.manifest, original);
  assert.throws(() => planUpgrade(original, '0.2.0', { force: true }), /downgrade/);
});

test('Unknown engine range shapes and packages without a DSH bundle fail closed', () => {
  const malformed = fixture();
  malformed.engines.dsh = '^0.2.1';
  assert.throws(() => planUpgrade(malformed, '0.2.2'), /engines.dsh/);
  malformed.engines.dsh = '>=0.3.0 <0.2.0';
  assert.throws(() => planUpgrade(malformed, '0.3.0'), /invalid compatibility interval/);
  assert.throws(() => planUpgrade({ name: 'ordinary-package' }, '0.2.2'), /dsh.bundle/);
});

test('Latest release lookup paginates and includes prereleases without leaking its credential', async () => {
  const calls = [];
  const pages = [Array.from({ length: 100 }, (_, index) => ({ name: `other-v${index}` })),
    [{ name: 'dsh-v0.2.1-rc.5' }, { name: 'dsh-v0.2.2-rc.10' },
      { name: 'dsh-v0.2.2-rc.2' }, { name: 'dsh-v0.2.2-rc.01' }]];
  const release = await latestRelease({ token: 'test-only-credential', fetchImpl: async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer test-only-credential');
    return Response.json(pages[calls.length - 1]);
  } });
  assert.equal(release.tag, 'dsh-v0.2.2-rc.10');
  assert.match(calls[1], /page=2$/);
  assert.equal(JSON.stringify(release).includes('test-only-credential'), false);
});

test('Latest release lookup rejects API errors, invalid results and missing releases', async () => {
  await assert.rejects(latestRelease({ fetchImpl: async () => new Response('', { status: 403 }) }), /HTTP 403/);
  await assert.rejects(latestRelease({ fetchImpl: async () => Response.json({ message: 'bad' }) }), /invalid response/);
  await assert.rejects(latestRelease({ fetchImpl: async () => Response.json([]) }), /no canonical/);
});

test('Preparing an upgrade writes only the candidate manifest and bounded GitHub outputs', async (t) => {
  const workdir = await scratch(t);
  const outputPath = join(workdir, 'github-output');
  const summaryPath = join(workdir, 'github-summary');
  await writeFile(join(workdir, 'package.json'), `${JSON.stringify(fixture(), null, 2)}\n`);
  const plan = await prepareUpgrade({ workdir, target: '0.2.2-rc.1', outputPath, summaryPath });
  const candidate = JSON.parse(await readFile(join(workdir, 'package.json'), 'utf8'));
  assert.equal(candidate.engines.dsh, '>=0.2.2-rc.1 <0.3.0');
  assert.equal(candidate.version, '0.1.0');
  const outputs = await readFile(outputPath, 'utf8');
  assert.match(outputs, /^target_tag=dsh-v0\.2\.2-rc\.1\n/);
  assert.match(outputs, /\nchanged=true\nshould_check=true\nmanifest_sha=[a-f0-9]{64}\n$/);
  assert.equal(plan.outputs.changed, 'true');
  assert.match(await readFile(summaryPath, 'utf8'), /no LLM/);
});

test('Dry runs and failed network lookups do not modify the manifest', async (t) => {
  const workdir = await scratch(t);
  const manifestPath = join(workdir, 'package.json');
  const original = `${JSON.stringify(fixture(), null, 2)}\n`;
  await writeFile(manifestPath, original);
  await prepareUpgrade({ workdir, target: '0.2.2', dryRun: true });
  assert.equal(await readFile(manifestPath, 'utf8'), original);
  await assert.rejects(prepareUpgrade({ workdir, fetchImpl: async () => new Response('', { status: 500 }) }), /HTTP 500/);
  assert.equal(await readFile(manifestPath, 'utf8'), original);
});

test('The workflow runs the official check entrypoint, never an LLM migration or force push', async () => {
  const workflow = await readFile(new URL('../.github/workflows/dsh-migrate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /royenheart\/dsh-migrate-bot@[a-f0-9]{40}/);
  assert.match(workflow, /command: check/);
  assert.doesNotMatch(workflow, /command: run|DEEPSEEK_API_KEY|secrets: inherit|git push[^\n]*--force/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /contents: write/);
  assert.match(workflow, /sha256sum --check --strict/);
  assert.match(workflow, /DSH_MIGRATE_CLI=\/github\/workspace\/scripts\/check-dsh-host\.mjs/);
  assert.match(workflow, /CGO_ENABLED=0 go -C cli build/);
});

test('The Host probe requires the real Web profile and a read-only native IPC handshake', async () => {
  let home;
  let stopped = 0;
  const checked = await checkHost({ version: '0.2.2-rc.1',
    install: (version) => { assert.equal(version, '0.2.2-rc.1'); return { ok: true, bin: 'unused-test-dsh' }; },
    start: async (options) => {
      assert.equal(options.profile, 'probe-web');
      home = options.homeDir;
      return { ok: true, host: { stop() { stopped++; } } };
    },
    runCli: (binary, args) => {
      assert.equal(binary.endsWith('dsh-workspace-probe'), true);
      assert.deepEqual(args, ['ping', '--dshHome', home, '--json']);
      return { status: 0, stdout: JSON.stringify({ service: 'dsh-workspace', protocolVersion: 1, profile: null }) };
    },
  });
  assert.equal(checked.tag, 'dsh-v0.2.2-rc.1');
  assert.equal(stopped, 1);
});

test('A Web profile that cannot provide the plugin services fails instead of skipping', async () => {
  await assert.rejects(checkHost({ version: '0.2.2-rc.1',
    install: () => ({ ok: true, bin: 'unused-test-dsh' }),
    start: async () => ({ ok: false, failure: { signature: 'pending: workspaceRegistry', detail: 'missing provider' } }),
    runCli: () => assert.fail('A failed boot must not reach the native CLI'),
  }), /pending: workspaceRegistry/);
});

test('A server-ready line alone is insufficient when IPC is absent or has the wrong identity', async () => {
  for (const reply of [{ status: 3, stderr: 'connection refused' },
    { status: 0, stdout: JSON.stringify({ service: 'other-service', protocolVersion: 1 }) }]) {
    let stopped = 0;
    await assert.rejects(checkHost({ version: '0.2.2-rc.1',
      install: () => ({ ok: true, bin: 'unused-test-dsh' }),
      start: async () => ({ ok: true, host: { stop() { stopped++; } } }),
      runCli: () => reply,
    }), /IPC ping failed|unexpected workspace IPC identity/);
    assert.equal(stopped, 1);
  }
});

test('Web launch tokens are redacted before Host check diagnostics are uploaded', () => {
  const log = scrubProbeLog('URL: http://127.0.0.1:123/?token=test-only-sensitive-token&next=1\n');
  assert.equal(log.includes('test-only-sensitive-token'), false);
  assert.match(log, /token=<redacted>&next=1/);
});
