import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ZenDB } from '../lib/db.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ZenDB', () => {
  let db: ZenDB;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = mkdtempSync(join(tmpdir(), 'zen-vcs-test-'));
    db = await ZenDB.open(dbPath);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dbPath, { recursive: true, force: true });
  });

  describe('Repo operations', () => {
    it('should put and get a repo', async () => {
      const repo = {
        rootId: 'test-root-v1',
        name: 'my-repo',
        ownerFingerprint: 'abc123',
        ownerKeyId: 'key-1',
        remoteUrl: 'https://zenbin.org',
        createdAt: new Date().toISOString(),
      };

      await db.putRepo(repo);
      const result = await db.getRepo('my-repo');

      expect(result).not.toBeNull();
      expect(result!.name).toBe('my-repo');
      expect(result!.rootId).toBe('test-root-v1');
      expect(result!.ownerFingerprint).toBe('abc123');
    });

    it('should return null for non-existent repo', async () => {
      const result = await db.getRepo('nope');
      expect(result).toBeNull();
    });

    it('should overwrite a repo on re-put', async () => {
      const repo = {
        rootId: 'v1',
        name: 'repo',
        ownerFingerprint: 'fp1',
        ownerKeyId: 'k1',
        remoteUrl: 'https://zenbin.org',
        createdAt: '2024-01-01',
      };
      await db.putRepo(repo);

      repo.rootId = 'v2';
      await db.putRepo(repo);

      const result = await db.getRepo('repo');
      expect(result!.rootId).toBe('v2');
    });
  });

  describe('Branch operations', () => {
    it('should put and get a branch', async () => {
      const branch = {
        name: 'main',
        rootId: 'root-v1',
        parentId: '',
        message: 'Initial commit',
        timestamp: new Date().toISOString(),
      };

      await db.putBranch(branch);
      const result = await db.getBranch('main');

      expect(result).not.toBeNull();
      expect(result!.name).toBe('main');
      expect(result!.rootId).toBe('root-v1');
    });

    it('should list all branches', async () => {
      await db.putBranch({
        name: 'main',
        rootId: 'root-v1',
        parentId: '',
        message: 'Init',
        timestamp: '2024-01-01',
      });
      await db.putBranch({
        name: 'feature/auth',
        rootId: 'root-v2',
        parentId: 'root-v1',
        message: 'Auth feature',
        timestamp: '2024-01-02',
      });

      const branches = await db.listBranches();
      expect(branches).toHaveLength(2);
      expect(branches.map(b => b.name).sort()).toEqual(['feature/auth', 'main']);
    });
  });

  describe('Entry operations', () => {
    it('should put and get an entry', async () => {
      const entry = {
        path: 'src/index.ts',
        kind: 'blob' as const,
        pageId: 'page-1',
        hash: 'sha256abc',
        rootId: 'root-v1',
      };

      await db.putEntry(entry);
      const result = await db.getEntry('root-v1', 'src/index.ts');

      expect(result).not.toBeNull();
      expect(result!.path).toBe('src/index.ts');
      expect(result!.pageId).toBe('page-1');
    });

    it('should get all entries for a root', async () => {
      await db.putEntry({
        path: 'src/index.ts',
        kind: 'blob',
        pageId: 'p1',
        hash: 'h1',
        rootId: 'root-v1',
      });
      await db.putEntry({
        path: 'src/lib.ts',
        kind: 'blob',
        pageId: 'p2',
        hash: 'h2',
        rootId: 'root-v1',
      });
      await db.putEntry({
        path: 'src/other.ts',
        kind: 'blob',
        pageId: 'p3',
        hash: 'h3',
        rootId: 'root-v2',
      });

      const entries = await db.getEntriesForRoot('root-v1');
      expect(entries).toHaveLength(2);
    });
  });

  describe('Staging operations', () => {
    it('should stage and retrieve files', async () => {
      await db.stageFile({
        path: 'hello.txt',
        kind: 'blob',
        content: 'hello world',
        hash: 'abc123',
      });

      const files = await db.getStagedFiles();
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe('hello.txt');
    });

    it('should clear staging area', async () => {
      await db.stageFile({
        path: 'a.txt',
        kind: 'blob',
        content: 'a',
        hash: 'h1',
      });
      await db.stageFile({
        path: 'b.txt',
        kind: 'blob',
        content: 'b',
        hash: 'h2',
      });

      await db.clearStaging();
      const files = await db.getStagedFiles();
      expect(files).toHaveLength(0);
    });
  });

  describe('Review operations', () => {
    it('should put and get a review', async () => {
      const review = {
        id: 'review-1',
        type: 'review-request' as const,
        references: ['page-1', 'page-2'],
        fromFingerprint: 'fp-author',
        toFingerprint: 'fp-reviewer',
        status: 'open' as const,
        message: 'Please review this',
        timestamp: new Date().toISOString(),
      };

      await db.putReview(review);
      const result = await db.getReview('review-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('review-1');
      expect(result!.type).toBe('review-request');
      expect(result!.references).toEqual(['page-1', 'page-2']);
    });

    it('should list reviews by status', async () => {
      await db.putReview({
        id: 'r1',
        type: 'review-request',
        references: ['p1'],
        fromFingerprint: 'fp1',
        toFingerprint: 'fp2',
        status: 'open',
        timestamp: '2024-01-01',
      });
      await db.putReview({
        id: 'r2',
        type: 'review-response',
        references: ['r1'],
        outcome: 'approved',
        fromFingerprint: 'fp2',
        toFingerprint: 'fp1',
        status: 'approved',
        timestamp: '2024-01-02',
      });

      const open = await db.listReviews('open');
      expect(open).toHaveLength(1);
      expect(open[0].id).toBe('r1');

      const approved = await db.listReviews('approved');
      expect(approved).toHaveLength(1);

      const all = await db.listReviews();
      expect(all).toHaveLength(2);
    });
  });

  describe('Refs operations', () => {
    it('should put and get refs', async () => {
      const refs = {
        branches: { main: 'root-v1', dev: 'root-v2' },
        tags: { v1: 'root-v1' },
      };

      await db.putRefs('my-repo', refs);
      const result = await db.getRefs('my-repo');

      expect(result).not.toBeNull();
      expect(result!.branches.main).toBe('root-v1');
      expect(result!.tags.v1).toBe('root-v1');
    });

    it('should return null for non-existent refs', async () => {
      const result = await db.getRefs('nope');
      expect(result).toBeNull();
    });
  });

  describe('Drop utility', () => {
    it('should clear all data', async () => {
      await db.putRepo({
        rootId: 'r1',
        name: 'repo',
        ownerFingerprint: 'fp',
        ownerKeyId: 'k',
        remoteUrl: 'https://example.com',
        createdAt: '2024-01-01',
      });
      await db.putBranch({
        name: 'main',
        rootId: 'r1',
        parentId: '',
        message: 'Init',
        timestamp: '2024-01-01',
      });

      await db.drop();

      expect(await db.getRepo('repo')).toBeNull();
      expect(await db.getBranch('main')).toBeNull();
    });
  });
});