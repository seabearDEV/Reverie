// Unit tests for the #117 WS1 structured-output module.

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ENVELOPE_VERSION,
  ERROR_CODES,
  configureOutput,
  resetOutput,
  isJsonMode,
  resolveJsonMode,
  setResult,
  addWarning,
  addWarnings,
  failJson,
  hasError,
  buildEnvelope,
  emitEnvelope,
  alreadyEmitted,
} from '../utils/output';

describe('output envelope (#117 WS1)', () => {
  beforeEach(() => {
    resetOutput();
    process.exitCode = 0;
  });

  it('defaults to human mode until configured', () => {
    expect(isJsonMode()).toBe(false);
  });

  it('resolveJsonMode honors the flag and RVR_OUTPUT env', () => {
    const orig = process.env.RVR_OUTPUT;
    try {
      delete process.env.RVR_OUTPUT;
      expect(resolveJsonMode(undefined)).toBe(false);
      expect(resolveJsonMode(true)).toBe(true);
      process.env.RVR_OUTPUT = 'json';
      expect(resolveJsonMode(undefined)).toBe(true);
      process.env.RVR_OUTPUT = 'text';
      expect(resolveJsonMode(undefined)).toBe(false);
    } finally {
      if (orig === undefined) delete process.env.RVR_OUTPUT;
      else process.env.RVR_OUTPUT = orig;
    }
  });

  it('builds a success envelope with result and version', () => {
    configureOutput({ json: true, command: 'get' });
    setResult({ 'a.b': 'c' });
    const env = buildEnvelope();
    expect(env.reverie).toBe(ENVELOPE_VERSION);
    expect(env.reverie).toBe('1');
    expect(env.ok).toBe(true);
    expect(env.command).toBe('get');
    expect(env.result).toEqual({ 'a.b': 'c' });
    expect(env.error).toBeUndefined();
    expect(env.warnings).toBeUndefined();
  });

  it('omits result when none was set', () => {
    configureOutput({ json: true, command: 'set' });
    const env = buildEnvelope();
    expect('result' in env).toBe(false);
    expect(env.ok).toBe(true);
  });

  it('records a structured error and flips ok + exitCode', () => {
    configureOutput({ json: true, command: 'get' });
    failJson('NOT_FOUND', "Entry 'x' not found");
    expect(hasError()).toBe(true);
    expect(process.exitCode).toBe(1);
    const env = buildEnvelope();
    expect(env.ok).toBe(false);
    expect(env.error).toEqual({ code: 'NOT_FOUND', message: "Entry 'x' not found" });
  });

  it('carries a preview on the error when provided', () => {
    configureOutput({ json: true, command: 'run' });
    failJson('REQUIRES_CONFIRMATION', 'needs --yes', 'rm -rf /tmp/x');
    expect(buildEnvelope().error).toEqual({
      code: 'REQUIRES_CONFIRMATION', message: 'needs --yes', preview: 'rm -rf /tmp/x',
    });
  });

  it('synthesizes an error when exitCode is set without failJson', () => {
    configureOutput({ json: true, command: 'run' });
    process.exitCode = 2;
    const env = buildEnvelope();
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('RUNTIME');
  });

  it('collects warnings as {code,message} objects', () => {
    configureOutput({ json: true, command: 'context' });
    addWarning('[trimmed: files.*]', 'TRIMMED');
    addWarnings(['w2', 'w3']);
    addWarning('');
    const env = buildEnvelope();
    expect(env.warnings).toEqual([
      { code: 'TRIMMED', message: '[trimmed: files.*]' },
      { code: 'WARNING', message: 'w2' },
      { code: 'WARNING', message: 'w3' },
    ]);
  });

  it('emitEnvelope writes exactly one envelope and is idempotent', () => {
    configureOutput({ json: true, command: 'get' });
    setResult({ ok: 1 });
    const lines: string[] = [];
    const write = (s: string): void => { lines.push(s); };
    emitEnvelope(write);
    expect(alreadyEmitted()).toBe(true);
    emitEnvelope(write); // second call is a no-op
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.command).toBe('get');
    expect(parsed.result).toEqual({ ok: 1 });
  });

  it('error codes are a frozen set that reuses MCP names (no E_ prefix)', () => {
    // Parity with the MCP server's existing PROJECT_UNRESOLVED code (#117).
    expect(ERROR_CODES).toContain('PROJECT_UNRESOLVED');
    expect(ERROR_CODES).toContain('NOT_FOUND');
    expect(ERROR_CODES).toContain('REQUIRES_CONFIRMATION');
    expect(ERROR_CODES).toContain('RUNTIME');
    expect(ERROR_CODES.some(c => c.startsWith('E_'))).toBe(false);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('resetOutput clears state between invocations', () => {
    configureOutput({ json: true, command: 'set' });
    setResult({ x: 1 });
    failJson('IO', 'boom');
    resetOutput();
    expect(isJsonMode()).toBe(false);
    expect(hasError()).toBe(false);
    const env = buildEnvelope();
    expect('result' in env).toBe(false);
  });
});
