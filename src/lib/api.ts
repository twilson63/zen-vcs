/**
 * ZenBin API client for zen-vcs.
 *
 * Handles Ed25519 signing, tree resolution, page publishing,
 * review workflows, and content-addressed operations.
 */

import { createPrivateKey, createPublicKey, sign } from 'crypto';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';

export interface KeyPair {
  keyId: string;
  publicJwk: JsonWebKey;
  privateJwk: JsonWebKey;
  fingerprint: string; // SHA-256 of the public key, base64url
}

export interface TreeRoot {
  type: 'tree';
  version: number;
  ownerFingerprint: string;
  adminFingerprints: string[];
  entries: TreeEntry[];
  parents: string[];
  message?: string;
  timestamp: string;
}

export interface TreeEntry {
  path: string;
  kind: 'blob' | 'tree';
  pageId: string;
  hash: string;
}

export interface PagePublishResult {
  id: string;
  url: string;
  contentDigest: string;
  signature: string;
  timestamp: string;
}

export interface TreeResolveResult {
  rootId: string;
  tree: TreeRoot;
  stats: {
    totalEntries: number;
    totalBlobs: number;
    totalSubtrees: number;
  };
}

export interface HistoryResult {
  roots: Array<{
    rootId: string;
    message: string;
    timestamp: string;
    parentIds: string[];
    entryCount: number;
  }>;
  next_cursor?: string;
}

export interface ReviewRequestParams {
  references: string[];      // Page IDs being reviewed
  recipientFingerprint: string;
  message?: string;
  html?: string;
  markdown?: string;
}

export interface ReviewResponseParams {
  references: string[];      // Review request page IDs
  outcome: 'approved' | 'changes-requested' | 'commented';
  recipientFingerprint: string;
  message?: string;
  html?: string;
  markdown?: string;
}

export class ZenBinClient {
  private keys: KeyPair;
  private baseUrl: string;

  constructor(keys: KeyPair, baseUrl: string = 'https://zenbin.org') {
    this.keys = keys;
    this.baseUrl = baseUrl;
  }

  // --- Signing ---

  private computeContentDigest(body: string): string {
    const hash = createHash('sha256').update(body).digest('base64');
    return `sha-256=:${hash}:`;
  }

  private async signRequest(method: string, urlPath: string, body: string): Promise<Record<string, string>> {
    const contentDigest = this.computeContentDigest(body);
    const timestamp = new Date().toISOString();
    const nonce = createHash('sha256')
      .update(`${Math.random().toString(36)}${Date.now()}`)
      .digest('base64url')
      .substring(0, 24);

    const canonical = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${contentDigest}`;
    const privateKey = createPrivateKey({ key: this.keys.privateJwk as any, format: 'jwk' });
    const signature = sign(null, Buffer.from(canonical), privateKey).toString('base64url');

    return {
      'Content-Type': 'application/json',
      'X-Zenbin-Key-Id': this.keys.keyId,
      'X-Zenbin-Timestamp': timestamp,
      'X-Zenbin-Nonce': nonce,
      'Content-Digest': contentDigest,
      'X-Zenbin-Signature': signature,
    };
  }

  // --- HTTP ---

  private async request(method: string, path: string, body?: string, extraHeaders?: Record<string, string>): Promise<any> {
    const urlPath = path.startsWith('/') ? path : `/${path}`;
    const headers = body ? await this.signRequest(method, urlPath, body) : {};
    const allHeaders = { ...headers, ...extraHeaders };

    const response = await fetch(`${this.baseUrl}${urlPath}`, {
      method,
      headers: allHeaders,
      body,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ZenBin API error (${response.status}): ${error}`);
    }

    return response.json();
  }

  // --- Page Operations ---

  async publishPage(
    slug: string,
    body: Record<string, any>,
    headers?: Record<string, string>
  ): Promise<PagePublishResult> {
    const bodyStr = JSON.stringify(body);
    return this.request('POST', `/v1/pages/${slug}`, bodyStr, headers);
  }

  async getPage(slug: string): Promise<any> {
    return this.request('GET', `/v1/pages/${slug}`);
  }

  // --- Tree Operations ---

  async resolveTree(rootId: string, path?: string): Promise<TreeResolveResult> {
    const urlPath = path
      ? `/v1/tree/${rootId}?path=${encodeURIComponent(path)}`
      : `/v1/tree/${rootId}`;
    return this.request('GET', urlPath);
  }

  async getHistory(rootId: string, limit: number = 20): Promise<HistoryResult> {
    return this.request('GET', `/v1/tree/${rootId}/history?limit=${limit}`);
  }

  async getRefs(treeId: string): Promise<{ treeId: string; branches: Record<string, string>; tags: Record<string, string> }> {
    return this.request('GET', `/v1/tree/${treeId}/refs`);
  }

  // --- Content Digest ---

  computeHash(content: string | Buffer): string {
    const buf = typeof content === 'string' ? Buffer.from(content) : content;
    return createHash('sha256').update(buf).digest('base64url');
  }

  // --- Review Operations ---

  async publishReviewRequest(params: ReviewRequestParams): Promise<PagePublishResult> {
    const slug = `review-req-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const body: Record<string, any> = {};

    if (params.html) body.html = params.html;
    if (params.markdown) body.markdown = params.markdown;
    if (params.message) {
      if (!body.html && !body.markdown) body.markdown = params.message;
    }

    body.capType = 'review-request';
    body.capReferences = params.references;
    body.recipientKeyId = params.recipientFingerprint;

    const headers: Record<string, string> = {
      'CAP-Type': 'review-request',
      'CAP-References': params.references.join(','),
      'CAP-Recipient-Key-Id': params.recipientFingerprint,
    };

    return this.publishPage(slug, body, headers);
  }

  async publishReviewResponse(params: ReviewResponseParams): Promise<PagePublishResult> {
    const slug = `review-res-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const body: Record<string, any> = {};

    if (params.html) body.html = params.html;
    if (params.markdown) body.markdown = params.markdown;
    if (params.message) {
      if (!body.html && !body.markdown) body.markdown = params.message;
    }

    body.capType = 'review-response';
    body.capReferences = params.references;
    body.capOutcome = params.outcome;
    body.recipientKeyId = params.recipientFingerprint;

    const headers: Record<string, string> = {
      'CAP-Type': 'review-response',
      'CAP-References': params.references.join(','),
      'CAP-Outcome': params.outcome,
      'CAP-Recipient-Key-Id': params.recipientFingerprint,
    };

    return this.publishPage(slug, body, headers);
  }

  async publishMerge(
    slug: string,
    references: string[],
    treeRoot: TreeRoot,
    extraHeaders?: Record<string, string>
  ): Promise<PagePublishResult> {
    const body: Record<string, any> = {
      html: JSON.stringify(treeRoot, null, 2),
      contentType: 'application/vnd.zenbin.tree+json',
      capType: 'merge',
      capReferences: references,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'CAP-Type': 'merge',
      'CAP-References': references.join(','),
      ...extraHeaders,
    };

    return this.publishPage(slug, body, headers);
  }

  // --- Query ---

  async queryReviews(params: {
    capType?: string;
    capReferences?: string;
    capOutcome?: string;
    recipient?: string;
  }): Promise<any> {
    const searchParams = new URLSearchParams();
    if (params.capType) searchParams.set('capType', params.capType);
    if (params.capReferences) searchParams.set('capReferences', params.capReferences);
    if (params.capOutcome) searchParams.set('capOutcome', params.capOutcome);
    if (params.recipient) searchParams.set('recipient', params.recipient);
    return this.request('GET', `/v1/pages?${searchParams.toString()}`);
  }
}

// --- Key Loading ---

export async function loadKeys(path: string): Promise<KeyPair> {
  const raw = readFileSync(path, 'utf8');
  const data = JSON.parse(raw);

  // Compute fingerprint from public key
  const publicKey = createPublicKey({ key: data.publicJwk as any, format: 'jwk' });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const fingerprint = createHash('sha256').update(der).digest('base64url');

  return {
    keyId: data.keyId,
    publicJwk: data.publicJwk,
    privateJwk: data.privateJwk,
    fingerprint,
  };
}