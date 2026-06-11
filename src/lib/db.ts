/**
 * LMDB-backed local state for zen-vcs.
 *
 * Namespaced keys — no SQL, no migration files, just get/put/del with
 * predictable key patterns. Same approach as ZenBin's server-side storage.
 */

import { open, Database, RootDatabase, Env } from 'node-lmdb';
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
  private env: Env;
  private db: RootDatabase;
  private dbPath: string;

  private constructor(env: Env, db: RootDatabase, dbPath: string) {
    this.env = env;
    this.db = db;
    this.dbPath = dbPath;
  }

  /** Open (or create) a .zen-vcs database at the given path */
  static async open(basePath: string): Promise<ZenDB> {
    const dbPath = join(basePath, '.zen-vcs');
    mkdirSync(dbPath, { recursive: true });

    const env = new Env();
    env.open({
      path: dbPath,
      mapSize: 64 * 1024 * 1024, // 64MB — plenty for local VCS state
      maxDbs: 8,
    });

    const db = env.openDbi({
      name: 'zenvcs',
      create: true,
    });

    return new ZenDB(env, db, dbPath);
  }

  async close(): Promise<void> {
    this.db.close();
    this.env.close();
  }

  // --- Repo ---

  async putRepo(repo: Repo): Promise<void> {
    const key = `${NS.repo}:${repo.name}`;
    await this.db.put(key, JSON.stringify(repo));
  }

  async getRepo(name: string): Promise<Repo | null> {
    const key = `${NS.repo}:${name}`;
    const val = this.db.getString(key);
    return val ? JSON.parse(val) : null;
  }

  // --- Branch ---

  async putBranch(branch: Branch): Promise<void> {
    const key = `${NS.branch}:${branch.name}`;
    await this.db.put(key, JSON.stringify(branch));
  }

  async getBranch(name: string): Promise<Branch | null> {
    const key = `${NS.branch}:${name}`;
    const val = this.db.getString(key);
    return val ? JSON.parse(val) : null;
  }

  async listBranches(): Promise<Branch[]> {
    const branches: Branch[] = [];
    const prefix = `${NS.branch}:`;
    const txn = this.env.beginTxn();
    const cursor = new txn.Cursor(this.db);
    for (let found = cursor.goToKey(prefix); found !== null && found.startsWith(prefix); found = cursor.goToNext()) {
      const val = cursor.getString();
      if (val) branches.push(JSON.parse(val));
    }
    cursor.close();
    txn.abort();
    return branches;
  }

  // --- Entry ---

  async putEntry(entry: Entry): Promise<void> {
    const key = `${NS.entry}:${entry.rootId}:${entry.path}`;
    await this.db.put(key, JSON.stringify(entry));
  }

  async getEntry(rootId: string, path: string): Promise<Entry | null> {
    const key = `${NS.entry}:${rootId}:${path}`;
    const val = this.db.getString(key);
    return val ? JSON.parse(val) : null;
  }

  async getEntriesForRoot(rootId: string): Promise<Entry[]> {
    const entries: Entry[] = [];
    const prefix = `${NS.entry}:${rootId}:`;
    const txn = this.env.beginTxn();
    const cursor = new txn.Cursor(this.db);
    for (let found = cursor.goToKey(prefix); found !== null && found.startsWith(prefix); found = cursor.goToNext()) {
      const val = cursor.getString();
      if (val) entries.push(JSON.parse(val));
    }
    cursor.close();
    txn.abort();
    return entries;
  }

  // --- Review ---

  async putReview(review: Review): Promise<void> {
    const key = `${NS.review}:${review.id}`;
    await this.db.put(key, JSON.stringify(review));
  }

  async getReview(id: string): Promise<Review | null> {
    const key = `${NS.review}:${id}`;
    const val = this.db.getString(key);
    return val ? JSON.parse(val) : null;
  }

  async listReviews(status?: Review['status']): Promise<Review[]> {
    const reviews: Review[] = [];
    const prefix = `${NS.review}:`;
    const txn = this.env.beginTxn();
    const cursor = new txn.Cursor(this.db);
    for (let found = cursor.goToKey(prefix); found !== null && found.startsWith(prefix); found = cursor.goToNext()) {
      const val = cursor.getString();
      if (val) {
        const review: Review = JSON.parse(val);
        if (!status || review.status === status) {
          reviews.push(review);
        }
      }
    }
    cursor.close();
    txn.abort();
    return reviews;
  }

  // --- Refs ---

  async putRefs(repoName: string, refs: Refs): Promise<void> {
    const key = `${NS.refs}:${repoName}`;
    await this.db.put(key, JSON.stringify(refs));
  }

  async getRefs(repoName: string): Promise<Refs | null> {
    const key = `${NS.refs}:${repoName}`;
    const val = this.db.getString(key);
    return val ? JSON.parse(val) : null;
  }

  // --- Staging ---

  async stageFile(file: StagedFile): Promise<void> {
    const key = `${NS.stage}:${file.path}`;
    await this.db.put(key, JSON.stringify(file));
  }

  async getStagedFiles(): Promise<StagedFile[]> {
    const files: StagedFile[] = [];
    const prefix = `${NS.stage}:`;
    const txn = this.env.beginTxn();
    const cursor = new txn.Cursor(this.db);
    for (let found = cursor.goToKey(prefix); found !== null && found.startsWith(prefix); found = cursor.goToNext()) {
      const val = cursor.getString();
      if (val) files.push(JSON.parse(val));
    }
    cursor.close();
    txn.abort();
    return files;
  }

  async clearStaging(): Promise<void> {
    const prefix = `${NS.stage}:`;
    const txn = this.env.beginTxn();
    const cursor = new txn.Cursor(this.db);
    const keys: string[] = [];
    for (let found = cursor.goToKey(prefix); found !== null && found.startsWith(prefix); found = cursor.goToNext()) {
      keys.push(found);
    }
    cursor.close();
    for (const key of keys) {
      txn.del(key);
    }
    txn.commit();
  }

  // --- Utility ---

  async drop(): Promise<void> {
    // Clear all data — for testing or `zen-vcs clean`
    const prefixes = Object.values(NS);
    const txn = this.env.beginTxn();
    for (const prefix of prefixes) {
      const fullPrefix = `${prefix}:`;
      const cursor = new txn.Cursor(this.db);
      const keys: string[] = [];
      for (let found = cursor.goToKey(fullPrefix); found !== null && found.startsWith(fullPrefix); found = cursor.goToNext()) {
        keys.push(found);
      }
      cursor.close();
      for (const key of keys) {
        txn.del(key);
      }
    }
    txn.commit();
  }
}