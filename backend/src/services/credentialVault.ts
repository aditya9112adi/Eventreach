import crypto from 'crypto';

/**
 * Encryption at rest for the per-sender Meta credential a POC's WhatsApp
 * onboarding produces (services/whatsappOnboardingService.ts).
 *
 * AES-256-GCM with a random 96-bit IV per value and the authentication tag
 * stored beside it, so a value that was altered in the database fails to
 * decrypt instead of decrypting to something else. The key comes only from the
 * server environment (WHATSAPP_CREDENTIAL_KEY: 32 random bytes, base64) and is
 * never stored with the data. `keyId` (a short fingerprint of the key) is kept
 * with each value so a rotated key is recognised and the value re-encrypted or
 * the sender reconnected, never silently mis-decrypted.
 *
 * Nothing here logs, returns or throws a plaintext, a key or a ciphertext.
 */

export const CREDENTIAL_KEY_ENV = 'WHATSAPP_CREDENTIAL_KEY';

export interface SealedCredential {
  ciphertext: string;
  iv: string;
  tag: string;
  keyId: string;
}

export class CredentialVaultError extends Error {
  readonly code: 'NOT_CONFIGURED' | 'KEY_MISMATCH' | 'CORRUPT';
  constructor(code: CredentialVaultError['code'], message: string) {
    super(message);
    this.name = 'CredentialVaultError';
    this.code = code;
  }
}

const readKey = (env: NodeJS.ProcessEnv = process.env): Buffer => {
  const raw = env[CREDENTIAL_KEY_ENV]?.trim();
  if (!raw) throw new CredentialVaultError('NOT_CONFIGURED', `${CREDENTIAL_KEY_ENV} is not configured on the server.`);
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new CredentialVaultError('NOT_CONFIGURED', `${CREDENTIAL_KEY_ENV} is not valid base64.`);
  }
  if (key.length !== 32) throw new CredentialVaultError('NOT_CONFIGURED', `${CREDENTIAL_KEY_ENV} must be 32 bytes (base64-encoded).`);
  return key;
};

const keyIdOf = (key: Buffer) => crypto.createHash('sha256').update(key).digest('hex').slice(0, 12);

/** Whether a usable key is configured. Names only - never the value. */
export const isVaultConfigured = (env: NodeJS.ProcessEnv = process.env): boolean => {
  try {
    readKey(env);
    return true;
  } catch {
    return false;
  }
};

export const sealCredential = (plaintext: string, env: NodeJS.ProcessEnv = process.env): SealedCredential => {
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new CredentialVaultError('CORRUPT', 'Nothing to encrypt.');
  const key = readKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), keyId: keyIdOf(key) };
};

export const openCredential = (sealed: Partial<SealedCredential> | null | undefined, env: NodeJS.ProcessEnv = process.env): string => {
  if (!sealed?.ciphertext || !sealed.iv || !sealed.tag) throw new CredentialVaultError('CORRUPT', 'No stored credential.');
  const key = readKey(env);
  if (sealed.keyId && sealed.keyId !== keyIdOf(key)) {
    throw new CredentialVaultError('KEY_MISMATCH', 'The stored credential was encrypted with a different key. Reconnect the sender.');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    throw new CredentialVaultError('CORRUPT', 'The stored credential could not be decrypted. Reconnect the sender.');
  }
};
