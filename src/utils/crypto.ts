import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

/**
 * Cached derived keys by version — supports key rotation.
 * Format: { version: derivedKeyBuffer }
 */
const keyCache = new Map<number, Buffer>();
let currentKeyVersion = 1;

function deriveKey(rawKey: string): Buffer {
  return crypto.scryptSync(rawKey, 'formbuddy-salt-v1', 32);
}

function getCurrentKey(): { key: Buffer; version: number } {
  const rawKey = process.env.ENCRYPTION_KEY;
  if (!rawKey || rawKey.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  }

  // Check for rotated key
  const rotatedKey = process.env.ENCRYPTION_KEY_NEXT;
  if (rotatedKey && rotatedKey.length >= 32) {
    currentKeyVersion = 2;
    if (!keyCache.has(2)) {
      keyCache.set(2, deriveKey(rotatedKey));
    }
    // Keep old key for decryption
    if (!keyCache.has(1)) {
      keyCache.set(1, deriveKey(rawKey));
    }
    return { key: keyCache.get(2)!, version: 2 };
  }

  if (!keyCache.has(1)) {
    keyCache.set(1, deriveKey(rawKey));
  }
  return { key: keyCache.get(1)!, version: 1 };
}

function getKeyByVersion(version: number): Buffer {
  const cached = keyCache.get(version);
  if (cached) return cached;

  // Fallback: derive from current key (version 1)
  const rawKey = process.env.ENCRYPTION_KEY;
  if (!rawKey) throw new Error('ENCRYPTION_KEY is required');
  const derived = deriveKey(rawKey);
  keyCache.set(version, derived);
  return derived;
}

/**
 * Encrypt a plaintext value. Output format: `v{version}:{iv}:{tag}:{ciphertext}`
 * Version prefix enables seamless key rotation.
 */
export function encrypt(plaintext: string): string {
  const { key, version } = getCurrentKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  return `v${version}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt a ciphertext value. Supports both versioned and legacy formats.
 */
export function decrypt(ciphertext: string): string {
  let version: number;
  let ivHex: string;
  let tagHex: string;
  let encrypted: string;

  if (ciphertext.startsWith('v')) {
    // Versioned format: v1:iv:tag:ciphertext
    const parts = ciphertext.split(':');
    version = parseInt(parts[0].slice(1));
    ivHex = parts[1];
    tagHex = parts[2];
    encrypted = parts[3];
  } else {
    // Legacy format: iv:tag:ciphertext
    const parts = ciphertext.split(':');
    version = 1;
    ivHex = parts[0];
    tagHex = parts[1];
    encrypted = parts[2];
  }

  const key = getKeyByVersion(version);
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Generate a secure random string for API keys, tokens, etc.
 */
export function secureRandom(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
