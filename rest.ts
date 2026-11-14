// The REST v3 surface: repositories, branches, commits, contents, labels and issues, answered from the
// in-memory forge in store.ts. Every reply is application/json and carries X-GitHub-Request-Id; an
// error is `{"message": string}` with the status GitHub uses for it (401 unauthenticated, 404 not
// found or another owner's repository, 409 a stale blob sha, 422 a body GitHub would reject).
//
// Ownership is the contract's: a repository belongs to the login the bearer token names, so the same
// name under another owner is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashObject, isSha } from './gitobj.ts';
import type { CommitRecord, Forge, IssueRecord, LabelRecord, PullRecord, Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Everything one REST request needs. */
export interface RestRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly forge: Forge;
  readonly requestId: string;
  /** The request's path, still percent-encoded, exactly as `new URL(target).pathname` gives it. */
  readonly pathname: string;
  /** The request's query parameters. */
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly method: string;
  readonly origin: string;
}

// ---------------------------------------------------------------------------------------------
// serialization cache
//
// A GET of an issue rebuilds the same ~1 KB of JSON on every request: an object with twenty-odd
// properties, eight absolute URLs and the viewer's user object, then a stringify of all of it. The
// bytes only change when the issue does, so the text is kept per issue and thrown away the moment
// anything in the store can have moved.
//
// Invalidation is one integer: `noteMutation()` bumps it for every request whose method can write
// (app.ts calls it before dispatch), and a cached text is only reused while the epoch it was built
// under is still the current one. A POST that fails still bumps it — a wasted rebuild, never a stale
// answer. Nothing here touches the bytes: a hit returns the same string a rebuild would produce.

/** The store's mutation epoch: bumped by every request that may write. */
let storeEpoch = 0;

/** Record that a request which may mutate the store is about to run. */
export function noteMutation(): void {
  storeEpoch += 1;
}

/** One issue's serialized body, valid while `epoch` is the store's current epoch and the origin matches. */
interface CachedIssueBody {
  readonly epoch: number;
  readonly origin: string;
  /** The body as bytes: the socket takes it as-is, with no per-request UTF-8 encode. */
  readonly bytes: Buffer;
  readonly length: number;
}

const issueBodyCache = new WeakMap<IssueRecord, CachedIssueBody>();

/** An issue's JSON body as bytes (with the trailing newline sendJson adds), cached per issue. */
function issueBodyOf(forge: Forge, repo: Repo, issue: IssueRecord, origin: string): CachedIssueBody {
  const cached = issueBodyCache.get(issue);
  if (cached !== undefined && cached.epoch === storeEpoch && cached.origin === origin) return cached;
  const bytes = Buffer.from(`${JSON.stringify(issueJson(forge, repo, issue, origin))}\n`, 'utf8');
  const entry: CachedIssueBody = { epoch: storeEpoch, origin, bytes, length: bytes.length };
  issueBodyCache.set(issue, entry);
  return entry;
}

/** The viewer's user object, cached per forge: it never changes, so every issue shares one. */
const userJsonCache = new WeakMap<Forge, { origin: string; json: Json }>();

function cachedUserJson(forge: Forge, origin: string): Json {
  const cached = userJsonCache.get(forge);
  if (cached !== undefined && cached.origin === origin) return cached.json;
  const json = userJson(forge, origin);
  userJsonCache.set(forge, { origin, json });
  return json;
}

type Json = Record<string, unknown>;

/** Answer with JSON, always with the request-id header. */
function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

/** Answer with no body (204), keeping the request id. */
function sendEmpty(res: ServerResponse, requestId: string, status: number): void {
  res.writeHead(status, { 'content-length': 0, 'x-github-request-id': requestId });
  res.end();
}

/** A JSON error body with a string message. */
function sendError(res: ServerResponse, requestId: string, status: number, message: string, extra: Json = {}): void {
  sendJson(res, requestId, status, { message, ...extra });
}

function asObject(value: unknown): Json | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Json;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Standard base64 of bytes, as the contents API encodes a file. */
function encodeBase64(content: Buffer): string {
  return content.toString('base64');
}

/** Decode the contents API's base64, ignoring the whitespace GitHub wraps it at. */
function decodeBase64(text: string): Buffer {
  return Buffer.from(text.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
}

/** The decoded path segments of a request, after the /api/v3 prefix. */
export function restSegments(pathname: string): string[] {
  const prefix = '/api/v3';
  let rest = pathname;
  if (rest === prefix) rest = '';
  else if (rest.startsWith(`${prefix}/`)) rest = rest.slice(prefix.length);
  const out: string[] = [];
  for (const raw of rest.split('/')) {
    if (raw === '') continue;
    try {
      out.push(decodeURIComponent(raw));
    } catch {
      out.push(raw);
    }
  }
  return out;
}

/** The bearer token a request presents, or null. */
export function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  // The shape every client sends: "Bearer <token>", one space, no surrounding whitespace. It reads
  // the same token the pattern below would; anything else takes the pattern.
  if (header.length > 7 && header.startsWith('Bearer ')) {
    const token = header.slice(7);
    const last = token.charCodeAt(token.length - 1);
    if (token.charCodeAt(0) > 32 && last > 32 && token.indexOf(' ') < 0 && token.indexOf('\t') < 0) return token;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (match === null) return null;
  const token = (match[1] ?? '').trim();
  return token === '' ? null : token;
}

/** An integer query parameter with a default and a range. */
function intParam(query: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Split a list into a page and report whether another page follows. */
function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; perPage: number; pageNumber: number; hasNext: boolean } {
  const perPage = intParam(query, 'per_page', 30, 1, 100);
  const pageNumber = intParam(query, 'page', 1, 1, 1_000_000);
  const start = (pageNumber - 1) * perPage;
  return { page: items.slice(start, start + perPage), perPage, pageNumber, hasNext: start + perPage < items.length };
}

/** The `Link` header for a paginated list, absolute on this origin. */
function linkHeader(origin: string, path: string, query: URLSearchParams, pageNumber: number, perPage: number, total: number, hasNext: boolean): string | null {
  const urlFor = (page: number): string => {
    const params = new URLSearchParams();
    for (const [key, value] of query) if (key !== 'page' && key !== 'per_page') params.append(key, value);
    params.set('per_page', String(perPage));
    params.set('page', String(page));
    return `${origin}${path}?${params.toString()}`;
  };
  const parts: string[] = [];
  if (hasNext) parts.push(`<${urlFor(pageNumber + 1)}>; rel="next"`);
  if (pageNumber > 1) {
    parts.push(`<${urlFor(pageNumber - 1)}>; rel="prev"`);
    parts.push(`<${urlFor(1)}>; rel="first"`);
  }
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  if (lastPage > pageNumber) parts.push(`<${urlFor(lastPage)}>; rel="last"`);
  return parts.length === 0 ? null : parts.join(', ');
}

// ---------------------------------------------------------------------------------------------
// JSON shapes

/** A repository as GitHub renders it. */
function repoJson(forge: Forge, repo: Repo, origin: string): Json {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(forge, origin),
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    forks_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/forks`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://${hostOf(origin)}/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@${hostOf(origin)}:${repo.owner}/${repo.name}.git`,
    clone_url: `${origin}/${repo.owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    open_issues: repo.issues.filter((issue) => issue.state === 'open').length,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: 0,
    language: null,
  };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return 'localhost';
  }
}

/** The token's user as GitHub renders it. */
function userJson(forge: Forge, origin: string): Json {
  return {
    login: forge.user.login,
    id: forge.user.id,
    node_id: `U_${forge.user.id}`,
    avatar_url: `${origin}/avatars/u/${forge.user.id}`,
    gravatar_id: '',
    url: `${origin}/api/v3/users/${forge.user.login}`,
    html_url: `${origin}/${forge.user.login}`,
    type: 'User',
    site_admin: false,
    name: forge.user.name,
  };
}

/** A commit as GitHub renders it. */
function commitJson(forge: Forge, repo: Repo, record: CommitRecord, origin: string): Json {
  const iso = new Date(record.epochSec * 1000).toISOString();
  return {
    sha: record.sha,
    node_id: `C_${record.sha}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${record.sha}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/commit/${record.sha}`,
    commit: {
      author: { name: record.authorName, email: record.authorEmail, date: iso },
      committer: { name: record.authorName, email: record.authorEmail, date: iso },
      message: record.message,
      tree: { sha: record.tree, url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${record.tree}` },
      comment_count: 0,
      verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    author: userJson(forge, origin),
    committer: userJson(forge, origin),
    parents: record.parents.map((sha) => ({
      sha,
      url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
      html_url: `${origin}/${repo.owner}/${repo.name}/commit/${sha}`,
    })),
  };
}

/** A label as GitHub renders it. */
function labelJson(repo: Repo, label: LabelRecord, origin: string): Json {
  return {
    id: labelIdOf(repo, label.name),
    node_id: `L_${labelIdOf(repo, label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description === '' ? null : label.description,
    default: false,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
  };
}

/** A stable numeric id for a label, from its position in the repository's label table. */
function labelIdOf(repo: Repo, name: string): number {
  const names = [...repo.labels.keys()];
  const index = names.indexOf(name);
  return 1_000_000 + (index < 0 ? 0 : index);
}

/** An issue as GitHub renders it. */
function issueJson(forge: Forge, repo: Repo, issue: IssueRecord, origin: string): Json {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    labels: issue.labels.map((name) => labelJson(repo, repo.labels.get(name) ?? { name, color: 'ededed', description: '' }, origin)),
    user: cachedUserJson(forge, origin),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    comments_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
  };
}

/** A pull request as GitHub renders it. */
function pullJson(forge: Forge, repo: Repo, pull: PullRecord, origin: string): Json {
  const headCommit = repo.commits.get(pull.headSha);
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    draft: false,
    merged: pull.merged,
    mergeable: pull.state === 'open',
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(forge, origin),
    labels: [],
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : null,
    head: {
      label: `${repo.owner}:${pull.head}`,
      ref: pull.head,
      sha: pull.headSha,
      user: userJson(forge, origin),
      repo: repoJson(forge, repo, origin),
    },
    base: {
      label: `${repo.owner}:${pull.base}`,
      ref: pull.base,
      sha: pull.baseSha,
      user: userJson(forge, origin),
      repo: repoJson(forge, repo, origin),
    },
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}.patch`,
    statuses_url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/statuses/${pull.headSha}`,
    _head_commit_message: headCommit === undefined ? null : headCommit.message,
  };
}

// ---------------------------------------------------------------------------------------------
// the router

/** A path segment as restSegments decodes it: percent-decoded when it holds an escape, else as-is. */
function decodeSegment(raw: string): string {
  if (raw.indexOf('%') < 0) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** `/api/v3/repos/<owner>/<repo>/issues/<digits>` with nothing after the number. */
interface IssueGetHit {
  readonly owner: string;
  readonly repo: string;
  readonly number: number;
}

/**
 * The issue-GET shape of `pathname`, or null when the path is anything else. Only the exact strict
 * shape matches — a trailing slash, a query-looking tail, a non-digit number, an empty owner or repo
 * name all return null, and the router answers those the way it always has.
 */
function issueGetMatch(pathname: string): IssueGetHit | null {
  const start = 14; // after '/api/v3/repos/'
  const length = pathname.length;
  const ownerEnd = pathname.indexOf('/', start);
  if (ownerEnd <= start) return null;
  const repoEnd = pathname.indexOf('/', ownerEnd + 1);
  if (repoEnd <= ownerEnd + 1) return null;
  // '/issues/' then digits to the end
  if (pathname.slice(repoEnd + 1, repoEnd + 8) !== 'issues/') return null;
  const digitsAt = repoEnd + 8;
  if (digitsAt >= length) return null;
  let number = 0;
  for (let index = digitsAt; index < length; index += 1) {
    const code = pathname.charCodeAt(index);
    if (code < 48 || code > 57) return null;
    number = number * 10 + (code - 48);
    if (number > 2 ** 52) return null;
  }
  return {
    owner: decodeSegment(pathname.slice(start, ownerEnd)),
    repo: decodeSegment(pathname.slice(ownerEnd + 1, repoEnd)),
    number,
  };
}

/**
 * The issue-GET route, end to end: the same checks in the same order the router makes them (token,
 * owner, repository, issue), then the cached body with its own header block.
 */
function serveIssueGet(rest: RestRequest, hit: IssueGetHit): void {
  const { req, res, forge, requestId } = rest;
  const token = bearerOf(req);
  if (token === null) return sendError(res, requestId, 401, 'Requires authentication');
  if (!forge.authenticate(token)) return sendError(res, requestId, 401, 'Bad credentials');
  if (!forge.ownsLogin(hit.owner)) return sendError(res, requestId, 404, 'Not Found');
  const repo = forge.getRepo(hit.owner, hit.repo);
  if (repo === null) return sendError(res, requestId, 404, 'Not Found');
  const issues = repo.issues;
  let issue: IssueRecord | undefined;
  for (let index = 0; index < issues.length; index += 1) {
    const candidate = issues[index] as IssueRecord;
    if (candidate.number === hit.number) {
      issue = candidate;
      break;
    }
  }
  if (issue === undefined) return sendError(res, requestId, 404, 'Not Found');
  const body = issueBodyOf(forge, repo, issue, rest.origin);
  // The raw header list: Node writes it out without validating or re-keying an object per request.
  res.writeHead(200, ['content-type', JSON_TYPE, 'content-length', body.length, 'x-github-request-id', requestId]);
  res.end(body.bytes);
}

/** Answer one /api/v3 request. */
export function handleRest(rest: RestRequest): void {
  const { req, res, forge, requestId, method } = rest;
  const pathname = rest.pathname;

  // The hot route: a GET of one issue, which is most of what the read workload asks for. It is
  // matched on the raw path and answered from the serialization cache, without building the segment
  // list. Every other shape of that path (a trailing slash, a non-numeric number, another method)
  // falls through to the router below and gets the answer it already gets.
  if (method === 'GET' && pathname.charCodeAt(14) === 114 /* r: /api/v3/repos/ */) {
    const hit = issueGetMatch(pathname);
    if (hit !== null) return serveIssueGet(rest, hit);
  }

  const segments = restSegments(pathname);
  const query = rest.query;

  // The API root and /meta are readable without a token, as they are on api.github.com.
  if (segments.length === 0) {
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, requestId, 404, 'Not Found');
    return sendJson(
      res,
      requestId,
      200,
      {
        current_user_url: `${rest.origin}/api/v3/user`,
        current_user_authorizations_html_url: `${rest.origin}/settings/connections/applications{/client_id}`,
        authorizations_url: `${rest.origin}/api/v3/authorizations`,
        repository_url: `${rest.origin}/api/v3/repos/{owner}/{repo}`,
        user_repositories_url: `${rest.origin}/api/v3/user/repos{?type,page,per_page,sort}`,
        rate_limit_url: `${rest.origin}/api/v3/rate_limit`,
        emojis_url: `${rest.origin}/api/v3/emojis`,
      },
      { 'x-oauth-scopes': 'repo, read:org', 'x-github-media-type': 'github.v3; format=json' },
    );
  }

  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET' && method !== 'HEAD') return sendError(res, requestId, 404, 'Not Found');
    return sendJson(res, requestId, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      installed_version: 'forge-1.0.0',
    });
  }

  const token = bearerOf(req);
  if (token === null) return sendError(res, requestId, 401, 'Requires authentication');
  if (!forge.authenticate(token)) return sendError(res, requestId, 401, 'Bad credentials');

  const [head, ...tail] = segments;

  if (head === 'user') {
    if (tail.length === 0) {
      if (method !== 'GET') return sendError(res, requestId, 404, 'Not Found');
      return sendJson(res, requestId, 200, userJson(forge, rest.origin));
    }
    if (tail.length === 1 && tail[0] === 'repos') {
      if (method === 'GET') return listUserRepos(rest, query);
      if (method === 'POST') return createUserRepo(rest);
      return sendError(res, requestId, 404, 'Not Found');
    }
    return sendError(res, requestId, 404, 'Not Found');
  }

  if (head === 'rate_limit') {
    return sendJson(res, requestId, 200, {
      resources: {
        core: { limit: 5000, remaining: 5000, reset: forge.nowSec, used: 0 },
        search: { limit: 30, remaining: 30, reset: forge.nowSec, used: 0 },
        graphql: { limit: 5000, remaining: 5000, reset: forge.nowSec, used: 0 },
      },
      rate: { limit: 5000, remaining: 5000, reset: forge.nowSec, used: 0 },
    });
  }

  if (head !== 'repos') return sendError(res, requestId, 404, 'Not Found');

  const owner = tail[0];
  const name = tail[1];
  if (owner === undefined || name === undefined) return sendError(res, requestId, 404, 'Not Found');
  // Another owner's repository is not this token's to read: 404, never 403.
  if (!forge.ownsLogin(owner)) return sendError(res, requestId, 404, 'Not Found');
  const repo = forge.getRepo(owner, name);
  if (repo === null) return sendError(res, requestId, 404, 'Not Found');
  const rest2 = tail.slice(2);

  if (rest2.length === 0) {
    if (method === 'GET' || method === 'HEAD') return sendJson(res, requestId, 200, repoJson(forge, repo, rest.origin));
    if (method === 'PATCH') return patchRepo(rest, repo);
    if (method === 'DELETE') {
      forge.removeRepo(repo);
      return sendEmpty(res, requestId, 204);
    }
    return sendError(res, requestId, 404, 'Not Found');
  }

  const [section, ...sub] = rest2;
  switch (section) {
    case 'branches':
      if (method === 'GET') return listBranches(rest, repo);
      return sendError(res, requestId, 404, 'Not Found');
    case 'commits':
      if (method === 'GET') return listCommits(rest, repo, sub, query);
      return sendError(res, requestId, 404, 'Not Found');
    case 'contents':
      return handleContents(rest, repo, sub);
    case 'git':
      return handleGit(rest, repo, sub);
    case 'labels':
      return handleLabels(rest, repo, sub);
    case 'issues':
      return handleIssues(rest, repo, sub, query);
    case 'pulls':
      return handlePulls(rest, repo, sub, query);
    case 'readme':
      if (method === 'GET') return readme(rest, repo);
      return sendError(res, requestId, 404, 'Not Found');
    case 'collaborators':
    case 'assignees':
      if (method === 'GET') return sendJson(res, requestId, 200, []);
      return sendError(res, requestId, 404, 'Not Found');
    default:
      return sendError(res, requestId, 404, 'Not Found');
  }
}

// ---------------------------------------------------------------------------------------------
// repositories

function listUserRepos(rest: RestRequest, query: URLSearchParams): void {
  const all = rest.forge.listRepos();
  const page = paginate(all, query);
  const headers: Record<string, string> = {};
  const link = linkHeader(rest.origin, '/api/v3/user/repos', query, page.pageNumber, page.perPage, all.length, page.hasNext);
  if (link !== null) headers.link = link;
  sendJson(
    rest.res,
    rest.requestId,
    200,
    page.page.map((repo) => repoJson(rest.forge, repo, rest.origin)),
    headers,
  );
}

function createUserRepo(rest: RestRequest): void {
  const body = asObject(rest.body);
  if (body === null) return sendError(rest.res, rest.requestId, 400, 'Problems parsing JSON');
  const name = asString(body.name)?.trim() ?? '';
  if (name === '' || name.length > 100 || !/^[A-Za-z0-9._-]+$/.test(name)) {
    return sendError(rest.res, rest.requestId, 422, 'Repository creation failed.', {
      errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name is invalid' }],
    });
  }
  const description = asString(body.description) ?? '';
  const isPrivate = typeof body.private === 'boolean' ? body.private : false;
  const repo = rest.forge.createRepo(name, { description, private: isPrivate });
  if (repo === null) {
    return sendError(rest.res, rest.requestId, 422, 'Repository creation failed.', {
      errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }],
    });
  }
  sendJson(rest.res, rest.requestId, 201, repoJson(rest.forge, repo, rest.origin), {
    location: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}`,
  });
}

function patchRepo(rest: RestRequest, repo: Repo): void {
  const body = asObject(rest.body) ?? {};
  const description = asString(body.description);
  if (description !== null) repo.description = description;
  const isPrivate = typeof body.private === 'boolean' ? body.private : null;
  if (isPrivate !== null) repo.private = isPrivate;
  const rename = asString(body.name);
  if (rename !== null && rename !== '' && rename !== repo.name) {
    rest.forge.removeRepo(repo);
    const renamed = rest.forge.createRepo(rename, { description: repo.description, private: repo.private });
    if (renamed === null) {
      rest.forge.repos.set(`${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`, repo);
      return sendError(rest.res, rest.requestId, 422, 'Repository creation failed.');
    }
    for (const [branch, sha] of repo.branches) renamed.branches.set(branch, sha);
    for (const [ref, sha] of repo.refs) renamed.refs.set(ref, sha);
    for (const [sha, content] of repo.objects) renamed.objects.set(sha, content);
    for (const [sha, type] of repo.objectTypes) renamed.objectTypes.set(sha, type);
    for (const [sha, record] of repo.commits) renamed.commits.set(sha, record);
    for (const [label, record] of repo.labels) renamed.labels.set(label, record);
    renamed.issues.push(...repo.issues);
    renamed.pulls.push(...repo.pulls);
    renamed.nextIssue = repo.nextIssue;
    renamed.nextPull = repo.nextPull;
    return sendJson(rest.res, rest.requestId, 200, repoJson(rest.forge, renamed, rest.origin));
  }
  repo.updatedAt = rest.forge.nowIso;
  sendJson(rest.res, rest.requestId, 200, repoJson(rest.forge, repo, rest.origin));
}

function listBranches(rest: RestRequest, repo: Repo): void {
  const names = [...repo.branches.keys()].sort((a, b) => {
    if (a === repo.defaultBranch) return -1;
    if (b === repo.defaultBranch) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const branches = names.map((name) => {
    const sha = repo.branches.get(name) as string;
    return {
      name,
      commit: {
        sha,
        url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
      },
      protected: false,
      protection: { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [] } },
      protection_url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(name)}/protection`,
    };
  });
  sendJson(rest.res, rest.requestId, 200, branches);
}

function listCommits(rest: RestRequest, repo: Repo, sub: string[], query: URLSearchParams): void {
  const ref = query.get('sha') ?? query.get('ref') ?? (sub.length > 0 ? sub.join('/') : null);
  const commit = rest.forge.resolveRef(repo, ref);
  if (commit === null) {
    if (sub.length > 0 || ref !== null) return sendError(rest.res, rest.requestId, 404, 'Not Found');
    return sendJson(rest.res, rest.requestId, 200, []);
  }
  if (sub.length > 0) return sendJson(rest.res, rest.requestId, 200, commitJson(rest.forge, repo, commit, rest.origin));
  const history = rest.forge.history(repo, commit);
  const page = paginate(history, query);
  sendJson(
    rest.res,
    rest.requestId,
    200,
    page.page.map((record) => commitJson(rest.forge, repo, record, rest.origin)),
  );
}

function readme(rest: RestRequest, repo: Repo): void {
  const commit = rest.forge.resolveRef(repo, null);
  if (commit === null) return sendError(rest.res, rest.requestId, 404, 'Not Found');
  const hit = rest.forge.lookupPath(repo, commit, 'README.md');
  if (hit === null || hit.kind !== 'file') return sendError(rest.res, rest.requestId, 404, 'Not Found');
  const content = rest.forge.blob(repo, hit.sha) ?? Buffer.alloc(0);
  sendJson(rest.res, rest.requestId, 200, {
    type: 'file',
    encoding: 'base64',
    size: content.length,
    name: 'README.md',
    path: 'README.md',
    content: encodeBase64(content),
    sha: hit.sha,
  });
}

// ---------------------------------------------------------------------------------------------
// contents

function handleContents(rest: RestRequest, repo: Repo, sub: string[]): void {
  const path = sub.join('/');
  const method = rest.method;
  if (method === 'GET' || method === 'HEAD') return getContents(rest, repo, path);
  if (method === 'PUT') return putContents(rest, repo, path);
  if (method === 'DELETE') return deleteContents(rest, repo, path);
  return sendError(rest.res, rest.requestId, 404, 'Not Found');
}

function getContents(rest: RestRequest, repo: Repo, path: string): void {
  const ref = rest.query.get('ref');
  const commit = rest.forge.resolveRef(repo, ref);
  if (commit === null) return sendError(rest.res, rest.requestId, 404, 'Not Found');
  const hit = rest.forge.lookupPath(repo, commit, path);
  if (hit === null) return sendError(rest.res, rest.requestId, 404, 'Not Found');
  if (hit.kind === 'file') {
    const content = rest.forge.blob(repo, hit.sha) ?? Buffer.alloc(0);
    const name = path.split('/').filter((part) => part !== '').pop() ?? path;
    return sendJson(rest.res, rest.requestId, 200, {
      type: 'file',
      encoding: 'base64',
      size: content.length,
      name,
      path,
      content: encodeBase64(content),
      sha: hit.sha,
      url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}`,
      git_url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${hit.sha}`,
      html_url: `${rest.origin}/${repo.owner}/${repo.name}/blob/${commit.sha}/${encodePath(path)}`,
      download_url: `${rest.origin}/${repo.owner}/${repo.name}/raw/${commit.sha}/${encodePath(path)}`,
      target: undefined,
      submodule_git_url: undefined,
    });
  }
  const entries = rest.forge.treeEntries(repo, hit.sha);
  const listed = entries
    .map((entry) => {
      const entryPath = path === '' ? entry.name : `${path}/${entry.name}`;
      const isDir = entry.mode === '40000';
      const content = isDir ? null : (rest.forge.blob(repo, entry.sha) ?? Buffer.alloc(0));
      return {
        type: isDir ? 'dir' : 'file',
        size: content === null ? 0 : content.length,
        name: entry.name,
        path: entryPath,
        sha: entry.sha,
        url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodePath(entryPath)}`,
        git_url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.sha}`,
        html_url: `${rest.origin}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${commit.sha}/${encodePath(entryPath)}`,
        download_url: isDir ? null : `${rest.origin}/${repo.owner}/${repo.name}/raw/${commit.sha}/${encodePath(entryPath)}`,
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  sendJson(rest.res, rest.requestId, 200, listed);
}

/** Percent-encode each segment of a repository path, keeping the slashes. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function putContents(rest: RestRequest, repo: Repo, path: string): void {
  const body = asObject(rest.body);
  if (body === null) return sendError(rest.res, rest.requestId, 400, 'Problems parsing JSON');
  if (path === '') return sendError(rest.res, rest.requestId, 422, 'Invalid request: a file path is required');
  const encoded = asString(body.content);
  if (encoded === null) return sendError(rest.res, rest.requestId, 422, 'Invalid request: content is required');
  const message = asString(body.message) ?? `Update ${path}`;
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const claimedSha = asString(body.sha);

  if (branch !== repo.defaultBranch && !repo.branches.has(branch)) {
    return sendError(rest.res, rest.requestId, 404, 'Branch not found');
  }
  const parent = rest.forge.resolveRef(repo, branch);
  const current = rest.forge.filesAt(repo, branch);
  const existing = current.get(path);
  const existingSha = existing === undefined ? null : hashObject('blob', existing);

  if (claimedSha !== null && claimedSha !== '') {
    if (existingSha === null) {
      return sendError(rest.res, rest.requestId, 409, `${path} does not match ${claimedSha}`);
    }
    if (claimedSha.toLowerCase() !== existingSha.toLowerCase()) {
      return sendError(rest.res, rest.requestId, 409, `${path} does not match ${claimedSha}`);
    }
  }

  const content = decodeBase64(encoded);
  const files = new Map(current);
  files.set(path, content);
  const record = rest.forge.writeCommit(repo, {
    branch,
    files,
    message,
    parents: parent === null ? [] : [parent.sha],
  });
  const blobSha = hashObject('blob', content);
  const status = existing === undefined ? 201 : 200;
  sendJson(rest.res, rest.requestId, status, {
    content: {
      name: path.split('/').filter((part) => part !== '').pop() ?? path,
      path,
      sha: blobSha,
      size: content.length,
      url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${encodePath(path)}`,
      html_url: `${rest.origin}/${repo.owner}/${repo.name}/blob/${record.sha}/${encodePath(path)}`,
      git_url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`,
      download_url: `${rest.origin}/${repo.owner}/${repo.name}/raw/${record.sha}/${encodePath(path)}`,
      type: 'file',
      content: encodeBase64(content),
      encoding: 'base64',
    },
    commit: commitJson(rest.forge, repo, record, rest.origin),
  });
}

function deleteContents(rest: RestRequest, repo: Repo, path: string): void {
  const body = asObject(rest.body) ?? {};
  const branch = asString(body.branch) ?? repo.defaultBranch;
  const claimedSha = asString(body.sha);
  if (branch !== repo.defaultBranch && !repo.branches.has(branch)) {
    return sendError(rest.res, rest.requestId, 404, 'Branch not found');
  }
  const parent = rest.forge.resolveRef(repo, branch);
  const current = rest.forge.filesAt(repo, branch);
  const existing = current.get(path);
  if (existing === undefined) return sendError(rest.res, rest.requestId, 404, 'Not Found');
  const existingSha = hashObject('blob', existing);
  if (claimedSha !== null && claimedSha !== '' && claimedSha.toLowerCase() !== existingSha.toLowerCase()) {
    return sendError(rest.res, rest.requestId, 409, `${path} does not match ${claimedSha}`);
  }
  const files = new Map(current);
  files.delete(path);
  const message = asString(body.message) ?? `Delete ${path}`;
  const record = rest.forge.writeCommit(repo, {
    branch,
    files,
    message,
    parents: parent === null ? [] : [parent.sha],
  });
  sendJson(rest.res, rest.requestId, 200, {
    content: null,
    commit: commitJson(rest.forge, repo, record, rest.origin),
  });
}

// ---------------------------------------------------------------------------------------------
// git refs, trees and blobs (the REST side of the object store)

function handleGit(rest: RestRequest, repo: Repo, sub: string[]): void {
  const [kind, ...args] = sub;
  if (kind === 'refs') {
    if (args.length === 0) {
      if (rest.method === 'GET') {
        const refs = [...repo.branches.entries()].map(([branch, sha]) => ({
          ref: `refs/heads/${branch}`,
          node_id: `REF_${sha}`,
          url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${encodeURIComponent(branch)}`,
          object: { type: 'commit', sha, url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
        }));
        return sendJson(rest.res, rest.requestId, 200, refs);
      }
      if (rest.method === 'POST') return createRef(rest, repo);
      return sendError(rest.res, rest.requestId, 404, 'Not Found');
    }
    return sendError(rest.res, rest.requestId, 404, 'Not Found');
  }
  if (kind === 'trees' && args.length === 1) {
    const sha = args[0] as string;
    const entries = repo.objects.has(sha) ? rest.forge.treeEntries(repo, sha) : null;
    if (entries === null) return sendError(rest.res, rest.requestId, 404, 'Not Found');
    return sendJson(rest.res, rest.requestId, 200, {
      sha,
      url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${sha}`,
      tree: entries.map((entry) => ({
        path: entry.name,
        mode: entry.mode,
        type: entry.mode === '40000' ? 'tree' : 'blob',
        sha: entry.sha,
        size: entry.mode === '40000' ? undefined : (repo.objects.get(entry.sha) ?? Buffer.alloc(0)).length,
        url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.sha}`,
      })),
      truncated: false,
    });
  }
  if (kind === 'blobs' && args.length === 1) {
    const sha = args[0] as string;
    const content = repo.objects.get(sha);
    if (content === undefined) return sendError(rest.res, rest.requestId, 404, 'Not Found');
    return sendJson(rest.res, rest.requestId, 200, { sha, size: content.length, content: encodeBase64(content), encoding: 'base64' });
  }
  if (kind === 'commits' && args.length === 1) {
    const record = rest.forge.parseCommit(repo, args[0] as string);
    if (record === null) return sendError(rest.res, rest.requestId, 404, 'Not Found');
    return sendJson(rest.res, rest.requestId, 200, commitJson(rest.forge, repo, record, rest.origin));
  }
  return sendError(rest.res, rest.requestId, 404, 'Not Found');
}

function createRef(rest: RestRequest, repo: Repo): void {
  const body = asObject(rest.body);
  if (body === null) return sendError(rest.res, rest.requestId, 400, 'Problems parsing JSON');
  const ref = asString(body.ref) ?? '';
  const sha = asString(body.sha) ?? '';
  if (!ref.startsWith('refs/heads/') || ref.length <= 'refs/heads/'.length) {
    return sendError(rest.res, rest.requestId, 422, 'Reference update failed', {
      errors: [{ resource: 'GitRef', field: 'ref', code: 'custom' }],
    });
  }
  if (!isSha(sha) || !repo.commits.has(sha.toLowerCase())) {
    return sendError(rest.res, rest.requestId, 422, 'Object does not exist', {
      errors: [{ resource: 'GitRef', field: 'sha', code: 'custom' }],
    });
  }
  const branch = ref.slice('refs/heads/'.length);
  repo.branches.set(branch, sha.toLowerCase());
  sendJson(rest.res, rest.requestId, 201, {
    ref,
    node_id: `REF_${sha.toLowerCase()}`,
    url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/heads/${encodeURIComponent(branch)}`,
    object: {
      type: 'commit',
      sha: sha.toLowerCase(),
      url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha.toLowerCase()}`,
    },
  });
}

// ---------------------------------------------------------------------------------------------
// labels

function handleLabels(rest: RestRequest, repo: Repo, sub: string[]): void {
  if (sub.length === 0) {
    if (rest.method === 'GET') {
      return sendJson(
        rest.res,
        rest.requestId,
        200,
        [...repo.labels.values()].map((label) => labelJson(repo, label, rest.origin)),
      );
    }
    if (rest.method === 'POST') return createLabel(rest, repo);
    return sendError(rest.res, rest.requestId, 404, 'Not Found');
  }
  const name = sub.join('/');
  const label = repo.labels.get(name);
  if (label === undefined) return sendError(rest.res, rest.requestId, 404, 'Not Found');
  if (rest.method === 'GET') return sendJson(rest.res, rest.requestId, 200, labelJson(repo, label, rest.origin));
  if (rest.method === 'DELETE') {
    repo.labels.delete(name);
    return sendEmpty(rest.res, rest.requestId, 204);
  }
  return sendError(rest.res, rest.requestId, 404, 'Not Found');
}

function createLabel(rest: RestRequest, repo: Repo): void {
  const body = asObject(rest.body);
  if (body === null) return sendError(rest.res, rest.requestId, 400, 'Problems parsing JSON');
  const name = asString(body.name)?.trim() ?? '';
  if (name === '') {
    return sendError(rest.res, rest.requestId, 422, 'Validation Failed', {
      errors: [{ resource: 'Label', field: 'name', code: 'missing_field' }],
    });
  }
  const color = (asString(body.color) ?? 'ededed').replace(/^#/, '');
  const description = asString(body.description) ?? '';
  const label: LabelRecord = { name, color, description };
  repo.labels.set(name, label);
  sendJson(rest.res, rest.requestId, 201, labelJson(repo, label, rest.origin));
}

// ---------------------------------------------------------------------------------------------
// issues

/** The label names a create/patch body asks for, or null when it names none. */
function labelNamesOf(body: Json): string[] | null {
  const raw = body.labels;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else {
      const object = asObject(item);
      const name = object === null ? null : asString(object.name);
      if (name !== null) names.push(name);
    }
  }
  return names;
}

function handleIssues(rest: RestRequest, repo: Repo, sub: string[], query: URLSearchParams): void {
  if (sub.length === 0) {
    if (rest.method === 'GET') return listIssues(rest, repo, query);
    if (rest.method === 'POST') return createIssue(rest, repo);
    return sendError(rest.res, rest.requestId, 404, 'Not Found');
  }
  const number = Number.parseInt(sub[0] as string, 10);
  if (!Number.isFinite(number)) return sendError(rest.res, rest.requestId, 404, 'Not Found');
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return sendError(rest.res, rest.requestId, 404, 'Not Found');
  if (sub.length === 1) {
    if (rest.method === 'GET') return sendJson(rest.res, rest.requestId, 200, issueJson(rest.forge, repo, issue, rest.origin));
    if (rest.method === 'PATCH') return patchIssue(rest, repo, issue);
    return sendError(rest.res, rest.requestId, 404, 'Not Found');
  }
  if (sub.length === 2 && sub[1] === 'comments') {
    if (rest.method === 'GET') {
      return sendJson(
        rest.res,
        rest.requestId,
        200,
        issue.comments.map((comment) => ({
          id: comment.id,
          node_id: `IC_${comment.id}`,
          body: comment.body,
          user: userJson(rest.forge, rest.origin),
          created_at: comment.createdAt,
          updated_at: comment.createdAt,
          url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
          html_url: `${rest.origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
          issue_url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
        })),
      );
    }
    if (rest.method === 'POST') {
      const body = asObject(rest.body);
      if (body === null) return sendError(rest.res, rest.requestId, 400, 'Problems parsing JSON');
      const text = asString(body.body);
      if (text === null) {
        return sendError(rest.res, rest.requestId, 422, 'Validation Failed', {
          errors: [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }],
        });
      }
      const id = rest.forge.nextCommentId();
      const comment = { id, body: text, createdAt: rest.forge.nowIso };
      issue.comments.push(comment);
      issue.updatedAt = rest.forge.nowIso;
      return sendJson(rest.res, rest.requestId, 201, {
        id,
        node_id: `IC_${id}`,
        body: comment.body,
        user: userJson(rest.forge, rest.origin),
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
        url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${id}`,
        html_url: `${rest.origin}/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${id}`,
        issue_url: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
      });
    }
    return sendError(rest.res, rest.requestId, 404, 'Not Found');
  }
  return sendError(rest.res, rest.requestId, 404, 'Not Found');
}

function listIssues(rest: RestRequest, repo: Repo, query: URLSearchParams): void {
  const state = (query.get('state') ?? 'open').toLowerCase();
  let issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  const labelFilter = query.get('labels');
  if (labelFilter !== null && labelFilter !== '') {
    const wanted = labelFilter.split(',').map((name) => name.trim()).filter((name) => name !== '');
    issues = issues.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
  }
  const sort = (query.get('sort') ?? 'created').toLowerCase();
  const direction = (query.get('direction') ?? 'desc').toLowerCase();
  const sorted = [...issues].sort((a, b) => {
    if (sort === 'comments') return a.comments.length - b.comments.length || a.number - b.number;
    if (sort === 'updated') return a.number - b.number;
    return a.number - b.number;
  });
  const ordered = direction === 'asc' ? sorted : [...sorted].reverse();
  const page = paginate(ordered, query);
  sendJson(
    rest.res,
    rest.requestId,
    200,
    page.page.map((issue) => issueJson(rest.forge, repo, issue, rest.origin)),
  );
}

function createIssue(rest: RestRequest, repo: Repo): void {
  const body = asObject(rest.body);
  if (body === null) return sendError(rest.res, rest.requestId, 400, 'Problems parsing JSON');
  const title = asString(body.title)?.trim() ?? '';
  if (title === '') {
    return sendError(rest.res, rest.requestId, 422, 'Validation Failed', {
      errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }],
    });
  }
  const names = labelNamesOf(body) ?? [];
  const unknown = names.filter((name) => !repo.labels.has(name));
  if (unknown.length > 0) {
    return sendError(rest.res, rest.requestId, 422, 'Validation Failed', {
      errors: unknown.map((name) => ({ resource: 'Label', field: 'labels', code: 'invalid', message: `label ${name} does not exist` })),
    });
  }
  const issue: IssueRecord = {
    id: 100_000 + repo.nextIssue,
    number: repo.nextIssue,
    title,
    body: asString(body.body) ?? '',
    state: 'open',
    labels: names,
    createdAt: rest.forge.nowIso,
    updatedAt: rest.forge.nowIso,
    closedAt: null,
    comments: [],
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  sendJson(rest.res, rest.requestId, 201, issueJson(rest.forge, repo, issue, rest.origin), {
    location: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  });
}

function patchIssue(rest: RestRequest, repo: Repo, issue: IssueRecord): void {
  const body = asObject(rest.body);
  if (body === null) return sendError(rest.res, rest.requestId, 400, 'Problems parsing JSON');
  const title = asString(body.title);
  if (title !== null && title.trim() !== '') issue.title = title.trim();
  const text = asString(body.body);
  if (text !== null) issue.body = text;
  const state = asString(body.state);
  if (state === 'open' || state === 'closed') {
    if (state !== issue.state) {
      issue.state = state;
      issue.closedAt = state === 'closed' ? rest.forge.nowIso : null;
    }
  }
  const names = labelNamesOf(body);
  if (names !== null) {
    const unknown = names.filter((name) => !repo.labels.has(name));
    if (unknown.length > 0) {
      return sendError(rest.res, rest.requestId, 422, 'Validation Failed', {
        errors: unknown.map((name) => ({ resource: 'Label', field: 'labels', code: 'invalid', message: `label ${name} does not exist` })),
      });
    }
    issue.labels = names;
  }
  issue.updatedAt = rest.forge.nowIso;
  sendJson(rest.res, rest.requestId, 200, issueJson(rest.forge, repo, issue, rest.origin));
}

// ---------------------------------------------------------------------------------------------
// pull requests

function handlePulls(rest: RestRequest, repo: Repo, sub: string[], query: URLSearchParams): void {
  if (sub.length === 0) {
    if (rest.method === 'GET') return listPulls(rest, repo, query);
    if (rest.method === 'POST') return createPull(rest, repo);
    return sendError(rest.res, rest.requestId, 404, 'Not Found');
  }
  const number = Number.parseInt(sub[0] as string, 10);
  if (!Number.isFinite(number)) return sendError(rest.res, rest.requestId, 404, 'Not Found');
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return sendError(rest.res, rest.requestId, 404, 'Not Found');
  if (sub.length === 1) {
    if (rest.method === 'GET') return sendJson(rest.res, rest.requestId, 200, pullJson(rest.forge, repo, pull, rest.origin));
    if (rest.method === 'PATCH') {
      const body = asObject(rest.body) ?? {};
      const title = asString(body.title);
      if (title !== null) pull.title = title;
      const text = asString(body.body);
      if (text !== null) pull.body = text;
      const state = asString(body.state);
      if (state === 'open' || state === 'closed') pull.state = state;
      pull.updatedAt = rest.forge.nowIso;
      return sendJson(rest.res, rest.requestId, 200, pullJson(rest.forge, repo, pull, rest.origin));
    }
    return sendError(rest.res, rest.requestId, 404, 'Not Found');
  }
  if (sub.length === 2 && sub[1] === 'files' && rest.method === 'GET') return pullFiles(rest, repo, pull);
  if (sub.length === 2 && sub[1] === 'merge' && rest.method === 'PUT') return mergePull(rest, repo, pull);
  return sendError(rest.res, rest.requestId, 404, 'Not Found');
}

function listPulls(rest: RestRequest, repo: Repo, query: URLSearchParams): void {
  const state = (query.get('state') ?? 'open').toLowerCase();
  const filtered = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
  const ordered = [...filtered].sort((a, b) => b.number - a.number);
  const page = paginate(ordered, query);
  sendJson(
    rest.res,
    rest.requestId,
    200,
    page.page.map((pull) => pullJson(rest.forge, repo, pull, rest.origin)),
  );
}

function createPull(rest: RestRequest, repo: Repo): void {
  const body = asObject(rest.body);
  if (body === null) return sendError(rest.res, rest.requestId, 400, 'Problems parsing JSON');
  const headRef = asString(body.head)?.replace(/^[^:]+:/, '') ?? '';
  const baseRef = asString(body.base) ?? repo.defaultBranch;
  const title = asString(body.title) ?? '';
  if (headRef === '' || title === '') {
    return sendError(rest.res, rest.requestId, 422, 'Validation Failed', {
      errors: [{ resource: 'PullRequest', field: headRef === '' ? 'head' : 'title', code: 'missing_field' }],
    });
  }
  if (!repo.branches.has(headRef)) {
    return sendError(rest.res, rest.requestId, 422, 'Validation Failed', {
      errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid', message: `No commits between ${baseRef} and ${headRef}` }],
    });
  }
  if (!repo.branches.has(baseRef)) {
    return sendError(rest.res, rest.requestId, 422, 'Validation Failed', {
      errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }],
    });
  }
  const headSha = repo.branches.get(headRef) as string;
  const baseSha = repo.branches.get(baseRef) as string;
  const pull: PullRecord = {
    id: 200_000 + repo.nextPull,
    number: repo.nextPull,
    title,
    body: asString(body.body) ?? '',
    state: 'open',
    head: headRef,
    base: baseRef,
    createdAt: rest.forge.nowIso,
    updatedAt: rest.forge.nowIso,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headSha,
    baseSha,
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  sendJson(rest.res, rest.requestId, 201, pullJson(rest.forge, repo, pull, rest.origin), {
    location: `${rest.origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  });
}

/** The merge base of a pull's two branches: the newest commit both histories share. */
function mergeBaseOf(forge: Forge, repo: Repo, pull: PullRecord): CommitRecord | null {
  const headHistory = forge.history(repo, forge.resolveRef(repo, pull.headSha));
  const baseShas = new Set(forge.history(repo, forge.resolveRef(repo, pull.base)).map((commit) => commit.sha));
  for (const commit of headHistory) if (baseShas.has(commit.sha)) return commit;
  return null;
}

/** The changed paths between the merge base and the head, with GitHub's file shape. */
function changedFilesOf(forge: Forge, repo: Repo, pull: PullRecord): Json[] {
  const base = mergeBaseOf(forge, repo, pull);
  const head = forge.resolveRef(repo, pull.headSha);
  if (base === null || head === null) return [];
  const baseFiles = base.files;
  const headFiles = head.files;
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: Json[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFiles.get(path);
    const after = headFiles.get(path);
    if (before === undefined && after === undefined) continue;
    if (before !== undefined && after !== undefined && before.equals(after)) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const beforeLines = before === undefined ? [] : before.toString('utf8').split('\n');
    const afterLines = after === undefined ? [] : after.toString('utf8').split('\n');
    let additions = 0;
    let deletions = 0;
    if (before === undefined) additions = afterLines.length;
    else if (after === undefined) deletions = beforeLines.length;
    else {
      const max = Math.max(beforeLines.length, afterLines.length);
      for (let index = 0; index < max; index += 1) {
        const left = beforeLines[index];
        const right = afterLines[index];
        if (left === right) continue;
        if (left !== undefined) deletions += 1;
        if (right !== undefined) additions += 1;
      }
    }
    out.push({
      sha: after === undefined ? (before === undefined ? '' : hashObject('blob', before)) : hashObject('blob', after),
      filename: path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      blob_url: `${repo.owner}/${repo.name}/${path}`,
      raw_url: `${repo.owner}/${repo.name}/${path}`,
      contents_url: `${repo.owner}/${repo.name}/${path}`,
      patch: '',
    });
  }
  return out;
}

function pullFiles(rest: RestRequest, repo: Repo, pull: PullRecord): void {
  sendJson(rest.res, rest.requestId, 200, changedFilesOf(rest.forge, repo, pull));
}

/** What merging one pull request did: the squash commit's sha, or why it refused. */
export type MergeOutcome = { readonly ok: true; readonly sha: string } | { readonly ok: false; readonly reason: string };

/**
 * Merge `pull` into its base branch: the work PUT /pulls/{number}/merge does, with no HTTP envelope, so
 * the MCP surface moves the same store the same way REST does. A pull that is not open, whose branches
 * have no commits, or that conflicts on a path both sides changed is refused with its reason.
 */
export function mergePullInto(forge: Forge, repo: Repo, pull: PullRecord, commitMessage?: string): MergeOutcome {
  if (pull.state !== 'open') return { ok: false, reason: 'Pull Request is not mergeable' };
  const baseCommit = forge.resolveRef(repo, pull.base);
  const headCommit = forge.resolveRef(repo, pull.headSha);
  if (baseCommit === null || headCommit === null) return { ok: false, reason: 'Pull Request is not mergeable' };
  // A conflict is a path both sides changed since the merge base.
  const base = mergeBaseOf(forge, repo, pull);
  if (base === null) return { ok: false, reason: 'Pull Request is not mergeable' };
  const headChanges = changedFilesOf(forge, repo, pull);
  for (const file of headChanges) {
    const path = String(file.filename);
    const ancestor = base.files.get(path);
    const current = baseCommit.files.get(path);
    const theirs = headCommit.files.get(path);
    const ancestorBytes = ancestor === undefined ? null : ancestor;
    const currentBytes = current === undefined ? null : current;
    const theirsBytes = theirs === undefined ? null : theirs;
    const sameAsAncestor = (a: Buffer | null, b: Buffer | null): boolean => {
      if (a === null && b === null) return true;
      if (a === null || b === null) return false;
      return a.equals(b);
    };
    if (!sameAsAncestor(currentBytes, ancestorBytes) && !sameAsAncestor(theirsBytes, ancestorBytes) && !sameAsAncestor(currentBytes, theirsBytes)) {
      return { ok: false, reason: 'Pull Request is not mergeable' };
    }
  }
  const files = new Map(baseCommit.files);
  for (const file of headChanges) {
    const path = String(file.filename);
    const theirs = headCommit.files.get(path);
    if (theirs === undefined) files.delete(path);
    else files.set(path, theirs);
  }
  const message = commitMessage ?? `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`;
  const record = forge.writeCommit(repo, {
    branch: pull.base,
    files,
    message,
    parents: [baseCommit.sha],
  });
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.nowIso;
  pull.mergeCommitSha = record.sha;
  pull.updatedAt = forge.nowIso;
  return { ok: true, sha: record.sha };
}

function mergePull(rest: RestRequest, repo: Repo, pull: PullRecord): void {
  const body = asObject(rest.body) ?? {};
  const outcome = mergePullInto(rest.forge, repo, pull, asString(body.commit_message) ?? undefined);
  if (!outcome.ok) return sendError(rest.res, rest.requestId, 405, outcome.reason);
  sendJson(rest.res, rest.requestId, 200, {
    sha: outcome.sha,
    merged: true,
    message: 'Pull Request successfully merged',
  });
}
