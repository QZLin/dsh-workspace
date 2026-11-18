import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TAG_PREFIX = 'dsh-v';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const HOME_PREFIX = 'dsh-workspace-host-probe-';

/** Accept only canonical semver, optionally with DSH's dsh-v tag prefix. */
export function parseRelease(value) {
  if (typeof value !== 'string') throw new Error('A DSH release must be a string.');
  const version = value.startsWith(TAG_PREFIX) ? value.slice(TAG_PREFIX.length) : value;
  const match = VERSION.exec(version);
  const prerelease = match?.[4]?.split('.') ?? [];
  if (!match || match[0] !== version || version.length > 256
      || match.slice(1, 4).map(Number).some((part) => !Number.isSafeInteger(part))
      || prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error(`Invalid DSH release: ${value}`);
  }
  return { version, tag: `${TAG_PREFIX}${version}` };
}

/** Never expose a Web launch credential in committed or uploaded diagnostics. */
export function scrubProbeLog(text) {
  return text.replace(/([?&]token=)[^&#\s"']+/gi, '$1<redacted>');
}

/** The pinned bot Action supplies the real Web composition; the native CLI proves activation. */
export async function checkHost({ workdir = process.cwd(), version, install, start, cacheRoot,
  runCli = spawnSync } = {}) {
  const release = parseRelease(version);
  const home = await mkdtemp(join(tmpdir(), HOME_PREFIX));
  let host;
  try {
    const installed = install(release.version, cacheRoot ?? join(workdir, '.dsh-migrate', 'dsh'), { timeoutMs: 900_000 });
    if (!installed.ok || !installed.bin) throw new Error(`Target DSH installation failed: ${installed.detail}`);
    const started = await start({
      workdir, bin: installed.bin, dshTag: release.tag, homeDir: home,
      profile: 'probe-web', timeoutMs: 180_000,
      env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
    });
    if (!started.ok) throw new Error(`Web profile failed: ${started.failure.signature}\n${started.failure.detail}`);
    host = started.host;
    const env = { ...process.env };
    delete env.DSH_WORKSPACE_SOCKET;
    delete env.DSH_WORKSPACE_PIPE;
    const result = runCli(resolve(workdir, '.tmp', 'dsh-workspace-probe'),
      ['ping', '--dshHome', home, '--json'], { cwd: workdir, env, encoding: 'utf8', timeout: 10_000 });
    if (result.error || result.status !== 0) {
      throw new Error(`Native CLI IPC ping failed: ${result.error?.message ?? result.stderr ?? result.status}`);
    }
    const ping = JSON.parse(result.stdout);
    if (ping?.service !== 'dsh-workspace' || ping.protocolVersion !== 1) {
      throw new Error('Native CLI returned an unexpected workspace IPC identity.');
    }
    return { tag: release.tag, service: ping.service, protocolVersion: ping.protocolVersion };
  } finally {
    try { host?.stop(); } finally {
      // Delete only the absolute, private scratch home this invocation created.
      if (!isAbsolute(home) || dirname(home) !== resolve(tmpdir()) || !basename(home).startsWith(HOME_PREFIX)) {
        throw new Error('Refusing to remove an unowned Host probe home.');
      }
      await rm(home, { recursive: true, force: true });
    }
  }
}

async function main() {
  let diagnostic;
  try {
    const appRoot = process.env.DSH_MIGRATE_APP_ROOT ?? process.env.GITHUB_ACTION_PATH;
    if (!appRoot) {
      throw new Error('Run this check inside the pinned QZLin/dsh-migrate-bot v3 Action, or set DSH_MIGRATE_APP_ROOT.');
    }
    const target = process.argv[2]?.trim() || process.env.DSH_MIGRATE_TARGET_VERSION?.trim();
    if (!target) throw new Error('The v3 mechanical check did not provide DSH_MIGRATE_TARGET_VERSION.');
    // Fail on an unusable release before loading any Action module.
    parseRelease(target);
    const migrateHome = resolve(process.env.DSH_MIGRATE_HOME?.trim() || '.dsh-migrate');
    // The probe can boot and serve, but can never send a request to a real model.
    process.env.DSH_MIGRATE_PROBE_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.DSH_MIGRATE_PROBE_API_KEY = 'probe-placeholder-key';
    let ensureDsh;
    let startWebHost;
    try {
      [{ ensureDsh }, { startWebHost }] = await Promise.all([
        import(pathToFileURL(join(resolve(appRoot), 'dist/src/verify/dsh-install.js')).href),
        import(pathToFileURL(join(resolve(appRoot), 'dist/src/verify/web.js')).href),
      ]);
    } catch (error) {
      throw new Error(`The pinned dsh-migrate-bot v3 checkout at ${resolve(appRoot)} does not provide the expected check modules: ${error.message}`);
    }
    const checked = await checkHost({
      version: target,
      install: ensureDsh,
      start: startWebHost,
      cacheRoot: join(migrateHome, 'dsh'),
    });
    diagnostic = `web-host: pass (${checked.tag})\nnative CLI IPC ping: pass (${checked.service}, protocol ${checked.protocolVersion})\n`;
  } catch (error) {
    diagnostic = `web-host: fail\n${scrubProbeLog(error.message)}\n`;
    process.exitCode = 1;
  }
  const logs = resolve(process.env.DSH_MIGRATE_HOME?.trim() || '.dsh-migrate', 'runs/host-probe/checks');
  await mkdir(logs, { recursive: true });
  await writeFile(join(logs, '02-web-host.log'), diagnostic, 'utf8');
  console.log(diagnostic.trimEnd());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(scrubProbeLog(error.message)); process.exitCode = 1; });
}
