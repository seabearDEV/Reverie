import fs from 'fs';
import path from 'path';

const cache = new Map<string, string>();

/**
 * Canonical project identity (#141). Path strings fragment across parent-dir
 * renames and case variants — the same repo appeared as three distinct
 * "projects" in projectBreakdown — and never match across machines. The git
 * origin URL survives all of that, so it is the primary identity; projects
 * without git (or without an origin remote) fall back to the directory path.
 * Rows keep the raw `project` path for filtering — projectId is the grouping
 * key. Historical rows have no projectId and group by path, as written.
 *
 * Reads .git/config directly instead of spawning git: this runs on every
 * logged call. Worktrees/submodules (.git as a file) fall back to the path —
 * chasing gitdir indirection isn't worth the I/O for identity purposes.
 */
export function getProjectId(projectDir: string): string {
  const cached = cache.get(projectDir);
  if (cached !== undefined) return cached;
  const id = deriveProjectId(projectDir);
  cache.set(projectDir, id);
  return id;
}

/** Reset the per-process cache. Used by tests that rebuild temp repos. */
export function clearProjectIdCache(): void {
  cache.clear();
}

function deriveProjectId(projectDir: string): string {
  try {
    const config = fs.readFileSync(path.join(projectDir, '.git', 'config'), 'utf8');
    const url = parseOriginUrl(config);
    if (url) return normalizeGitUrl(url);
  } catch { /* not a git repo — fall through to the path */ }
  return projectDir;
}

/** Extract the [remote "origin"] url from .git/config INI text. */
export function parseOriginUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inOrigin = line === '[remote "origin"]';
      continue;
    }
    if (inOrigin && line.startsWith('url')) {
      const eq = line.indexOf('=');
      if (eq !== -1) return line.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/**
 * Normalize a git remote URL to host/owner/repo. Handles scp-style
 * (git@github.com:owner/repo.git), ssh://, and https:// forms. Lowercased —
 * GitHub treats owner/repo case-insensitively, and case variants are exactly
 * the fragmentation this exists to remove.
 */
export function normalizeGitUrl(url: string): string {
  let u = url.trim();
  const hadProtocol = /^[a-z+]+:\/\//i.test(u);
  u = u.replace(/^[a-z+]+:\/\//i, ''); // protocol
  u = u.replace(/^[^@/]+@/, '');       // user@
  if (hadProtocol) {
    // ssh://host:22/path — a port is not identity; the same repo cloned
    // with and without one must not fragment.
    u = u.replace(/^([^/:]+):\d+(?=\/)/, '$1');
  } else {
    u = u.replace(':', '/');           // scp-style host:path separator
  }
  u = u.replace(/\.git$/i, '');
  u = u.replace(/\/+$/, '');
  return u.toLowerCase();
}
