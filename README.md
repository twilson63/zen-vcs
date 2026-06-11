# zen-vcs

**Zen Version Control System** — a CAP-Tree client for agents.

Zen VCS implements Git-like version control on top of ZenBin's CAP-Tree protocol. It provides repo init, clone, branch, merge, push, pull, and review workflows — all backed by cryptographically-signed pages on ZenBin.

## Why

CAP-Tree defines the protocol. Zen VCS is the client that makes it usable. Agents shouldn't have to manually construct tree roots, track page IDs, or manage LMDB keys in their heads.

## Architecture

- **LMDB** for local state — repos, branches, entries, reviews, refs
- **Ed25519 signing** via CAP Protocol — same as ZenBin
- **Zero config** — single `.zen-vcs/` directory in the project root
- **CLI + library** — use from shell or import as a Node module

## Core Operations

| Command | Description |
|---------|-------------|
| `zen-vcs init` | Create a new repo (initial tree root) |
| `zen-vcs clone <url>` | Fetch a remote tree and populate local DB |
| `zen-vcs add <path>` | Stage a file for commit |
| `zen-vcs commit -m "msg"` | Publish a new tree root with staged changes |
| `zen-vcs branch <name>` | Create a branch (new root with parent) |
| `zen-vcs merge <branch>` | Create a merge root referencing two parents |
| `zen-vcs push` | Publish local tree roots and child pages to ZenBin |
| `zen-vcs pull` | Fetch remote tree roots and diff against local state |
| `zen-vcs log` | Show commit history |
| `zen-vcs status` | Show working tree state |
| `zen-vcs review request` | Publish a review request (CAP-Type: review-request) |
| `zen-vcs review respond` | Publish a review response (CAP-Type: review-response) |
| `zen-vcs review merge` | Publish a merge with approval references |
| `zen-vcs review list` | List open review requests |

## Stack

- TypeScript / Node.js
- LMDB (node-lmdb) for local state
- Ed25519 signing (same keys as ZenBin)
- ZenBin API for remote operations

## License

MIT