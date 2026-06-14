/**
 * LMDB-backed local state for zen-vcs.
 *
 * Uses the modern `lmdb` package (v3.x) for async, high-performance storage.
 * Namespaced keys — no SQL, no migration files, just get/put/del with
 * predictable key patterns. Same approach as ZenBin's server-side storage.
 */

import { open, RootDatabase } from 'lmdb';
import { mkdirSync } from 'fs';
import { join } from 'path';

// --- Types ---

export interface Repo {
  rootId: string;           // Initial tree root page ID
  name: string;             // Repo name (slug)
  ownerFingerprint: string; // SHA-256 fingerprint of owner key
  ownerKeyId: string;       // Owner key ID
  remoteUrl: string;        // ZenBin base URL
  createdAt: string;        // ISO-8601
}

export interface Branch {
  name: string;             // Branch name (e.g. "main", "feature/auth")
  rootId: string;           // Current root page ID for this branch
  parentId: string;         // Parent root ID
  message: string;          // Commit message
  timestamp: string;        // ISO-8601
}

export interface Entry {
  path: string;             // Path within the tree (e.g. "src/index.ts")
  kind: 'blob' | 'tree';   // Entry type
  pageId: string;           // ZenBin page ID
  hash: string;             // SHA-256 content digest (base64url)
  rootId: string;           // Which root this entry belongs to
}

export interface Review {
  id: string;               // Page ID of the review message
  type: 'review-request' | 'review-response' | 'merge';
  references: string[];     // Page IDs referenced
  outcome?: 'approved' | 'changes-requested' | 'commented';
  fromFingerprint: string;  // Reviewer's fingerprint (for responses) or author's (for requests)
  toFingerprint: string;    // Recipient fingerprint
  status: 'open' | 'approved' | 'rejected' | 'merged' | 'closed';
  rootId?: string;          // Tree root being reviewed (if applicable)
  message?: string;         // Review message content
  timestamp: string;        // ISO-8601
}

export interface Refs {
  branches: Record<string, string>; // Branch name → root ID
  tags: Record<string, string>;     // Tag name → root ID
}

export interface StagedFile {
  path: string;
  kind: 'blob' | 'tree';
  content: string | Buffer;  // File content or base64 for binary
  hash: string;              // Pre-computed content digest
}

// --- Key Patterns ---
// repo:{name}           → Repo
// branch:{name}         → Branch
// entry:{rootId}:{path} → Entry
// review:{id}           → Review
// refs:{repoName}        → Refs
// stage:{path}          → StagedFile (temporary staging area)

const NS = {
  repo: 'repo',
  branch: 'branch',
  entry: 'entry',
  review: 'review',
  refs: 'refs',
  stage: 'stage',
} as const;

export class ZenDB {
  private db: RootDatabase;
  private dbPath: string;

  private constructor(db: RootDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
  }

  /** Open (or create) a .zen-vcs database at the given path */
  static async open(basePath: string): Promise<ZenDB> {
    const dbPath = join(basePath, '.zen-vcs');
    mkdirSync(dbPath, { recursive: true });

    const db: RootDatabase = await open({
      path: dbPath,
      name: 'zenvcs',
      compression: true,
    });

    return new ZenDB(db, dbPath);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // --- Repo ---

  async putRepo(repo: Repo): Promise<void> {
    const key = `${NS.repo}:${repo.name}`;
    await this.db.put(key, JSON.stringify(repo));
  }

  async getRepo(name: string): Promise<Repo | null> {
    const key = `${NS.repo}:${name}`;
    const val = await this.db.get(key);
    return val ? JSON.parse(val as string) : null;
  }

  // --- Branch ---

  async putBranch(branch: Branch): Promise<void> {
    const key = `${NS.branch}:${branch.name}`;
    await this.db.put(key, JSON.stringify(branch));
  }

  async getBranch(name: string): Promise<Branch | null> {
    const key = `${NS.branch}:${name}`;
    const val = await this.db.get(key);
    return val ? JSON.parse(val as string) : null;
  }

  async listBranches(): Promise<Branch[]> {
    const branches: Branch[] = [];
    const prefix = `${NS.branch}:`;
    for (const { key, value } of this.db.getRange({ start: prefix })) {
      const strKey = key as string;
      if (!strKey.startsWith(prefix)) break;
      if (value) branches.push(JSON.parse(value as string));
    }
    return branches;
  }

  // --- Entry ---

  async putEntry(entry: Entry): Promise<void> {
    const key = `${NS.entry}:${entry.rootId}:${entry.path}`;
    await this.db.put(key, JSON.stringify(entry));
  }

  async getEntry(rootId: string, path: string): Promise<Entry | null> {
    const key = `${NS.entry}:${rootId}:${path}`;
    const val = await this.db.get(key);
    return val ? JSON.parse(val as string) : null;
  }

  async getEntriesForRoot(rootId: string): Promise<Entry[]> {
    const entries: Entry[] = [];
    const prefix = `${NS.entry}:${rootId}:`;
    for (const { key, value } of this.db.getRange({ start: prefix })) {
      const strKey = key as string;
      if (!strKey.startsWith(prefix)) break;
      if (value) entries.push(JSON.parse(value as string));
    }
    return entries;
  }

  // --- Review ---

  async putReview(review: Review): Promise<void> {
    const key = `${NS.review}:${review.id}`;
    await this.db.put(key, JSON.stringify(review));
  }

  async getReview(id: string): Promise<Review | null> {
    const key = `${NS.review}:${id}`;
    const val = await this.db.get(key);
    return val ? JSON.parse(val as string) : null;
  }

  async listReviews(status?: Review['status']): Promise<Review[]> {
    const reviews: Review[] = [];
    const prefix = `${NS.review}:`;
    for (const { key, value } of this.db.getRange({ start: prefix })) {
      const strKey = key as string;
      if (!strKey.startsWith(prefix)) break;
      if (value) {
        const review: Review = JSON.parse(value as string);
        if (!status || review.status === status) {
          reviews.push(review);
        }
      }
    }
    return reviews;
  }

  // --- Refs ---

  async putRefs(repoName: string, refs: Refs): Promise<void> {
    const key = `${NS.refs}:${repoName}`;
    await this.db.put(key, JSON.stringify(refs));
  }

  async getRefs(repoName: string): Promise<Refs | null> {
    const key = `${NS.refs}:${repoName}`;
    const val = await this.db.get(key);
    return val ? JSON.parse(val as string) : null;
  }

  // --- Staging ---

  async stageFile(file: StagedFile): Promise<void> {
    const key = `${NS.stage}:${file.path}`;
    await this.db.put(key, JSON.stringify(file));
  }

  async getStagedFiles(): Promise<StagedFile[]> {
    const files: StagedFile[] = [];
    const prefix = `${NS.stage}:`;
    for (const { key, value } of this.db.getRange({ start: prefix })) {
      const strKey = key as string;
      if (!strKey.startsWith(prefix)) break;
      if (value) files.push(JSON.parse(value as string));
    }
    return files;
  }

  async clearStaging(): Promise<void> {
    const prefix = `${NS.stage}:`;
    const keys: string[] = [];
    for (const { key } of this.db.getRange({ start: prefix })) {
      const strKey = key as string;
      if (!strKey.startsWith(prefix)) break;
      keys.push(strKey);
    }
    for (const key of keys) {
      await this.db.remove(key);
    }
  }

  // --- Utility ---

  async drop(): Promise<void> {
    // Clear all data — for testing or `zen-vcs clean`
    const prefixes = Object.values(NS);
    for (const prefix of prefixes) {
      const fullPrefix = `${prefix}:`;
      const keys: string[] = [];
      for (const { key } of this.db.getRange({ start: fullPrefix })) {
        const strKey = key as string;
        if (!strKey.startsWith(fullPrefix)) break;
        keys.push(strKey);
      }
      for (const key of keys) {
        await this.db.remove(key);
      }
    }
  }
}