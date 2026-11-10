import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseRelease } from './dsh-migrate.mjs';

const HOME_PREFIX = 'dsh-workspace-host-probe-';

/** Never expose a Web launch credential in committed or uploaded diagnostics. */
export function scrubProbeLog(text) {
  return text.replace(/([?&]token=)[^&#\s"']+/gi, '$1<redacted>');
}

/** The pinned bot supplies the real Web composition; the native CLI proves activation. */
export async function checkHost({ workdir = process.cwd(), version, install, start,
  runCli = spawnSync } = {}) {
  const release = parseRelease(version);
  const home = await mkdtemp(join(tmpdir(), HOME_PREFIX));
  let host;
  try {
    const installed = install(release.version, join(workdir, '.dsh-migrate', 'dsh'), { timeoutMs: 900_000 });
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
    const appRoot = process.env.DSH_MIGRATE_APP_ROOT;
    if (!appRoot) throw new Error('Run this check inside the pinned dsh-migrate-bot image, not a local DSH profile.');
    // The probe can boot and serve, but can never send a request to a real model.
    process.env.DSH_MIGRATE_PROBE_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.DSH_MIGRATE_PROBE_KEY = 'probe-placeholder-key';
    const [{ ensureDsh }, { startWebHost }] = await Promise.all([
      import(pathToFileURL(join(appRoot, 'dist/src/verify/dsh-install.js')).href),
      import(pathToFileURL(join(appRoot, 'dist/src/verify/web.js')).href),
    ]);
    const checked = await checkHost({ version: process.argv[2], install: ensureDsh, start: startWebHost });
    diagnostic = `web-host: pass (${checked.tag})\nnative CLI IPC ping: pass (${checked.service}, protocol ${checked.protocolVersion})\n`;
  } catch (error) {
    diagnostic = `web-host: fail\n${scrubProbeLog(error.message)}\n`;
    process.exitCode = 1;
  }
  const logs = resolve('.dsh-migrate/runs/host-probe/checks');
  await mkdir(logs, { recursive: true });
  await writeFile(join(logs, '02-web-host.log'), diagnostic, 'utf8');
  console.log(diagnostic.trimEnd());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(scrubProbeLog(error.message)); process.exitCode = 1; });
}
