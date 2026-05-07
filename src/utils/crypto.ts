import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const PBKDF2_ITERATIONS = 600_000;
const SALT_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PREFIX = 'encrypted::v1:';

/**
 * Check whether a string value is an encrypted Reverie value.
 */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Encrypt a plaintext string using AES-256-GCM with a password-derived key.
 * Returns a prefixed base64 string: `encrypted::v1:<base64(salt+iv+authTag+ciphertext)>`
 */
export function encryptValue(plaintext: string, password: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const payload = Buffer.concat([salt, iv, authTag, encrypted]);
  return PREFIX + payload.toString('base64');
}

/**
 * Decrypt an encrypted Reverie value using a password.
 * Throws on wrong password or corrupted data.
 */
export function decryptValue(encrypted: string, password: string): string {
  if (!isEncrypted(encrypted)) {
    throw new Error('Value is not encrypted.');
  }

  const payload = Buffer.from(encrypted.slice(PREFIX.length), 'base64');

  const minLength = SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH;
  if (payload.length < minLength) {
    throw new Error('Corrupted encrypted data.');
  }

  const salt = payload.subarray(0, SALT_LENGTH);
  const iv = payload.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = payload.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    throw new Error('Decryption failed. Wrong password or corrupted data.');
  }
}

/**
 * Replace encrypted leaf values with '[encrypted]' for safe display/export.
 */
export function maskEncryptedValues(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && isEncrypted(value)) {
      result[key] = '[encrypted]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      result[key] = maskEncryptedValues(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}
