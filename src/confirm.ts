import { debug } from './utils/debug';
import { Scope, loadConfirmMap, saveConfirmMap, loadConfirmMapMerged } from './store';
import { resolveScopeForWrite } from './projectResolution';


export function loadConfirmKeys(scope?: Scope  ): Record<string, true> {
  if (!scope || scope === 'auto') {
    return loadConfirmMapMerged();
  }
  return loadConfirmMap(scope);
}

export function saveConfirmKeys(data: Record<string, true>, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  saveConfirmMap(data, effectiveScope);
}

// Mark a key as requiring confirmation
export function setConfirm(key: string, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  const keys = loadConfirmMap(effectiveScope);
  keys[key] = true;
  saveConfirmMap(keys, effectiveScope);
  debug(`Confirm set for key: "${key}"`);
}

// Remove confirmation requirement from a key
export function removeConfirm(key: string, scope?: Scope  ): void {
  // Auto collapses to 'project' when resolution succeeds, throws when it
  // fails (#99). The pre-#99 project-then-global fallthrough is dropped for
  // consistency with set/remove on entries and aliases.
  const effectiveScope = resolveScopeForWrite(scope);
  const keys = loadConfirmMap(effectiveScope);
  if (key in keys) {
    delete keys[key];
    saveConfirmMap(keys, effectiveScope);
    debug(`Confirm removed for key: "${key}" (${effectiveScope})`);
  }
}

// Check if a key requires confirmation (checks merged)
export function hasConfirm(key: string): boolean {
  const keys = loadConfirmMapMerged();
  return keys[key] === true;
}

// Cascade delete: remove key and any children (e.g., removing "commands" removes "commands.deploy")
export function removeConfirmForKey(key: string, scope?: Scope  ): void {
  const effectiveScope = resolveScopeForWrite(scope);
  removeConfirmFromScope(key, effectiveScope);
}

function removeConfirmFromScope(key: string, scope: 'project' | 'global'): void {
  const keys = loadConfirmMap(scope);
  const prefix = key + '.';
  let changed = false;
  for (const k of Object.keys(keys)) {
    if (k === key || k.startsWith(prefix)) {
      delete keys[k];
      changed = true;
    }
  }
  if (changed) {
    saveConfirmMap(keys, scope);
  }
}
