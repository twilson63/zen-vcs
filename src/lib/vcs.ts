/**
 * Core VCS operations for zen-vcs.
 *
 * init, clone, add, commit, branch, merge, push, pull, diff, log, status
 * These are the high-level commands that orchestrate the API and DB layers.
 */

import { ZenDB, Repo, Branch, Entry, StagedFile, Review, Refs } from './db.js';
import { ZenBinClient, TreeRoot, TreeEntry, KeyPair, loadKeys } from './api.js';
import { createHash } from 'crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, relative, extname } from 'path';

export interface VcsConfig {
  repoName: string;
  remoteUrl: string;       // ZenBin base URL
  keysPath: string;         // Path to .zenbin-keys.json
  dbPath: string;            // Base path for .zen-vcs/
}

export class ZenVCS {
  private db: ZenDB;
  private client: ZenBinClient;
  private keys: KeyPair;
  private config: VcsConfig;

  constructor(db: ZenDB, client: ZenBinClient, keys: KeyPair, config: VcsConfig) {
    this.db = db;
    this.client = client;
    this.keys = keys;
    this.config = config;
  }

  static async init(config: VcsConfig): Promise<ZenVCS> {
    const keys = await loadKeys(config.keysPath);
    const db = await ZenDB.open(config.dbPath);
    const client = new ZenBinClient(keys, config.remoteUrl);
    return new ZenVCS(db, client, keys, config);
  }

  // --- Repo Operations ---

  async initRepo(name: string): Promise<Repo> {
    const existing = await this.db.getRepo(name);
    if (existing) throw new Error(`Repo "${name}" already exists`);

    // Create initial empty tree root
    const rootId = `${name}-root-v1`;
    const treeRoot: TreeRoot = {
      type: 'tree',
      version: 1,
      ownerFingerprint: this.keys.fingerprint,
      adminFingerprints: [],
      entries: [],
      parents: [],
      message: `Initialize ${name}`,
      timestamp: new Date().toISOString(),
    };

    // Publish the tree root
    await this.client.publishPage(rootId, {
      html: JSON.stringify(treeRoot, null, 2),
    }, {
      'Content-Type': 'application/vnd.zenbin.tree+json',
    });

    const repo: Repo = {
      rootId,
      name,
      ownerFingerprint: this.keys.fingerprint,
      ownerKeyId: this.keys.keyId,
      remoteUrl: this.config.remoteUrl,
      createdAt: new Date().toISOString(),
    };

    await this.db.putRepo(repo);

    // Create main branch
    await this.db.putBranch({
      name: 'main',
      rootId,
      parentId: '',
      message: `Initialize ${name}`,
      timestamp: new Date().toISOString(),
    });

    // Create initial refs
    await this.db.putRefs(name, {
      branches: { main: rootId },
      tags: {},
    });

    return repo;
  }

  async cloneRepo(rootId: string, name: string): Promise<Repo> {
    // Fetch the tree root from remote
    const result = await this.client.resolveTree(rootId);

    const repo: Repo = {
      rootId,
      name,
      ownerFingerprint: result.tree.ownerFingerprint,
      ownerKeyId: '', // We don't have this from the tree response
      remoteUrl: this.config.remoteUrl,
      createdAt: new Date().toISOString(),
    };

    await this.db.putRepo(repo);

    // Store all entries
    for (const entry of result.tree.entries) {
      await this.db.putEntry({
        path: entry.path,
        kind: entry.kind,
        pageId: entry.pageId,
        hash: entry.hash,
        rootId,
      });
    }

    // Create main branch pointing at this root
    await this.db.putBranch({
      name: 'main',
      rootId,
      parentId: result.tree.parents[0] || '',
      message: result.tree.message || `Clone ${rootId}`,
      timestamp: result.tree.timestamp,
    });

    // Try to fetch refs
    try {
      const refs = await this.client.getRefs(rootId);
      await this.db.putRefs(name, {
        branches: refs.branches,
        tags: refs.tags || {},
      });
    } catch {
      // Refs might not exist yet — that's fine
      await this.db.putRefs(name, {
        branches: { main: rootId },
        tags: {},
      });
    }

    return repo;
  }

  // --- Staging ---

  async add(filePath: string): Promise<void> {
    const fullPath = join(process.cwd(), filePath);
    if (!existsSync(fullPath)) throw new Error(`File not found: ${filePath}`);

    const content = readFileSync(fullPath);
    const hash = this.client.computeHash(content);
    const kind = statSync(fullPath).isDirectory() ? 'tree' : 'blob';

    await this.db.stageFile({
      path: filePath,
      kind,
      content: content.toString('base64'),
      hash,
    });
  }

  // --- Commit ---

  async commit(message: string, branch: string = 'main'): Promise<string> {
    const staged = await this.db.getStagedFiles();
    if (staged.length === 0) throw new Error('Nothing staged — use `zen-vcs add` first');

    const currentBranch = await this.db.getBranch(branch);
    if (!currentBranch) throw new Error(`Branch "${branch}" not found`);

    const version = this.nextVersion(currentBranch.rootId);
    const newRootId = `${this.config.repoName}-root-${version}`;

    // Publish child pages first
    const entries: TreeEntry[] = [];
    for (const file of staged) {
      const pageId = `${this.config.repoName}-${file.path.replace(/[/\\]/g, '-')}-${file.hash.substring(0, 8)}`;
      const content = Buffer.from(file.content as string, 'base64').toString('utf8');

      await this.client.publishPage(pageId, {
        html: content,
      }, {
        'CAP-Tree-Root': newRootId,
        'CAP-Tree-Path': file.path,
      });

      entries.push({
        path: file.path,
        kind: file.kind,
        pageId,
        hash: file.hash,
      });
    }

    // Build tree root
    const treeRoot: TreeRoot = {
      type: 'tree',
      version: 1,
      ownerFingerprint: this.keys.fingerprint,
      adminFingerprints: [],
      entries,
      parents: [currentBranch.rootId],
      message,
      timestamp: new Date().toISOString(),
    };

    // Publish tree root
    await this.client.publishPage(newRootId, {
      html: JSON.stringify(treeRoot, null, 2),
    }, {
      'Content-Type': 'application/vnd.zenbin.tree+json',
    });

    // Update branch
    await this.db.putBranch({
      name: branch,
      rootId: newRootId,
      parentId: currentBranch.rootId,
      message,
      timestamp: new Date().toISOString(),
    });

    // Store entries
    for (const entry of entries) {
      await this.db.putEntry({ ...entry, rootId: newRootId });
    }

    // Clear staging
    await this.db.clearStaging();

    return newRootId;
  }

  // --- Branch ---

  async createBranch(name: string, fromBranch: string = 'main'): Promise<Branch> {
    const parent = await this.db.getBranch(fromBranch);
    if (!parent) throw new Error(`Branch "${fromBranch}" not found`);

    // A branch is just a pointer — the new root will be created on first commit
    const branch: Branch = {
      name,
      rootId: parent.rootId, // Points at same root until a commit
      parentId: parent.rootId,
      message: `Branch from ${fromBranch}`,
      timestamp: new Date().toISOString(),
    };

    await this.db.putBranch(branch);
    return branch;
  }

  // --- Merge ---

  async merge(sourceBranch: string, targetBranch: string = 'main', message?: string): Promise<string> {
    const source = await this.db.getBranch(sourceBranch);
    const target = await this.db.getBranch(targetBranch);
    if (!source) throw new Error(`Branch "${sourceBranch}" not found`);
    if (!target) throw new Error(`Branch "${targetBranch}" not found`);

    const version = this.nextVersion(target.rootId);
    const mergeRootId = `${this.config.repoName}-root-${version}`;

    // Combine entries from both roots
    const sourceEntries = await this.db.getEntriesForRoot(source.rootId);
    const targetEntries = await this.db.getEntriesForRoot(target.rootId);

    // Simple merge: target entries + source entries that don't conflict
    const entriesMap = new Map<string, TreeEntry>();
    for (const e of targetEntries) entriesMap.set(e.path, { path: e.path, kind: e.kind, pageId: e.pageId, hash: e.hash });
    for (const e of sourceEntries) {
      if (!entriesMap.has(e.path)) {
        entriesMap.set(e.path, { path: e.path, kind: e.kind, pageId: e.pageId, hash: e.hash });
      }
      // Conflicts would need manual resolution — for now, source wins
    }

    const treeRoot: TreeRoot = {
      type: 'tree',
      version: 1,
      ownerFingerprint: this.keys.fingerprint,
      adminFingerprints: [],
      entries: Array.from(entriesMap.values()),
      parents: [target.rootId, source.rootId],
      message: message || `Merge ${sourceBranch} into ${targetBranch}`,
      timestamp: new Date().toISOString(),
    };

    // Publish merge root with CAP-Type: merge
    await this.client.publishMerge(mergeRootId, [target.rootId, source.rootId], treeRoot);

    // Update target branch
    await this.db.putBranch({
      name: targetBranch,
      rootId: mergeRootId,
      parentId: target.rootId,
      message: treeRoot.message,
      timestamp: new Date().toISOString(),
    });

    return mergeRootId;
  }

  // --- Review ---

  async reviewRequest(references: string[], recipientFingerprint: string, message?: string): Promise<string> {
    const result = await this.client.publishReviewRequest({
      references,
      recipientFingerprint,
      message,
    });

    // Store locally
    await this.db.putReview({
      id: result.id,
      type: 'review-request',
      references,
      fromFingerprint: this.keys.fingerprint,
      toFingerprint: recipientFingerprint,
      status: 'open',
      message,
      timestamp: new Date().toISOString(),
    });

    return result.id;
  }

  async reviewRespond(requestId: string, outcome: 'approved' | 'changes-requested' | 'commented', recipientFingerprint: string, message?: string): Promise<string> {
    const result = await this.client.publishReviewResponse({
      references: [requestId],
      outcome,
      recipientFingerprint,
      message,
    });

    // Update the original request locally
    const original = await this.db.getReview(requestId);
    if (original) {
      original.status = outcome === 'approved' ? 'approved' : outcome === 'changes-requested' ? 'rejected' : original.status;
      await this.db.putReview(original);
    }

    // Store the response locally
    await this.db.putReview({
      id: result.id,
      type: 'review-response',
      references: [requestId],
      outcome,
      fromFingerprint: this.keys.fingerprint,
      toFingerprint: recipientFingerprint,
      status: outcome === 'approved' ? 'approved' : outcome === 'changes-requested' ? 'rejected' : 'open',
      message,
      timestamp: new Date().toISOString(),
    });

    return result.id;
  }

  // --- Log ---

  async log(branch: string = 'main', limit: number = 20): Promise<Branch[]> {
    const commits: Branch[] = [];
    let current = await this.db.getBranch(branch);
    if (!current) return commits;

    commits.push(current);

    // Walk parent chain from local DB
    for (let i = 0; i < limit - 1; i++) {
      if (!current.parentId) break;
      const parent = await this.db.getBranch(current.parentId);
      if (!parent) break;
      commits.push(parent);
      current = parent;
    }

    return commits;
  }

  // --- Status ---

  async status(): Promise<{ branch: string | null; staged: number; ahead: number }> {
    const branches = await this.db.listBranches();
    const current = branches.find(b => b.name === 'main'); // TODO: track HEAD
    const staged = await this.db.getStagedFiles();

    return {
      branch: current?.name ?? null,
      staged: staged.length,
      ahead: 0, // TODO: compare with remote
    };
  }

  // --- Utility ---

  private nextVersion(rootId: string): number {
    const match = rootId.match(/v(\d+)$/);
    if (match) return parseInt(match[1]) + 1;
    return 2; // Default to v2 if no version found
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}