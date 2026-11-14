// The forge's whole state, in process memory: users, repositories, their branches, commits, git
// objects, labels, issues and pull requests. Nothing is persisted and nothing is random: ids come
// from counters and every timestamp comes from MAKEFUN_TRIAL_NOW, so two runs of the same script
// produce the same store and the same responses.
//
// A repository owns its git objects the way a real one does: `objects` is sha -> raw bytes for every
// blob and tree written, `commits` is sha -> the commit plus its full file snapshot, and `branches`
// is branch name -> commit sha. Writing a commit is therefore one pure function of the file map.

import { buildCommitData, buildTree, hashObject, parseCommitData, parseTreeData, type ObjectType, type TreeEntry } from './gitobj.ts';

/** One label a repository defines. */
export interface LabelRecord {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

/** One issue comment. */
export interface CommentRecord {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
}

/** One issue. */
export interface IssueRecord {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  readonly comments: CommentRecord[];
}

/** One pull request. */
export interface PullRecord {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly head: string;
  readonly base: string;
  readonly createdAt: string;
  updatedAt: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  /** The commit the head branch pointed at when the pull was opened or last synced. */
  headSha: string;
  readonly baseSha: string;
}

/** A commit, with the snapshot of every file it carries. */
export interface CommitRecord {
  readonly sha: string;
  readonly tree: string;
  readonly parents: string[];
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly epochSec: number;
  /** path -> bytes at this commit (the tree's whole content). */
  readonly files: Map<string, Buffer>;
}

/** A repository. */
export interface Repo {
  readonly id: number;
  readonly owner: string;
  name: string;
  description: string;
  private: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  pushedAt: string;
  readonly branches: Map<string, string>;
  /** Full ref name (`refs/heads/main`, `refs/tags/v1`) -> object id, for what git pushed. */
  readonly refs: Map<string, string>;
  readonly commits: Map<string, CommitRecord>;
  /** sha -> raw bytes for blobs and trees (commit bodies live in `commits`). */
  readonly objects: Map<string, Buffer>;
  readonly objectTypes: Map<string, ObjectType>;
  readonly labels: Map<string, LabelRecord>;
  readonly issues: IssueRecord[];
  readonly pulls: PullRecord[];
  nextIssue: number;
  nextPull: number;
}

/** The one user this forge serves: the login the bearer token names. */
export interface ForgeUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** Where a path lands in a tree: a file with its blob sha, a directory with its tree sha, or nothing. */
export type PathHit =
  | { readonly kind: 'file'; readonly sha: string; readonly size: number }
  | { readonly kind: 'dir'; readonly sha: string };

/** What writing a commit needs. */
export interface WriteCommitOptions {
  readonly branch: string;
  readonly files: ReadonlyMap<string, Buffer>;
  readonly message: string;
  readonly parents: readonly string[];
}

/** The in-memory forge. */
export class Forge {
  readonly user: ForgeUser;
  readonly token: string;
  /** The trial's fixed clock, ISO-8601, from MAKEFUN_TRIAL_NOW. */
  readonly nowIso: string;
  /** The same instant in whole seconds, for git identities. */
  readonly nowSec: number;
  readonly repos = new Map<string, Repo>();
  private repoIdCounter = 5000;
  private commentIdCounter = 1;

  constructor(options: { login: string; name: string; email: string; token: string; nowIso: string; nowSec: number }) {
    this.user = { id: 1000, login: options.login, name: options.name, email: options.email };
    this.token = options.token;
    this.nowIso = options.nowIso;
    this.nowSec = options.nowSec;
  }

  /** Whether `presented` is the token this forge serves. An empty configured token accepts any value. */
  authenticate(presented: string): boolean {
    if (this.token === '') return true;
    return presented === this.token;
  }

  /** The key a repository is stored under. */
  private static key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(Forge.key(owner, name)) ?? null;
  }

  /** Whether `owner` is this forge's user (any other owner sees nothing, and gets 404, never 403). */
  ownsLogin(owner: string): boolean {
    return owner.toLowerCase() === this.user.login.toLowerCase();
  }

  createRepo(name: string, options: { description?: string; private?: boolean } = {}): Repo | null {
    if (this.getRepo(this.user.login, name) !== null) return null;
    this.repoIdCounter += 1;
    const repo: Repo = {
      id: this.repoIdCounter,
      owner: this.user.login,
      name,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      pushedAt: this.nowIso,
      branches: new Map<string, string>(),
      refs: new Map<string, string>(),
      commits: new Map<string, CommitRecord>(),
      objects: new Map<string, Buffer>(),
      objectTypes: new Map<string, ObjectType>(),
      labels: new Map<string, LabelRecord>(),
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
    };
    this.repos.set(Forge.key(this.user.login, name), repo);
    return repo;
  }

  removeRepo(repo: Repo): void {
    this.repos.delete(Forge.key(repo.owner, repo.name));
  }

  /** This user's repositories, newest first (the order the pagination check walks). */
  listRepos(): Repo[] {
    const all = [...this.repos.values()].filter((repo) => this.ownsLogin(repo.owner));
    return all.sort((a, b) => b.id - a.id);
  }

  /** The next comment id (shared across the forge, as GitHub's are). */
  nextCommentId(): number {
    this.commentIdCounter += 1;
    return this.commentIdCounter;
  }

  /** Write a commit and move `branch` to it. */
  writeCommit(repo: Repo, options: WriteCommitOptions): CommitRecord {
    const tree = buildTree(options.files, {
      blob: (sha, content) => {
        repo.objects.set(sha, content);
        repo.objectTypes.set(sha, 'blob');
      },
      tree: (sha, data) => {
        repo.objects.set(sha, data);
        repo.objectTypes.set(sha, 'tree');
      },
    });
    const data = buildCommitData({
      tree,
      parents: options.parents,
      message: options.message,
      authorName: this.user.name,
      authorEmail: this.user.email,
      epochSec: this.nowSec,
    });
    const sha = hashObject('commit', data);
    repo.objects.set(sha, data);
    repo.objectTypes.set(sha, 'commit');
    const record: CommitRecord = {
      sha,
      tree,
      parents: [...options.parents],
      message: options.message,
      authorName: this.user.name,
      authorEmail: this.user.email,
      epochSec: this.nowSec,
      files: new Map(options.files),
    };
    repo.commits.set(sha, record);
    repo.branches.set(options.branch, sha);
    repo.pushedAt = this.nowIso;
    repo.updatedAt = this.nowIso;
    return record;
  }

  /** The commit a ref names: a branch name, a commit sha, or null. */
  resolveRef(repo: Repo, ref: string | null | undefined): CommitRecord | null {
    if (ref === null || ref === undefined || ref === '') {
      const tip = repo.branches.get(repo.defaultBranch);
      return tip === undefined ? null : (repo.commits.get(tip) ?? null);
    }
    const branchTip = repo.branches.get(ref);
    if (branchTip !== undefined) return repo.commits.get(branchTip) ?? null;
    return repo.commits.get(ref) ?? null;
  }

  /** The files at a ref (empty when the ref has no commit yet). */
  filesAt(repo: Repo, ref: string | null | undefined): Map<string, Buffer> {
    const commit = this.resolveRef(repo, ref);
    return commit === null ? new Map<string, Buffer>() : new Map(commit.files);
  }

  /** Resolve a repository-relative path inside a commit's tree. */
  lookupPath(repo: Repo, commit: CommitRecord, path: string): PathHit | null {
    const parts = path.split('/').filter((part) => part !== '');
    if (parts.length === 0) return { kind: 'dir', sha: commit.tree };
    let treeSha = commit.tree;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index] as string;
      const entries = this.treeEntries(repo, treeSha);
      const found = entries.find((entry) => entry.name === name);
      if (found === undefined) return null;
      const last = index === parts.length - 1;
      if (found.mode === '40000') {
        if (last) return { kind: 'dir', sha: found.sha };
        treeSha = found.sha;
        continue;
      }
      if (!last) return null;
      const content = repo.objects.get(found.sha);
      return { kind: 'file', sha: found.sha, size: content === undefined ? 0 : content.length };
    }
    return null;
  }

  /** The entries of a stored tree. */
  treeEntries(repo: Repo, sha: string): TreeEntry[] {
    const data = repo.objects.get(sha);
    return data === undefined ? [] : parseTreeData(data);
  }

  /** A blob's bytes. */
  blob(repo: Repo, sha: string): Buffer | null {
    return repo.objects.get(sha) ?? null;
  }

  /** Every commit reachable from `start`, newest first, walking parents in order. */
  history(repo: Repo, start: CommitRecord | null): CommitRecord[] {
    if (start === null) return [];
    const out: CommitRecord[] = [];
    const seen = new Set<string>();
    const queue: CommitRecord[] = [start];
    while (queue.length > 0) {
      const next = queue.shift() as CommitRecord;
      if (seen.has(next.sha)) continue;
      seen.add(next.sha);
      out.push(next);
      for (const parent of next.parents) {
        const record = repo.commits.get(parent);
        if (record !== undefined) queue.push(record);
      }
    }
    return out;
  }

  /** The commits a pull request would bring in: head history minus base history. */
  pullCommits(repo: Repo, pull: PullRecord): CommitRecord[] {
    const baseHistory = new Set(this.history(repo, this.resolveRef(repo, pull.base)).map((commit) => commit.sha));
    return this.history(repo, this.resolveRef(repo, pull.headSha === '' ? pull.head : pull.headSha)).filter(
      (commit) => !baseHistory.has(commit.sha),
    );
  }

  /** Read back a commit's raw body (used by the pull-request file diff). */
  parseCommit(repo: Repo, sha: string): CommitRecord | null {
    const record = repo.commits.get(sha);
    if (record !== null && record !== undefined) return record;
    const data = repo.objects.get(sha);
    if (data === undefined) return null;
    const parsed = parseCommitData(data);
    return {
      sha,
      tree: parsed.tree,
      parents: parsed.parents,
      message: parsed.message,
      authorName: parsed.authorName,
      authorEmail: parsed.authorEmail,
      epochSec: parsed.epochSec,
      files: new Map<string, Buffer>(),
    };
  }
}
