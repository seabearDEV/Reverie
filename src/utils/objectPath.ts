import { CodexData, CodexValue } from '../types';

function isSafeKey(key: string): boolean {
  // Empty parts come from leading/trailing/double dots in user keys; treat
  // them as unsafe so the in-memory layer matches the file-system layer's
  // isValidEntryKey rejection.
  if (!key) return false;
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype';
}

/**
 * Sets a value at a nested path using dot notation (e.g., 'user.settings.theme')
 */
export function setNestedValue(obj: CodexData, path: string, value: string): void {
  const keys = path.split('.');
  let current = obj;

  // Navigate to the innermost object
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!isSafeKey(key)) {
      // Prevent prototype pollution via special property names
      return;
    }
    if (!current[key] || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key] as CodexData;
  }

  const lastKey = keys[keys.length - 1];
  if (!isSafeKey(lastKey)) {
    // Prevent prototype pollution at the final assignment
    return;
  }
  // Set the value at the innermost level
  current[lastKey] = value;
}

/**
 * Gets a value from a nested path using dot notation.
 *
 * Uses Object.hasOwn for every property hop so prototype-chain names like
 * `__proto__`, `constructor`, `hasOwnProperty`, `toString`, etc. don't leak
 * inherited properties from Object.prototype.
 *
 * Pre-fix, reverie_get __proto__ rendered Object.prototype as an empty subtree,
 * reverie_get constructor returned the source of the Object constructor, and
 * reverie_copy / reverie_rename's existence checks always reported "already exists"
 * for any prototype-chain name.
 */
export function getNestedValue(obj: CodexData, path: string): CodexValue | undefined {
  if (!path) return undefined;
  const keys = path.split('.');
  if (!Object.hasOwn(obj, keys[0])) return undefined;
  let current: CodexValue | undefined = obj[keys[0]];
  for (let i = 1; i < keys.length; i++) {
    if (current === undefined || typeof current === 'string') return undefined;
    if (!Object.hasOwn(current, keys[i])) return undefined;
    current = current[keys[i]];
  }
  return current;
}

/**
 * Removes a value at a nested path and cleans up empty parent objects
 */
export function removeNestedValue(obj: CodexData, path: string): boolean {
  const keys = path.split('.');
  
  if (keys.length === 1) {
    // Simple case - top-level key
    if (obj[keys[0]] === undefined) return false;
    delete obj[keys[0]];
    return true;
  }
  
  // For nested paths
  const stack: {obj: CodexData, key: string}[] = [];
  let current = obj;
  
  // Navigate to the parent of the target
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!current[key] || typeof current[key] !== 'object') {
      return false; // Path doesn't exist
    }
    stack.push({ obj: current, key });
    current = current[key] as CodexData;
  }
  
  // Delete the value
  const lastKey = keys[keys.length - 1];
  if (current[lastKey] === undefined) {
    return false; // Key doesn't exist
  }
  
  delete current[lastKey];
  
  // Clean up empty objects
  for (let i = stack.length - 1; i >= 0; i--) {
    const { obj, key } = stack[i];
    if (Object.keys(obj[key]).length === 0) {
      delete obj[key];
    } else {
      break; // Stop if object is not empty
    }
  }
  
  return true;
}

/**
 * Expands flat dot-notation keys into nested objects.
 * Keys that contain dots (e.g. {"a.b": "val"}) are expanded to {a: {b: "val"}}.
 * Keys without dots are left as-is. Uses deepMerge to combine expanded keys.
 */
export function expandFlatKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const hasFlatKeys = Object.keys(obj).some(k => k.includes('.') && typeof obj[k] !== 'object');
  if (!hasFlatKeys) return obj;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key.includes('.') || (typeof value === 'object' && value !== null)) {
      // Normal nested key or already an object — keep as-is
      if (key in result && typeof result[key] === 'object' && typeof value === 'object' && value !== null) {
        result[key] = mergeObjects(result[key] as Record<string, unknown>, value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    } else {
      // Flat dot-notation key with scalar value — expand
      const parts = key.split('.');
      let current = result;
      for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i];
        if (!isSafeKey(part)) break;
        if (!current[part] || typeof current[part] !== 'object') {
          current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
      }
      const lastPart = parts[parts.length - 1];
      if (isSafeKey(lastPart)) {
        current[lastPart] = value;
      }
    }
  }
  return result;
}

function mergeObjects(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    if (!isSafeKey(key)) continue;
    if (typeof source[key] === 'object' && source[key] !== null && typeof output[key] === 'object' && output[key] !== null) {
      output[key] = mergeObjects(output[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      output[key] = source[key];
    }
  }
  return output;
}

/**
 * Flattens nested objects into a flat map with dot-notation keys
 * Example: { user: { name: "John" } } → { "user.name": "John" }
 */
export function flattenObject(obj: Record<string, unknown>, parentKey = '', maxDepth?: number, currentDepth = 1): Record<string, string> {
  return Object.keys(obj).reduce((acc, key) => {
    const newKey = parentKey ? `${parentKey}.${key}` : key;

    if (typeof obj[key] === 'object' && obj[key] !== null) {
      if (maxDepth !== undefined && currentDepth >= maxDepth) {
        acc[newKey] = '';
      } else {
        Object.assign(acc, flattenObject(obj[key] as Record<string, unknown>, newKey, maxDepth, currentDepth + 1));
      }
    } else {
      acc[newKey] = String(obj[key]);
    }

    return acc;
  }, {} as Record<string, string>);
}

