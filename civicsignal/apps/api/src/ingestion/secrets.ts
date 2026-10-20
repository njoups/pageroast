import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM envelope for connector credentials. The key comes from CREDENTIALS_KEY (base64, 32 bytes) and never
 * enters the database; `key_id` is a fingerprint of the key so rotation can be detected.
 */
export class CredentialCipher {
  readonly keyId: string;
  private constructor(private readonly key: Buffer) {
    this.keyId = createHash('sha256').update(key).digest('hex').slice(0, 12);
  }

  static fromBase64(b64: string | undefined): CredentialCipher | null {
    if (!b64) return null;
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error('CREDENTIALS_KEY must be 32 bytes, base64-encoded');
    return new CredentialCipher(key);
  }

  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
  }

  /** `aad` binds the ciphertext to its connector, so it cannot be copied onto another connector's row. */
  decrypt(blob: string, aad: string): string {
    const [v, iv, tag, ct] = blob.split('.');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported credential format');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'), { authTagLength: 16 });
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  }
}
