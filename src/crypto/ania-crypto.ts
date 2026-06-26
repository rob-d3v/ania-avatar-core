// .ania file decryption.
//
// Supports v1.0 / v2.0 / v3.0 binary headers:
//   ANIA(4) + VERSION(3) [+ optional sub-version byte] + ...
//   v3.0:  HMAC(32) + SALT(16) + IV(16) + CIPHERTEXT
//          - all-zero HMAC/SALT/IV  => MARKET avatar (no password, plain JSON)
//          - otherwise              => PERSONAL avatar (PBKDF2 100k + AES-256-CBC)
//                                       with a 4-byte big-endian metadata-length
//                                       prefix inside the plaintext.
//   v1.0/v2.0:  SALT(16) + IV(16) + CIPHERTEXT (PBKDF2 100k + AES-256-CBC).
//
// Uses the Web Crypto API (`crypto.subtle`), available in all modern browsers
// and Node 16+. Ported from the Chrome extension's `lib/utils/crypto.ts`.

import type { AniaAvatarData } from '../types';

const PBKDF2_ITERATIONS = 100000;

function getCrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new Error(
      '[ania-avatar-core] Web Crypto (crypto.subtle) is unavailable in this environment.'
    );
  }
  return c;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  usage: KeyUsage[]
): Promise<CryptoKey> {
  const subtle = getCrypto().subtle;
  const passwordKey = await subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    passwordKey,
    { name: 'AES-CBC', length: 256 },
    false,
    usage
  );
}

const isAllZeros = (arr: Uint8Array): boolean => arr.every((b) => b === 0);

/**
 * Decrypt a `.ania` file buffer into its avatar data. For market/unencrypted
 * avatars the `password` is ignored.
 *
 * @param encryptedData The raw `.ania` file bytes.
 * @param password      Password for personal (encrypted) avatars. Optional for market avatars.
 */
export async function decryptAniaFile(
  encryptedData: ArrayBuffer,
  password = ''
): Promise<AniaAvatarData> {
  const bytes = new Uint8Array(encryptedData);
  let offset = 0;

  // Magic header.
  const magic = String.fromCharCode(...bytes.slice(offset, offset + 4));
  offset += 4;
  if (magic !== 'ANIA') {
    throw new Error(`[ania-avatar-core] Invalid .ania file — magic: ${magic}`);
  }

  // Version.
  const version = String.fromCharCode(...bytes.slice(offset, offset + 3));
  offset += 3;
  if (!['1.0', '2.0', '3.0'].includes(version)) {
    throw new Error(`[ania-avatar-core] Unsupported .ania version: ${version}`);
  }

  // Optional lowercase sub-version byte.
  const nextByte = bytes[offset];
  if (nextByte >= 97 && nextByte <= 122) {
    offset += 1;
  }

  const subtle = getCrypto().subtle;

  if (version === '3.0') {
    const hmac = bytes.slice(offset, offset + 32);
    offset += 32;
    const salt = bytes.slice(offset, offset + 16);
    offset += 16;
    const iv = bytes.slice(offset, offset + 16);
    offset += 16;
    const ciphertext = bytes.slice(offset);

    // Market avatar — all-zero header triplet => plain JSON, no password.
    if (isAllZeros(hmac) && isAllZeros(salt) && isAllZeros(iv)) {
      let dataStr = new TextDecoder('utf-8').decode(ciphertext);
      const licenseIdx = dataStr.lastIndexOf('<<<ANIA_LICENSE>>>');
      if (licenseIdx > 0) dataStr = dataStr.substring(0, licenseIdx);
      return JSON.parse(dataStr) as AniaAvatarData;
    }

    // Personal avatar — decrypt with the password.
    const key = await deriveKey(password, salt, ['decrypt']);
    const decryptedBuffer = await subtle.decrypt(
      { name: 'AES-CBC', iv: iv as unknown as BufferSource },
      key,
      ciphertext as unknown as BufferSource
    );
    const decryptedBytes = new Uint8Array(decryptedBuffer);

    // 4-byte big-endian metadata length prefix, then the JSON body.
    const metadataLen =
      (decryptedBytes[0] << 24) |
      (decryptedBytes[1] << 16) |
      (decryptedBytes[2] << 8) |
      decryptedBytes[3];
    const jsonBytes = decryptedBytes.slice(4 + metadataLen);
    const jsonString = new TextDecoder('utf-8').decode(jsonBytes);
    return JSON.parse(jsonString) as AniaAvatarData;
  }

  // v1.0 / v2.0 — SALT + IV + CIPHERTEXT, no metadata prefix.
  const salt = bytes.slice(offset, offset + 16);
  offset += 16;
  const iv = bytes.slice(offset, offset + 16);
  offset += 16;
  const ciphertext = bytes.slice(offset);

  const key = await deriveKey(password, salt, ['decrypt']);
  const decryptedBuffer = await subtle.decrypt(
    { name: 'AES-CBC', iv: iv as unknown as BufferSource },
    key,
    ciphertext as unknown as BufferSource
  );
  const jsonString = new TextDecoder('utf-8').decode(decryptedBuffer);
  return JSON.parse(jsonString) as AniaAvatarData;
}
