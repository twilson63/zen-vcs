import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ZenVCS } from '../lib/vcs.js';
import { ZenDB } from '../lib/db.js';
import { ZenBinClient, KeyPair } from '../lib/api.js';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Mock the ZenBinClient
vi.mock('../lib/api.js', () => {
  const mockClient = {
    publishPage: vi.fn().mockResolvedValue({
      id: 'mock-page-id',
      url: 'https://zenbin.org/p/mock-page-id',
      contentDigest: 'sha-256=:mock:',
      signature: 'mock-sig',
      timestamp: new Date().toISOString(),
    }),
    resolveTree: vi.fn().mockResolvedValue({
      rootId: 'test-remote-root',
      tree: {
        type: 'tree',
        version: 1,
        ownerFingerprint: 'fp-remote-owner',
        adminFingerprints: [],
        entries: [
          { path: 'README.md', kind: 'blob', pageId: 'p-readme', hash: 'h-readme' },
        ],
        parents: [],
        message: 'Remote init',
        timestamp: '2024-01-01',
      },
      stats: { totalEntries: 1, totalBlobs: 1, totalSubtrees: 0 },
    }),
    getRefs: vi.fn().mockResolvedValue({
      treeId: 'test-remote-root',
      branches: { main: 'test-remote-root' },
      tags: {},
    }),
    computeHash: vi.fn((content: string | Buffer) => {
      const { createHash } = require('crypto');
      const buf = typeof content === 'string' ? Buffer.from(content) : content;
      return createHash('sha256').update(buf).digest('base64url');
    }),
    publishReviewRequest: vi.fn().mockResolvedValue({
      id: 'review-req-mock',
      url: 'https://zenbin.org/p/review-req-mock',
      contentDigest: 'sha-256=:mock:',
      signature: 'mock-sig',
      timestamp: new Date().toISOString(),
    }),
    publishReviewResponse: vi.fn().mockResolvedValue({
      id: 'review-res-mock',
      url: 'https://zenbin.org/p/review-res-mock',
      contentDigest: 'sha-256=:mock:',
      signature: 'mock-sig',
      timestamp: new Date().toISOString(),
    }),
    publishMerge: vi.fn().mockResolvedValue({
      id: 'merge-mock',
      url: 'https://zenbin.org/p/merge-mock',
      contentDigest: 'sha-256=:mock:',
      signature: 'mock-sig',
      timestamp: new Date().toISOString(),
    }),
  };

  return {
    ZenBinClient: vi.fn(() => mockClient),
    loadKeys: vi.fn().mockResolvedValue({
      keyId: 'test-key-id',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'test-public-key' },
      privateJwk: { kty: 'OKP', crv: 'Ed25519', x: 'test-public-key', d: 'test-private-key' },
      fingerprint: 'test-fingerprint-abc123',
    }),
    mockClient,
  };
});

describe('ZenVCS', () => {
  let vcs: ZenVCS;
  let tmpDir: string;
  let keysPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'zen-vcs-vcs-test-'));
    keysPath = join(tmpDir, '.zenbin-keys.json');
    writeFileSync(keysPath, JSON.stringify({
      keyId: 'test-key-id',
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'test-public-key' },
      privateJwk: { kty: 'OKP', crv: 'Ed25519', x: 'test-public-key', d: 'test-private-key' },
    }));

    const config = {
      repoName: 'test-repo',
      remoteUrl: 'https://zenbin.org',
      keysPath,
      dbPath: tmpDir,
    };

    vcs = await ZenVCS.init(config);
  });

  afterEach(async () => {
    await vcs.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initRepo', () => {
    it('should create a new repo with main branch', async () => {
      const repo = await vcs.initRepo('test-repo');

      expect(repo.name).toBe('test-repo');
      expect(repo.ownerFingerprint).toBe('test-fingerprint-abc123');
      expect(repo.rootId).toContain('test-repo');

      const mainBranch = await (vcs as any).db.getBranch('main');
      expect(mainBranch).not.toBeNull();
      expect(mainBranch.name).toBe('main');
    });

    it('should throw if repo already exists', async () => {
      await vcs.initRepo('test-repo');
      await expect(vcs.initRepo('test-repo')).rejects.toThrow('already exists');
    });
  });

  describe('add + commit', () => {
    it('should stage a file and commit it', async () => {
      await vcs.initRepo('test-repo');

      // Create a test file
      const testFile = join(tmpDir, 'hello.txt');
      writeFileSync(testFile, 'hello world');

      await vcs.add('hello.txt');

      const status = await vcs.status();
      expect(status.staged).toBe(1);
    });

    it('should fail commit with nothing staged', async () => {
      await vcs.initRepo('test-repo');
      await expect(vcs.commit('empty commit')).rejects.toThrow('Nothing staged');
    });

    it('should fail add for non-existent file', async () => {
      await vcs.initRepo('test-repo');
      await expect(vcs.add('nope.txt')).rejects.toThrow('not found');
    });
  });

  describe('branch', () => {
    it('should create a branch from an existing branch', async () => {
      await vcs.initRepo('test-repo');

      const branch = await vcs.createBranch('feature/test', 'main');
      expect(branch.name).toBe('feature/test');
      expect(branch.parentId).not.toBe('');
    });

    it('should fail if parent branch does not exist', async () => {
      await vcs.initRepo('test-repo');
      await expect(vcs.createBranch('feature/test', 'nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('status', () => {
    it('should return branch and staging info', async () => {
      await vcs.initRepo('test-repo');

      const status = await vcs.status();
      expect(status.branch).toBe('main');
      expect(status.staged).toBe(0);
    });
  });

  describe('log', () => {
    it('should return commit history', async () => {
      await vcs.initRepo('test-repo');

      const log = await vcs.log('main');
      expect(log).toHaveLength(1);
      expect(log[0].message).toContain('Initialize');
    });
  });
});