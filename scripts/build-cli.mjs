import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
if (argv.some((arg) => arg !== '--all')) {
  console.error('Usage: node scripts/build-cli.mjs [--all]');
  process.exitCode = 2;
} else {
  const platforms = { win32: 'windows', linux: 'linux', darwin: 'darwin', freebsd: 'freebsd', openbsd: 'openbsd' };
  const arches = { x64: 'amd64', arm64: 'arm64', ia32: '386' };
  const target = [platforms[process.platform], arches[process.arch]];
  const all = argv.includes('--all');
  const targets = all ? [
    ['windows', 'amd64'], ['windows', 'arm64'],
    ['linux', 'amd64'], ['linux', 'arm64'],
    ['darwin', 'amd64'], ['darwin', 'arm64'],
  ] : [target];
  if (targets.some(([os, arch]) => !os || !arch)) throw new Error('Unsupported host; use --all for release targets');
  if (!existsSync(join(root, 'cli', 'go.mod'))) throw new Error('CLI source is missing');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const sums = [];
  for (const [os, arch] of targets) {
    const directory = all ? join(root, 'dist', `${os}-${arch}`) : join(root, 'dist');
    await mkdir(directory, { recursive: true });
    for (const document of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'README.md']) {
      await writeFile(join(directory, document), await readFile(join(root, document)));
    }
    const filename = os === 'windows' ? 'dsh-workspace.exe' : 'dsh-workspace';
    const output = join(directory, filename);
    console.log(`Build ${os}/${arch} -> ${output}`);
    const result = spawnSync('go', [
      'build', '-trimpath', '-ldflags', `-s -w -X main.version=${pkg.version}`, '-o', output, '.',
    ], {
      cwd: join(root, 'cli'),
      env: { ...process.env, CGO_ENABLED: '0', GOOS: os, GOARCH: arch },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status || 1;
      break;
    }
    const digest = createHash('sha256').update(await readFile(output)).digest('hex');
    sums.push(`${digest}  ${all ? `${os}-${arch}/` : ''}${filename}`);
  }
  if (!process.exitCode) {
    await writeFile(join(root, 'dist', all ? 'SHA256SUMS-all' : 'SHA256SUMS'), `${sums.join('\n')}\n`, 'utf8');
    console.log(`Built ${targets.length} native CLI executable(s). No DSH process was started.`);
  }
}
