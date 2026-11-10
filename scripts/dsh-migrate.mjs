import { createHash } from 'node:crypto';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const TAG_PREFIX = 'dsh-v';
const TAGS_API = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/tags';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Canonical semver only: release input also accepts the upstream dsh-v prefix. */
export function parseRelease(value) {
  if (typeof value !== 'string') throw new Error('A DSH release must be a string.');
  const version = value.startsWith(TAG_PREFIX) ? value.slice(TAG_PREFIX.length) : value;
  const match = VERSION.exec(version);
  if (!match || match[0] !== version || version.length > 256) throw new Error(`Invalid DSH release: ${value}`);
  const core = match.slice(1, 4).map(Number);
  const prerelease = match[4]?.split('.') ?? [];
  if (core.some((part) => !Number.isSafeInteger(part))
      || prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    throw new Error(`Invalid DSH release: ${value}`);
  }
  return { version, tag: `${TAG_PREFIX}${version}`, core, prerelease };
}

/** Semver precedence, including numeric prereleases; build metadata has no order. */
export function compareReleases(left, right) {
  const a = parseRelease(left);
  const b = parseRelease(right);
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] < b.core[index] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === y ? 0 : x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/** Match the bot's latest policy: newest canonical dsh-v* tag, previews included. */
export async function latestRelease({ token, fetchImpl = fetch } = {}) {
  let newest;
  for (let page = 1; page <= 50; page++) {
    const response = await fetchImpl(`${TAGS_API}?per_page=100&page=${page}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dsh-workspace-no-llm-upgrade',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub DSH tag lookup failed (HTTP ${response.status}).`);
    const tags = await response.json();
    if (!Array.isArray(tags)) throw new Error('GitHub DSH tag lookup returned an invalid response.');
    for (const tag of tags) {
      if (typeof tag?.name !== 'string' || !tag.name.startsWith(TAG_PREFIX)) continue;
      let release;
      try { release = parseRelease(tag.name); } catch { continue; }
      if (!newest || compareReleases(release.version, newest.version) > 0) newest = release;
    }
    if (tags.length < 100) {
      if (!newest) throw new Error('GitHub returned no canonical dsh-v* release tags.');
      return newest;
    }
  }
  throw new Error('DSH tag lookup exceeded 50 pages; refusing an incomplete latest-release result.');
}

/** Only update engines.dsh; never repair code, change package versions or downgrade. */
export function planUpgrade(manifest, target, { force = false } = {}) {
  if (!manifest?.dsh?.bundle || typeof manifest.name !== 'string') {
    throw new Error('The root package must declare a named DSH plugin with dsh.bundle.');
  }
  const range = manifest.engines?.dsh;
  const match = typeof range === 'string' ? /^>=([^\s]+)\s+<([^\s]+)$/.exec(range) : null;
  if (!match) throw new Error('Mechanical upgrading requires engines.dsh in the form ">=VERSION <VERSION".');
  const lower = parseRelease(match[1]);
  const upper = parseRelease(match[2]);
  const release = parseRelease(target);
  if (compareReleases(lower.version, upper.version) >= 0) throw new Error('engines.dsh has an invalid compatibility interval.');
  const order = compareReleases(release.version, lower.version);
  if (order < 0) throw new Error(`Refusing to downgrade DSH from ${lower.version} to ${release.version}.`);
  const changed = order > 0;
  const candidate = structuredClone(manifest);
  let nextUpper = upper.version;
  if (compareReleases(release.version, upper.version) >= 0) {
    const [major, minor] = release.core;
    // DSH 0.x may break at each minor; stable major versions use the next major.
    if (major === 0 && minor === Number.MAX_SAFE_INTEGER || major === Number.MAX_SAFE_INTEGER) {
      throw new Error('The target version exceeds the supported compatibility interval.');
    }
    nextUpper = major === 0 ? `0.${minor + 1}.0` : `${major + 1}.0.0`;
  }
  if (changed) candidate.engines.dsh = `>=${release.version} <${nextUpper}`;
  return { release, changed, shouldCheck: changed || force, previousRange: range, manifest: candidate };
}

export async function prepareUpgrade({ workdir = process.cwd(), target = 'latest', force = false,
  dryRun = false, token, fetchImpl, outputPath, summaryPath } = {}) {
  const manifestPath = resolve(workdir, 'package.json');
  const original = await readFile(manifestPath, 'utf8');
  const release = target === 'latest' ? await latestRelease({ token, fetchImpl }) : parseRelease(target);
  const plan = planUpgrade(JSON.parse(original), release.version, { force });
  const candidate = plan.changed ? `${JSON.stringify(plan.manifest, null, 2)}\n` : original;
  if (plan.changed && !dryRun) await writeFile(manifestPath, candidate, 'utf8');
  const outputs = {
    target_tag: plan.release.tag,
    target_version: plan.release.version,
    changed: String(plan.changed),
    should_check: String(plan.shouldCheck),
    manifest_sha: createHash('sha256').update(candidate).digest('hex'),
  };
  if (outputPath) await appendFile(outputPath, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''), 'utf8');
  if (summaryPath) await appendFile(summaryPath, [
    '## DSH mechanical upgrade (no LLM)', '',
    `- Target: \`${plan.release.tag}\` (latest includes prereleases).`,
    `- Compatibility: \`${plan.previousRange}\` → \`${plan.manifest.engines.dsh}\`.`,
    `- ${plan.shouldCheck ? 'Checks are required before publishing; failures stop the workflow.' : 'Already at this release; no work is needed.'}`,
    '- Only a verified manifest may be committed; no agent sessions or code repairs run.', '',
  ].join('\n'), 'utf8');
  return { ...plan, outputs };
}

async function main() {
  const { values } = parseArgs({ options: {
    target: { type: 'string' }, workdir: { type: 'string' },
    force: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
  } });
  const envForce = process.env.DSH_MIGRATE_FORCE ?? 'false';
  if (!['true', 'false'].includes(envForce)) throw new Error('DSH_MIGRATE_FORCE must be true or false.');
  const plan = await prepareUpgrade({
    workdir: values.workdir, target: values.target ?? (process.env.DSH_MIGRATE_TARGET?.trim() || 'latest'),
    force: values.force ?? envForce === 'true', dryRun: values['dry-run'] ?? false,
    token: process.env.GITHUB_TOKEN, outputPath: process.env.GITHUB_OUTPUT, summaryPath: process.env.GITHUB_STEP_SUMMARY,
  });
  console.log(`DSH ${plan.release.version}: ${plan.previousRange} -> ${plan.manifest.engines.dsh}; ${plan.shouldCheck ? 'verification required' : 'already current'}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
