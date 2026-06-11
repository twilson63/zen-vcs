/**
 * zen-vcs CLI
 *
 * Usage:
 *   zen-vcs init <name>           Create a new repo
 *   zen-vcs clone <rootId> <name> Clone a remote tree
 *   zen-vcs add <path>            Stage a file
 *   zen-vcs commit -m "msg"       Commit staged changes
 *   zen-vcs branch <name>         Create a branch
 *   zen-vcs merge <source>        Merge source branch into current
 *   zen-vcs log                   Show commit history
 *   zen-vcs status                Show working tree status
 *   zen-vcs review request        Publish a review request
 *   zen-vcs review respond        Publish a review response
 *   zen-vcs review list           List open reviews
 */

import { Command } from 'commander';
import { ZenVCS, VcsConfig } from './lib/vcs.js';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DEFAULT_KEYS_PATH = join(homedir(), '.openclaw/workspace/.zenbin-keys.json');
const DEFAULT_REMOTE = 'https://zenbin.org';

async function findConfig(): Promise<VcsConfig> {
  // Walk up from cwd looking for .zen-vcs directory
  let dir = process.cwd();
  while (dir !== '/') {
    if (existsSync(join(dir, '.zen-vcs'))) {
      const configPath = join(dir, '.zen-vcs', 'config.json');
      if (existsSync(configPath)) {
        const config = JSON.parse(readFileSync(configPath, 'utf8'));
        return {
          repoName: config.repoName,
          remoteUrl: config.remoteUrl || DEFAULT_REMOTE,
          keysPath: config.keysPath || DEFAULT_KEYS_PATH,
          dbPath: dir,
        };
      }
    }
    dir = join(dir, '..');
  }
  throw new Error('Not a zen-vcs repo. Run `zen-vcs init` first.');
}

const program = new Command();

program
  .name('zen-vcs')
  .description('Zen Version Control System — CAP-Tree client for agents')
  .version('0.1.0');

program
  .command('init')
  .description('Create a new repo')
  .argument('<name>', 'Repo name')
  .option('-r, --remote <url>', 'ZenBin remote URL', DEFAULT_REMOTE)
  .option('-k, --keys <path>', 'Path to .zenbin-keys.json', DEFAULT_KEYS_PATH)
  .action(async (name, opts) => {
    const config: VcsConfig = {
      repoName: name,
      remoteUrl: opts.remote,
      keysPath: opts.keys,
      dbPath: process.cwd(),
    };

    const vcs = await ZenVCS.init(config);
    try {
      const repo = await vcs.initRepo(name);
      console.log(`✓ Initialized repo "${name}" with root: ${repo.rootId}`);
      console.log(`  Remote: ${opts.remote}`);
      console.log(`  Owner:  ${repo.ownerFingerprint}`);
    } finally {
      await vcs.close();
    }
  });

program
  .command('clone')
  .description('Clone a remote tree')
  .argument('<rootId>', 'Tree root page ID')
  .argument('<name>', 'Local repo name')
  .option('-r, --remote <url>', 'ZenBin remote URL', DEFAULT_REMOTE)
  .option('-k, --keys <path>', 'Path to .zenbin-keys.json', DEFAULT_KEYS_PATH)
  .action(async (rootId, name, opts) => {
    const config: VcsConfig = {
      repoName: name,
      remoteUrl: opts.remote,
      keysPath: opts.keys,
      dbPath: process.cwd(),
    };

    const vcs = await ZenVCS.init(config);
    try {
      const repo = await vcs.cloneRepo(rootId, name);
      console.log(`✓ Cloned repo "${name}" from root: ${rootId}`);
      console.log(`  Owner:  ${repo.ownerFingerprint}`);
    } finally {
      await vcs.close();
    }
  });

program
  .command('add')
  .description('Stage a file for commit')
  .argument('<path>', 'File path (relative)')
  .action(async (filePath) => {
    const config = await findConfig();
    const vcs = await ZenVCS.init(config);
    try {
      await vcs.add(filePath);
      console.log(`✓ Staged: ${filePath}`);
    } finally {
      await vcs.close();
    }
  });

program
  .command('commit')
  .description('Commit staged changes')
  .option('-m, --message <msg>', 'Commit message')
  .option('-b, --branch <name>', 'Branch to commit to', 'main')
  .action(async (opts) => {
    if (!opts.message) throw new Error('Commit message required: -m "message"');
    const config = await findConfig();
    const vcs = await ZenVCS.init(config);
    try {
      const rootId = await vcs.commit(opts.message, opts.branch);
      console.log(`✓ Committed as: ${rootId}`);
      console.log(`  Branch: ${opts.branch}`);
      console.log(`  Message: ${opts.message}`);
    } finally {
      await vcs.close();
    }
  });

program
  .command('branch')
  .description('Create a branch')
  .argument('<name>', 'Branch name')
  .option('--from <branch>', 'Source branch', 'main')
  .action(async (name, opts) => {
    const config = await findConfig();
    const vcs = await ZenVCS.init(config);
    try {
      const branch = await vcs.createBranch(name, opts.from);
      console.log(`✓ Created branch "${name}" from ${opts.from}`);
      console.log(`  Root: ${branch.rootId}`);
    } finally {
      await vcs.close();
    }
  });

program
  .command('merge')
  .description('Merge a branch into current')
  .argument('<source>', 'Source branch name')
  .option('-t, --target <branch>', 'Target branch', 'main')
  .option('-m, --message <msg>', 'Merge message')
  .action(async (source, opts) => {
    const config = await findConfig();
    const vcs = await ZenVCS.init(config);
    try {
      const mergeId = await vcs.merge(source, opts.target, opts.message);
      console.log(`✓ Merged "${source}" into "${opts.target}"`);
      console.log(`  Merge root: ${mergeId}`);
    } finally {
      await vcs.close();
    }
  });

program
  .command('log')
  .description('Show commit history')
  .option('-b, --branch <name>', 'Branch to show', 'main')
  .option('-n, --limit <count>', 'Number of commits', '20')
  .action(async (opts) => {
    const config = await findConfig();
    const vcs = await ZenVCS.init(config);
    try {
      const commits = await vcs.log(opts.branch, parseInt(opts.limit));
      for (const c of commits) {
        console.log(`${c.rootId}  ${c.message}`);
        console.log(`  Date: ${c.timestamp}  Parent: ${c.parentId || '(none)'}`);
      }
    } finally {
      await vcs.close();
    }
  });

program
  .command('status')
  .description('Show working tree status')
  .action(async () => {
    const config = await findConfig();
    const vcs = await ZenVCS.init(config);
    try {
      const status = await vcs.status();
      console.log(`Branch: ${status.branch ?? '(none)'}`);
      console.log(`Staged: ${status.staged} file(s)`);
    } finally {
      await vcs.close();
    }
  });

// Review subcommands
const review = program.command('review').description('Review workflow commands');

review
  .command('request')
  .description('Publish a review request')
  .argument('<references...>', 'Page IDs to review')
  .option('-r, --recipient <fingerprint>', 'Reviewer fingerprint (required)')
  .option('-m, --message <msg>', 'Review request message')
  .action(async (references, opts) => {
    if (!opts.recipient) throw new Error('Recipient fingerprint required: -r <fingerprint>');
    const config = await findConfig();
    const vcs = await ZenVCS.init(config);
    try {
      const id = await vcs.reviewRequest(references, opts.recipient, opts.message);
      console.log(`✓ Review request published: ${id}`);
      console.log(`  References: ${references.join(', ')}`);
      console.log(`  Recipient:  ${opts.recipient}`);
    } finally {
      await vcs.close();
    }
  });

review
  .command('respond')
  .description('Publish a review response')
  .argument('<requestId>', 'Review request page ID')
  .option('-o, --outcome <type>', 'Outcome: approved | changes-requested | commented', 'approved')
  .option('-r, --recipient <fingerprint>', 'Author fingerprint (required)')
  .option('-m, --message <msg>', 'Response message')
  .action(async (requestId, opts) => {
    if (!opts.recipient) throw new Error('Recipient fingerprint required: -r <fingerprint>');
    const config = await findConfig();
    const vcs = await ZenVCS.init(config);
    try {
      const id = await vcs.reviewRespond(
        requestId,
        opts.outcome as 'approved' | 'changes-requested' | 'commented',
        opts.recipient,
        opts.message
      );
      console.log(`✓ Review response published: ${id}`);
      console.log(`  Outcome: ${opts.outcome}`);
    } finally {
      await vcs.close();
    }
  });

review
  .command('list')
  .description('List open reviews')
  .option('-s, --status <status>', 'Filter by status', 'open')
  .action(async (opts) => {
    const config = await findConfig();
    const vcs = await ZenVCS.init(config);
    try {
      const reviews = await (await (vcs as any).db).listReviews(opts.status);
      if (reviews.length === 0) {
        console.log('No open reviews.');
        return;
      }
      for (const r of reviews) {
        console.log(`${r.id}  ${r.type}  ${r.status}`);
        if (r.message) console.log(`  ${r.message}`);
      }
    } finally {
      await vcs.close();
    }
  });

program.parse();