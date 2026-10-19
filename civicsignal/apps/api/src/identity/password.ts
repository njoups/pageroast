import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

function scrypt(pw: string, salt: Buffer, keylen: number, N: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(pw, salt, keylen, { N, r: 8, p: 1, maxmem: 256 * N * 8 }, (e, k) => (e ? reject(e) : resolve(k))));
}

export async function hashPassword(password: string, N: number): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, 64, N);
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !n || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, Number(n));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
