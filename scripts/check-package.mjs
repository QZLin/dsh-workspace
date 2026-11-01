import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inject } from '../index.js';
import { resolveEndpoint } from '../src/endpoint.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(pkg.type, 'module');
assert.equal(pkg.exports['.'], './index.js');
assert.equal(pkg.exports['./icon'], './icon.svg');
assert.equal(pkg.exports['./locale/*.json'], './locale/*.json');
assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
assert.deepEqual(inject, ['workspaceRegistry']);
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0);
assert.equal(Object.keys(pkg.devDependencies ?? {}).length, 0);
assert.ok(!pkg.scripts?.preinstall && !pkg.scripts?.install && !pkg.scripts?.postinstall);
for (const path of ['index.js', 'src/endpoint.js', 'src/rpc.js', 'src/server.js', 'cordis.patch.yml', 'icon.svg', 'README.md', 'docs/protocol.md', 'LICENSE']) {
  assert.ok((await stat(join(root, path))).isFile(), `${path} is missing`);
}
for (const language of ['en', 'zh']) {
  const locale = JSON.parse(await readFile(join(root, 'locale', `${language}.json`), 'utf8'));
  assert.ok(locale.meta.title.length > 0);
  assert.ok(locale.meta.description.length > 0);
  assert.ok(!locale.meta.title.includes('My Decoration'));
}
const icon = await readFile(join(root, 'icon.svg'), 'utf8');
assert.ok(Buffer.byteLength(icon) < 256 * 1024);
assert.match(icon, /^<svg\s/);
assert.match(icon, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
assert.match(icon, /viewBox="0 0 64 64"/);
assert.match(icon, /<\/svg>\s*$/);
for (const path of ['index.js', 'src/endpoint.js', 'src/rpc.js', 'src/server.js', 'scripts/build-cli.mjs', 'scripts/check-package.mjs', 'scripts/verify-live.mjs']) {
  const result = spawnSync(process.execPath, ['--check', join(root, path)], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Syntax error in ${path}`);
}
console.log(`Package ${pkg.name}@${pkg.version}: manifest, runtime exports, localized resources and syntax OK.`);
console.log(`Current transport endpoint: ${resolveEndpoint()}`);
