import { getEntriesFlat } from '../storage';
import { setNestedValue } from '../utils/objectPath';
import { formatKeyValue, displayTree, highlightMatch } from '../formatting';
import { color } from '../formatting';
import { loadAliases, buildKeyToAliasMap } from '../alias';
import { SearchOptions } from '../types';
import { isEncrypted } from '../utils/crypto';
import { debug } from '../utils/debug';
import { interpolate } from '../utils/interpolate';
import { isJsonMode, setResult, failJson } from '../utils/output';

type MatchFn = (text: string) => boolean;

const MAX_REGEX_LENGTH = 500;

function buildMatcher(searchTerm: string, useRegex: boolean): MatchFn {
  if (useRegex) {
    if (searchTerm.length > MAX_REGEX_LENGTH) {
      throw new Error(`Regex pattern too long (max ${MAX_REGEX_LENGTH} characters)`);
    }
    let re: RegExp;
    try {
      re = new RegExp(searchTerm, 'i');
    } catch (err) {
      // Re-throw with a clearer message so callers can handle and report it
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to compile regex pattern: ${message}`);
    }
    return (text: string) => re.test(text);
  }
  const lc = searchTerm.toLowerCase();
  return (text: string) => text.toLowerCase().includes(lc);
}

function searchDataEntries(flattenedData: Record<string, string>, match: MatchFn, keysOnly?: boolean, valuesOnly?: boolean): Record<string, string> {
  const matches: Record<string, string> = {};
  for (const [key, value] of Object.entries(flattenedData)) {
    const encrypted = isEncrypted(value);
    let resolved = value;
    if (!encrypted) {
      try { resolved = interpolate(value); } catch { /* use raw */ }
    }
    const keyMatches = !valuesOnly && match(key);
    const valueMatches = !keysOnly && !encrypted && match(resolved);

    if (keyMatches || valueMatches) {
      matches[key] = encrypted ? '[encrypted]' : resolved;
    }
  }
  return matches;
}

function searchAliasEntries(aliases: Record<string, string>, match: MatchFn): Record<string, string> {
  const matches: Record<string, string> = {};
  for (const [aliasName, targetPath] of Object.entries(aliases)) {
    if (match(aliasName) || match(targetPath)) {
      matches[aliasName] = targetPath;
    }
  }
  return matches;
}

function displaySearchResults(
  dataMatches: Record<string, string>,
  aliasMatches: Record<string, string>,
  aliases: Record<string, string>,
  options: SearchOptions,
  searchTerm: string
): void {
  const dataMatchKeys = Object.keys(dataMatches);
  const aliasMatchKeys = Object.keys(aliasMatches);
  const hasDataMatches = dataMatchKeys.length > 0;
  const hasAliasMatches = aliasMatchKeys.length > 0;

  if (hasDataMatches) {
    console.log(`\nEntries (${dataMatchKeys.length}):`);

    if (options.tree) {
      const matchesObj = {};
      dataMatchKeys.forEach(key => {
        setNestedValue(matchesObj, key, dataMatches[key]);
      });
      displayTree(matchesObj, buildKeyToAliasMap(aliases), '', '', false, searchTerm);
    } else {
      Object.entries(dataMatches).forEach(([key, value]) => {
        formatKeyValue(key, value, searchTerm);
      });
    }
  }

  if (hasAliasMatches) {
    console.log(`\nAliases (${aliasMatchKeys.length}):`);

    Object.entries(aliasMatches).forEach(([aliasName, targetPath]) => {
      const highlightedName = highlightMatch(aliasName, searchTerm);
      const highlightedPath = highlightMatch(targetPath, searchTerm);
      console.log(`${color.cyan(highlightedName)} ${color.gray('->')} ${color.yellow(highlightedPath)}`);
    });
  }
}

export function searchEntries(searchTerm: string, options: SearchOptions = {}): { dataCount: number; aliasCount: number } {
  debug('searchEntries called', { searchTerm, options });

  const json = isJsonMode();

  if (options.keys && options.values) {
    if (json) failJson('INVALID_INPUT', '--keys and --values are mutually exclusive.');
    else { console.error('Error: --keys and --values are mutually exclusive.'); process.exitCode = 1; }
    return { dataCount: 0, aliasCount: 0 };
  }

  const scope = options.global ? 'global' as const : undefined;
  const flattenedData = options.aliases ? {} : getEntriesFlat(scope);

  if (Object.keys(flattenedData).length === 0 && !options.aliases && !json) {
    console.log('No entries to search in.');
    return { dataCount: 0, aliasCount: 0 };
  }

  let match: MatchFn;
  try {
    match = buildMatcher(searchTerm, !!options.regex);
  } catch (err) {
    const msg = `Invalid regex: ${err instanceof Error ? err.message : String(err)}`;
    if (json) failJson('INVALID_INPUT', msg);
    else { console.error(msg); process.exitCode = 1; }
    return { dataCount: 0, aliasCount: 0 };
  }

  const aliases = loadAliases(scope);
  const dataMatches = options.aliases ? {} : searchDataEntries(flattenedData, match, options.keys, options.values);
  const aliasMatches = options.entries ? {} : searchAliasEntries(aliases, match);

  const dataCount = Object.keys(dataMatches).length;
  const aliasCount = Object.keys(aliasMatches).length;
  const totalMatches = dataCount + aliasCount;

  if (json) {
    const result: { entries?: Record<string, string>, aliases?: Record<string, string> } = {};
    if (!options.aliases) result.entries = dataMatches;
    if (!options.entries) result.aliases = aliasMatches;
    setResult(result);
    return { dataCount, aliasCount };
  }

  if (totalMatches === 0) {
    console.log(`No matches found for '${searchTerm}'.`);
    return { dataCount, aliasCount };
  }

  console.log(`Found ${totalMatches} matches for '${searchTerm}':`);
  displaySearchResults(dataMatches, aliasMatches, aliases, options, searchTerm);
  return { dataCount, aliasCount };
}
