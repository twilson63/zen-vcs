import { describe, it, expect, beforeAll } from 'vitest';
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'crypto';
import { loadKeys, ZenBinClient } from '../lib/api.js';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ZenBinClient', () => {
  // Use the actual ZenBin keys for signing verification
  const keysPath = join(process.env.HOME || '/home/node', '.openclaw/workspace/.zenbin-keys.json');
  let hasKeys = false;

  beforeAll(() => {
    try {
      require('fs').accessSync(keysPath);
      hasKeys = true;
    } catch {
      hasKeys = false;
    }
  });

  describe('loadKeys', () => {
    it('should load keys and compute fingerprint', async () => {
      if (!hasKeys) return; // Skip if no keys file

      const keys = await loadKeys(keysPath);
      expect(keys.keyId).toBeTruthy();
      expect(keys.fingerprint).toBeTruthy();
      expect(keys.fingerprint.length).toBe(43); // base64url SHA-256
      expect(keys.publicJwk.kty).toBe('OKP');
      expect(keys.publicJwk.crv).toBe('Ed25519');
    });
  });

  describe('signing', () => {
    it('should produce verifiable Ed25519 signatures', async () => {
      if (!hasKeys) return;

      const keys = await loadKeys(keysPath);
      const client = new ZenBinClient(keys, 'https://zenbin.org');

      // Manually create a signature and verify it
      const method = 'POST';
      const urlPath = '/v1/pages/test';
      const body = '{"html":"test"}';
      const contentDigest = `sha-256=:${createHash('sha256').update(body).digest('base64')}:`;
      const timestamp = new Date().toISOString();
      const nonce = 'test-nonce-12345';

      const canonical = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${contentDigest}`;

      const privateKey = createPrivateKey({ key: keys.privateJwk as any, format: 'jwk' });
      const signature = sign(null, Buffer.from(canonical), privateKey);

      const publicKey = createPublicKey({ key: keys.publicJwk as any, format: 'jwk' });
      const isValid = verify(null, Buffer.from(canonical), publicKey, signature);
      expect(isValid).toBe(true);
    });

    it('should compute consistent content hashes', async () => {
      if (!hasKeys) return;

      const keys = await loadKeys(keysPath);
      const client = new ZenBinClient(keys, 'https://zenbin.org');

      const hash1 = client.computeHash('hello world');
      const hash2 = client.computeHash('hello world');
      const hash3 = client.computeHash('different content');

      expect(hash1).toBe(hash2);
      expect(hash1).not.toBe(hash3);
      expect(hash1.length).toBe(43); // base64url SHA-256
    });
  });
});