import { getEntriesFlat, Scope } from '../storage';
import { color } from '../formatting';
import { findProjectFile } from '../store';
import { interpolate } from '../utils/interpolate';
import { isJsonMode, setResult } from '../utils/output';
import fs from 'fs';
import path from 'path';

const DEFAULT_NAMESPACES = ['project', 'commands', 'arch', 'conventions', 'context', 'files', 'deps', 'system'];

// ── Seed-quality heuristics (#82) ────────────────────────────────────
//
// Codex entries are seeds, not knowledge stores — they select dense regions
// of the LLM's pretrained terrain rather than storing the terrain itself.
// (See conventions.seedDensity for the principle.) These heuristics flag
// entries that are likely low-amplification — restatements of common
// knowledge the LLM would generate by default, with no project-specific
// terms to anchor a denser response.
//
// Soft checks: output is "Consider rewriting" warnings, not errors. Some
// entries (literal commands, version pins) are necessarily low-amplification
// and that's fine. Treat the principle as a lens, not a rule.

/** Entries under these namespaces are exempt — they hold literal commands,
 *  version pins, ephemeral state, or project metadata that are necessarily
 *  short and declarative. */
const SEED_QUALITY_EXEMPT_PREFIXES = ['commands.', 'deps.', 'session.', 'project.'];

/** Specific keys that are exempt as a case-by-case carve-out.
 *  - context.next_session: ephemeral handoff state (see seedDensity carve-out).
 *  - conventions.seedDensity: the principle entry itself; it cites low-amp
 *    patterns as examples of what NOT to do, so the lint would trip on the
 *    entry that documents the lint's rationale. */
const SEED_QUALITY_EXEMPT_KEYS = new Set([
  'context.next_session',
  'conventions.seedDensity',
]);

/** A sampling of low-amplification phrases — entries matching any of these
 *  restate terrain the LLM would generate by default. Pattern list is kept
 *  deliberately small: false negatives are cheaper than false positives for
 *  a soft-check lint. Add a new pattern when you see the same sentence shape
 *  appearing in entries that prompted the lint. */
const LOW_AMP_PATTERNS: RegExp[] = [
  /\bnpm\s+(test|run\s+\w+|install)\s+runs?\b/i,
  /\bpackage\.json\s+contains?\b/i,
  /\b(runs?|handles?|manages?)\s+the\s+tests?\b/i,
  /\bmain\s+(entry|file)\s+(point|for)\b/i,
];

/** A value shows "project-specific signal" when it contains at least one
 *  of these markers — a file path with an extension, an identifier that
 *  looks like code (camelCase or snake_case with underscores), or backticks
 *  that typically wrap a command/filename. */
function hasProjectSpecificSignal(value: string): boolean {
  // File path with extension: `src/foo.ts`, `dist/index.js`, `.github/workflows/*.yml`
  if (/\b[\w.\-/]+\.[a-z]{1,6}\b/.test(value)) return true;
  // Backticks wrapping code/command
  if (/`[^`\n]+`/.test(value)) return true;
  // camelCase / PascalCase identifiers (2+ uppercase transitions — filters out acronyms)
  if (/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]+\b/.test(value)) return true;
  // snake_case or CONSTANT_CASE identifiers
  if (/\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9]+\b/.test(value)) return true;
  // Dot-notation reference (e.g. `arch.audit`, `commands.build`) — references
  // to other entries count as project-specific signal
  if (/\b[a-z][a-z0-9]*\.[a-z][a-z0-9]+/i.test(value)) return true;
  return false;
}

export type SeedIssueCode = 'too-short' | 'low-amp-phrase' | 'interp-landmine';

export interface SeedIssue {
  key: string;
  code: SeedIssueCode;
  message: string;
}

export function checkSeedQuality(flat: Record<string, string>): SeedIssue[] {
  const issues: SeedIssue[] = [];

  for (const [key, value] of Object.entries(flat)) {
    if (typeof value !== 'string') continue;
    if (SEED_QUALITY_EXEMPT_KEYS.has(key)) continue;
    if (SEED_QUALITY_EXEMPT_PREFIXES.some(p => key.startsWith(p))) continue;

    // Heuristic 1: short and no project-specific signal.
    // 60 chars is the rough length below which a sentence is typically
    // generic prose. Tuned to flag "runs the tests" type entries without
    // tripping on taut-but-specific entries like "ScopedStore in store.ts".
    if (value.length < 60 && !hasProjectSpecificSignal(value)) {
      issues.push({
        key,
        code: 'too-short',
        message: 'Short entry with no project-specific signal (paths, identifiers, references). Likely low-amplification.',
      });
      continue;
    }

    // Heuristic 2: matches a known low-amplification phrase.
    for (const pattern of LOW_AMP_PATTERNS) {
      if (pattern.test(value)) {
        issues.push({
          key,
          code: 'low-amp-phrase',
          message: `Matches low-amplification phrase pattern (${pattern.source}). Consider rewriting with project-specific anchoring.`,
        });
        break;
      }
    }

    // Heuristic 3: interpolation landmine (#39 follow-up).
    // An unescaped \${key} or \$(key) that fails to resolve IS a bug —
    // anyone trying to resolve the value later gets an interpolation error.
    try {
      interpolate(value);
    } catch (err) {
      issues.push({
        key,
        code: 'interp-landmine',
        message: `Interpolation would fail: ${err instanceof Error ? err.message : String(err)}. Backslash-escape the syntax or rewrite in prose.`,
      });
    }
  }

  return issues;
}

function loadCustomSchema(): string[] | null {
  const projectFile = findProjectFile();
  if (!projectFile) return null;
  try {
    // In v1.10.0+, findProjectFile() returns a directory path when the new layout
    // is in use (.reverie/ directory). Detect this by basename — the directory
    // has no extension, while the legacy `.codexcli.json` file ends in .json.
    // The _schema feature is not implemented for the directory layout yet.
    if (path.basename(projectFile) === '.reverie') return null;
    const raw = JSON.parse(fs.readFileSync(projectFile, 'utf8')) as Record<string, unknown>;
    const schema = raw._schema as { namespaces?: string[] } | undefined;
    return schema?.namespaces ?? null;
  } catch {
    return null;
  }
}

export interface LintResult {
  key: string;
  namespace: string;
  message: string;
}

export function lintEntries(options: { json?: boolean; global?: boolean; seedQuality?: boolean } = {}): void {
  const scope: Scope | undefined = options.global ? 'global' : undefined;
  const flat = getEntriesFlat(scope);

  const customNamespaces = loadCustomSchema();
  const allowedNamespaces = customNamespaces
    ? [...new Set([...DEFAULT_NAMESPACES, ...customNamespaces])]
    : DEFAULT_NAMESPACES;

  const namespaceIssues: LintResult[] = [];

  for (const key of Object.keys(flat)) {
    const ns = key.split('.')[0];
    if (!allowedNamespaces.includes(ns)) {
      namespaceIssues.push({
        key,
        namespace: ns,
        message: `Namespace '${ns}' is not in the recommended schema`,
      });
    }
  }

  const seedIssues = options.seedQuality ? checkSeedQuality(flat) : [];

  if (isJsonMode()) {
    const payload: Record<string, unknown> = {
      issues: namespaceIssues,
      allowed: allowedNamespaces,
    };
    if (options.seedQuality) payload.seedQuality = seedIssues;
    setResult(payload);
    return;
  }

  // Namespace section
  if (namespaceIssues.length === 0) {
    console.log(color.green('No schema issues found.'));
    console.log(color.gray(`Allowed namespaces: ${allowedNamespaces.join(', ')}`));
  } else {
    // Group by namespace
    const byNamespace = new Map<string, string[]>();
    for (const { key, namespace } of namespaceIssues) {
      if (!byNamespace.has(namespace)) byNamespace.set(namespace, []);
      byNamespace.get(namespace)!.push(key);
    }

    console.log(color.bold(`\n${namespaceIssues.length} entries outside recommended namespaces:\n`));
    for (const [ns, keys] of byNamespace) {
      console.log(`  ${color.yellow(ns)} (${keys.length} entries)`);
      for (const key of keys) {
        console.log(`    ${color.gray(key)}`);
      }
    }
    console.log(color.gray(`\nAllowed namespaces: ${allowedNamespaces.join(', ')}`));
    console.log(color.gray('Add custom namespaces via _schema.namespaces in the legacy .codexcli.json (directory-format stores do not yet support custom namespaces)'));
    console.log('');
  }

  // Seed-quality section
  if (!options.seedQuality) return;

  if (seedIssues.length === 0) {
    console.log(color.green('\nNo seed-quality warnings.'));
    console.log(color.gray('Each entry carries project-specific signal; no low-amplification candidates flagged.'));
    return;
  }

  // Group by code for a scannable summary
  const byCode = new Map<SeedIssueCode, SeedIssue[]>();
  for (const issue of seedIssues) {
    if (!byCode.has(issue.code)) byCode.set(issue.code, []);
    byCode.get(issue.code)!.push(issue);
  }

  console.log(color.bold(`\n${seedIssues.length} seed-quality warnings (consider rewriting):\n`));
  const codeLabels: Record<SeedIssueCode, string> = {
    'too-short': 'Short + no project-specific signal',
    'low-amp-phrase': 'Matches low-amplification phrase pattern',
    'interp-landmine': 'Interpolation landmine (would error on resolve)',
  };
  for (const [code, entries] of byCode) {
    console.log(`  ${color.yellow(codeLabels[code])} (${entries.length})`);
    for (const issue of entries) {
      console.log(`    ${color.cyan(issue.key)}`);
      console.log(`      ${color.gray(issue.message)}`);
    }
  }
  console.log(color.gray('\nSee conventions.seedDensity for the principle. Warnings are soft — some'));
  console.log(color.gray('entries are necessarily low-amplification and that\'s fine.'));
  console.log('');
}
