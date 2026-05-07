/**
 * Type definitions for Reverie
 */

export interface GetOptions {
  tree?: boolean | undefined;
  plain?: boolean | undefined;
  source?: boolean | undefined;
  decrypt?: boolean | undefined;
  copy?: boolean | undefined;
  aliases?: boolean | undefined;
  json?: boolean | undefined;
  values?: boolean | undefined;
  depth?: number | undefined;
  global?: boolean | undefined;
  all?: boolean | undefined;
  passwordFile?: string | undefined;
}

export interface SearchOptions {
  entries?: boolean | undefined;
  aliases?: boolean | undefined;
  tree?: boolean | undefined;
  json?: boolean | undefined;
  regex?: boolean | undefined;
  keys?: boolean | undefined;
  values?: boolean | undefined;
  global?: boolean | undefined;
}

export interface ExportOptions {
  output?: string;
  pretty?: boolean;
  global?: boolean | undefined;
  project?: boolean | undefined;
  includeEncrypted?: boolean;
  split?: boolean;
}

export interface ImportOptions {
  merge?: boolean;
  force?: boolean;
  preview?: boolean;
  global?: boolean | undefined;
  project?: boolean | undefined;
}

export interface ResetOptions {
  force?: boolean;
  global?: boolean | undefined;
  project?: boolean | undefined;
}

/**
 * Data structure supporting nested hierarchical data with dot notation
 * Example: { server: { production: { ip: "192.168.1.100" } } }
 */
export type CodexValue = string | { [key: string]: CodexValue };
export type CodexData = Record<string, CodexValue>;