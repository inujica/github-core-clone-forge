// mcp.ts: the Model Context Protocol endpoint at POST /mcp — the agent-native arm of this forge.
//
// One endpoint, two protocol eras, answered from one table, with no session and no per-request state:
//
//   modern 2026-07-28   `server/discover` answers the server's identity, its capabilities and every
//                       revision it speaks, and each request declares its revision in `_meta`. No
//                       handshake and no session.
//   legacy 2025-11-25   `initialize` + `notifications/initialized`; `server/discover` does not exist,
//   and earlier         which is exactly what a pre-discover server answers (-32601).
//
// Both eras see the same eight tools, and every tool acts on the store REST and GraphQL already read:
// an issue created over MCP is the object GET /api/v3/repos/{owner}/{repo}/issues/{number} answers,
// with the same id on every read. Merging goes through rest.ts's mergePullInto, so the two surfaces
// cannot drift.
//
// Transport: JSON-RPC 2.0 over Streamable HTTP, answered as application/json (the rules allow either
// that or a text/event-stream). A body that is not JSON is HTTP 400 with -32700; an unknown tool is
// -32602, never HTTP 500; a request with no Authorization header is HTTP 401.
//
// Determinism: no clock and no Math.random. Ids come from the forge's counters, timestamps from
// MAKEFUN_TRIAL_NOW (via the forge), and the tool table is a frozen module constant, so two tools/list
// answers are the same bytes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { bearerOf, mergePullInto } from './rest.ts';
import type { Forge, IssueRecord, PullRecord, Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** The endpoint path the suite speaks to. */
export const MCP_PATH = '/mcp';

/** The identity `server/discover` and `initialize` report. */
const SERVER_NAME = 'makefun-forge-mcp';
const SERVER_VERSION = '1.0.0';

/** The revision this server prefers, and every revision it accepts (newest first, all YYYY-MM-DD). */
const PREFERRED_REVISION = '2026-07-28';
const SUPPORTED_VERSIONS: readonly string[] = Object.freeze(['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);

/** What the server tells an agent it can do. */
const INSTRUCTIONS =
  'A GitHub-compatible forge: create and read repositories, open and list issues, open pull requests and merge them. Every tool acts on the same store the REST v3 surface at /api/v3 serves.';

/** JSON-RPC 2.0 error codes this endpoint uses. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

type Json = Record<string, unknown>;

/** A JSON-RPC id: a string, a number, or null for an error no request asked for. */
type RpcId = string | number | null;

// ---------------------------------------------------------------------------------------------
// the tool table
//
// One frozen constant: every `tools/list` answer serializes this same array, so two answers are
// byte-identical, and an agent that lists twice sees the same six required tools and the same two
// convenience readers. Names are github-mcp-server's own, with no prefix to strip.

/** A string property. */
function stringProperty(description: string): Json {
  return { type: 'string', description };
}

/** A boolean property. */
function booleanProperty(description: string): Json {
  return { type: 'boolean', description };
}

/** An integer property. */
function integerProperty(description: string): Json {
  return { type: 'integer', description };
}

/** One tool as `tools/list` offers it. */
interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Json;
}

/** `owner` and `repo`: the pair every repository-scoped tool takes. */
const REPO_PROPERTIES: Json = {
  owner: stringProperty("The account that owns the repository. Defaults to the authenticated account."),
  repo: stringProperty('The repository name, without the owner.'),
  full_name: stringProperty('The repository as "owner/repo"; may be given instead of owner and repo.'),
};

const TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    name: 'create_repo',
    title: 'Create a repository',
    description:
      "Create a repository under the authenticated account. Answers the repository object REST reads back at /api/v3/repos/{owner}/{repo}: its id, its name and its full_name.",
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProperty('The repository name, without the owner.'),
        description: stringProperty('A short description of the repository.'),
        private: booleanProperty('Whether the repository is private.'),
        owner: stringProperty('The account to create it under. Defaults to the authenticated account.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    title: 'Get a repository',
    description: 'Read one repository by owner and name: its id, name, full_name, description and default branch.',
    inputSchema: {
      type: 'object',
      properties: { ...REPO_PROPERTIES },
      required: ['repo'],
    },
  },
  {
    name: 'list_repos',
    title: 'List repositories',
    description: "List the authenticated account's repositories, newest first.",
    inputSchema: {
      type: 'object',
      properties: {
        type: stringProperty("Which repositories: 'all', 'owner' or 'public'. Defaults to 'all'."),
      },
    },
  },
  {
    name: 'create_issue',
    title: 'Create an issue',
    description: 'Open an issue in a repository. Answers the issue object REST reads back at /api/v3/repos/{owner}/{repo}/issues/{number}.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPERTIES,
        title: stringProperty('The issue title.'),
        body: stringProperty('The issue body, in markdown.'),
      },
      required: ['repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: "List a repository's issues, newest first, filtered by state.",
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPERTIES,
        state: stringProperty("Which issues: 'open', 'closed' or 'all'. Defaults to 'open'."),
      },
      required: ['repo'],
    },
  },
  {
    name: 'get_issue',
    title: 'Get an issue',
    description: 'Read one issue by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPERTIES,
        issue_number: integerProperty('The issue number, as REST numbers it.'),
      },
      required: ['repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    title: 'Create a pull request',
    description:
      'Open a pull request from one branch into another. Answers the pull request object REST reads back at /api/v3/repos/{owner}/{repo}/pulls/{number}, with the same head and base refs.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPERTIES,
        title: stringProperty('The pull request title.'),
        body: stringProperty('The pull request body, in markdown.'),
        head: stringProperty('The branch the change comes from.'),
        base: stringProperty('The branch to merge into. Defaults to the default branch.'),
      },
      required: ['repo', 'title', 'head'],
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge a pull request',
    description: 'Merge an open pull request into its base branch. REST then reads the pull request with merged:true.',
    inputSchema: {
      type: 'object',
      properties: {
        ...REPO_PROPERTIES,
        pull_number: integerProperty('The pull request number, as REST numbers it.'),
      },
      required: ['repo', 'pull_number'],
    },
  },
]);

// ---------------------------------------------------------------------------------------------
// argument reading
//
// The suite maps github-mcp-server's documented argument names onto these schemas' own property
// names, so the canonical names are what arrive. The synonym lists keep the tools usable by an agent
// that spells a parameter the way another server does.

const OWNER_KEYS: readonly string[] = ['owner', 'owner_login', 'org', 'organization', 'organisation', 'user', 'user_login', 'login', 'account', 'namespace', 'owner_name'];
const REPO_KEYS: readonly string[] = ['repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name'];
const FULL_NAME_KEYS: readonly string[] = ['full_name', 'repo_full_name', 'repository_full_name', 'fullName'];
const TITLE_KEYS: readonly string[] = ['title', 'issue_title', 'pr_title', 'pull_request_title', 'subject'];
const BODY_KEYS: readonly string[] = ['body', 'issue_body', 'description', 'content', 'text', 'comment'];
const HEAD_KEYS: readonly string[] = ['head', 'head_ref', 'head_branch', 'pull_request_head', 'pr_head', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch'];
const BASE_KEYS: readonly string[] = ['base', 'base_ref', 'base_branch', 'pull_request_base', 'pr_base', 'target', 'target_ref', 'target_branch', 'into', 'into_branch'];
const STATE_KEYS: readonly string[] = ['state', 'status'];

/** Whether `value` is a plain record. */
function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first non-empty string among `keys`, or null. */
function stringArg(args: Json, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** The first whole number among `keys` (a numeric string counts), or null. */
function numberArg(args: Json, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return null;
}

/** The first boolean among `keys` (a 'true'/'false' string counts), or null. */
function booleanArg(args: Json, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return null;
}

/** A branch ref with any `owner:` prefix stripped, as GitHub accepts `head: 'owner:branch'`. */
function branchName(value: string): string {
  return value.replace(/^[^:]+:/, '').trim();
}

/** What one tool run produced: a value to return, or the reason it refused. */
type RunOutcome = { readonly ok: true; readonly value: Json; readonly text: string } | { readonly ok: false; readonly message: string };

/** A resolved repository: the store's own record, so the owner is the record's, never the argument's. */
type TargetOutcome = { readonly ok: true; readonly repo: Repo } | { readonly ok: false; readonly message: string };

/** Resolve the repository a tool call names, by owner+repo or by `full_name`. */
function repoTarget(forge: Forge, args: Json): TargetOutcome {
  const full = stringArg(args, FULL_NAME_KEYS);
  let namedOwner: string | null = null;
  let namedRepo: string | null = null;
  if (full !== null && full.includes('/')) {
    const pieces = full.split('/');
    namedOwner = pieces[0] === undefined || pieces[0] === '' ? null : pieces[0];
    const rest = pieces.slice(1).join('/');
    namedRepo = rest === '' ? null : rest;
  }
  const owner = stringArg(args, OWNER_KEYS) ?? namedOwner ?? forge.user.login;
  const name = stringArg(args, REPO_KEYS) ?? namedRepo;
  if (name === null) return { ok: false, message: 'a repository name is required (repo, or full_name as "owner/repo")' };
  if (!forge.ownsLogin(owner)) return { ok: false, message: `no repository ${owner}/${name}: this token sees ${forge.user.login}'s repositories only` };
  const repo = forge.getRepo(owner, name);
  if (repo === null) return { ok: false, message: `no repository ${owner}/${name}` };
  return { ok: true, repo };
}

// ---------------------------------------------------------------------------------------------
// the objects the tools answer
//
// Each is the same record REST renders, in a compact shape: the ids REST answers, so an agent that
// reads the object back over /api/v3 sees one object, not two.

/** A repository as a tool answers it. */
function repoView(forge: Forge, repo: Repo, origin: string): Json {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: forge.user.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
  };
}

/** An issue as a tool answers it. */
function issueView(forge: Forge, repo: Repo, issue: IssueRecord, origin: string): Json {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: [...issue.labels],
    comments: issue.comments.length,
    repository: `${repo.owner}/${repo.name}`,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** A pull request as a tool answers it. */
function pullView(forge: Forge, repo: Repo, pull: PullRecord, origin: string): Json {
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    repository: `${repo.owner}/${repo.name}`,
    user: { login: forge.user.login, id: forge.user.id },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    merged_at: pull.mergedAt,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// the tools themselves
//
// Every one is a pure function of (arguments, store): no module-level state, so two calls in flight
// answer for their own arguments and their own ids.

function createRepo(forge: Forge, args: Json, origin: string): RunOutcome {
  const name = stringArg(args, ['name', ...REPO_KEYS]);
  if (name === null || name.trim() === '') return { ok: false, message: 'create_repo needs a repository name (name)' };
  const wantedOwner = stringArg(args, ['owner', 'owner_login', 'org', 'organization', 'login']);
  if (wantedOwner !== null && !forge.ownsLogin(wantedOwner)) {
    return { ok: false, message: `create_repo cannot create ${wantedOwner}/${name}: this token owns ${forge.user.login}` };
  }
  const description = stringArg(args, ['description', 'about', 'summary', 'body']) ?? '';
  const isPrivate = booleanArg(args, ['private', 'is_private']) ?? false;
  // Creating a repository that already exists answers that repository: an agent retrying a create
  // gets the object, not a refusal, and its id never moves.
  const existing = forge.getRepo(forge.user.login, name);
  const repo = existing ?? forge.createRepo(name, { description, private: isPrivate });
  if (repo === null) return { ok: false, message: `a repository named ${name} already exists` };
  return { ok: true, value: repoView(forge, repo, origin), text: `repository ${repo.owner}/${repo.name} (id ${repo.id})` };
}

function getRepo(forge: Forge, args: Json, origin: string): RunOutcome {
  const target = repoTarget(forge, args);
  if (!target.ok) return target;
  const repo = target.repo;
  return { ok: true, value: repoView(forge, repo, origin), text: `repository ${repo.owner}/${repo.name} (id ${repo.id})` };
}

function listRepos(forge: Forge, args: Json, origin: string): RunOutcome {
  const type = (stringArg(args, ['type', 'visibility']) ?? 'all').toLowerCase();
  const all = forge.listRepos().filter((repo) => (type === 'public' ? !repo.private : type === 'private' ? repo.private : true));
  const repositories = all.map((repo) => repoView(forge, repo, origin));
  const value: Json = { total: repositories.length, repositories };
  return { ok: true, value, text: `${repositories.length} repositor${repositories.length === 1 ? 'y' : 'ies'}` };
}

function createIssue(forge: Forge, args: Json, origin: string): RunOutcome {
  const target = repoTarget(forge, args);
  if (!target.ok) return target;
  const repo = target.repo;
  const title = stringArg(args, TITLE_KEYS);
  if (title === null || title.trim() === '') return { ok: false, message: 'create_issue needs an issue title' };
  const body = stringArg(args, BODY_KEYS) ?? '';
  const issue: IssueRecord = {
    id: 100_000 + repo.nextIssue,
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels: [],
    createdAt: forge.nowIso,
    updatedAt: forge.nowIso,
    closedAt: null,
    comments: [],
  };
  repo.nextIssue += 1;
  repo.issues.push(issue);
  repo.updatedAt = forge.nowIso;
  return { ok: true, value: issueView(forge, repo, issue, origin), text: `issue #${issue.number} created in ${repo.owner}/${repo.name}: ${issue.title}` };
}

function listIssues(forge: Forge, args: Json, origin: string): RunOutcome {
  const target = repoTarget(forge, args);
  if (!target.ok) return target;
  const repo = target.repo;
  const raw = (stringArg(args, STATE_KEYS) ?? 'open').toLowerCase();
  const state = raw === 'all' || raw === 'closed' ? raw : 'open';
  const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  const ordered = [...issues].sort((left, right) => right.number - left.number);
  const value: Json = {
    total: ordered.length,
    repository: `${repo.owner}/${repo.name}`,
    state,
    issues: ordered.map((issue) => issueView(forge, repo, issue, origin)),
  };
  return { ok: true, value, text: `${ordered.length} ${state === 'all' ? '' : `${state} `}issue${ordered.length === 1 ? '' : 's'} in ${repo.owner}/${repo.name}` };
}

function getIssue(forge: Forge, args: Json, origin: string): RunOutcome {
  const target = repoTarget(forge, args);
  if (!target.ok) return target;
  const repo = target.repo;
  const number = numberArg(args, ['issue_number', 'number', 'issue', 'id']);
  if (number === null) return { ok: false, message: 'get_issue needs an issue number (issue_number)' };
  const issue = repo.issues.find((entry) => entry.number === number);
  if (issue === undefined) return { ok: false, message: `no issue #${number} in ${repo.owner}/${repo.name}` };
  return { ok: true, value: issueView(forge, repo, issue, origin), text: `issue #${issue.number} in ${repo.owner}/${repo.name}: ${issue.title}` };
}

function createPullRequest(forge: Forge, args: Json, origin: string): RunOutcome {
  const target = repoTarget(forge, args);
  if (!target.ok) return target;
  const repo = target.repo;
  const title = stringArg(args, TITLE_KEYS);
  if (title === null || title.trim() === '') return { ok: false, message: 'create_pull_request needs a title' };
  const headRaw = stringArg(args, HEAD_KEYS);
  if (headRaw === null || headRaw.trim() === '') return { ok: false, message: 'create_pull_request needs a head branch' };
  const head = branchName(headRaw);
  const baseRaw = stringArg(args, BASE_KEYS);
  const base = baseRaw === null || baseRaw.trim() === '' ? repo.defaultBranch : branchName(baseRaw);
  if (!repo.branches.has(head)) return { ok: false, message: `no branch ${head} in ${repo.owner}/${repo.name}: push the head branch first` };
  if (!repo.branches.has(base)) return { ok: false, message: `no branch ${base} in ${repo.owner}/${repo.name}` };
  // An open pull from the same head into the same base is the pull this call means: answer it.
  const existing = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
  if (existing !== undefined) {
    return { ok: true, value: pullView(forge, repo, existing, origin), text: `pull request #${existing.number} is already open: ${existing.head} into ${existing.base}` };
  }
  const pull: PullRecord = {
    id: 200_000 + repo.nextPull,
    number: repo.nextPull,
    title,
    body: stringArg(args, BODY_KEYS) ?? '',
    state: 'open',
    head,
    base,
    createdAt: forge.nowIso,
    updatedAt: forge.nowIso,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headSha: repo.branches.get(head) as string,
    baseSha: repo.branches.get(base) as string,
  };
  repo.nextPull += 1;
  repo.pulls.push(pull);
  repo.updatedAt = forge.nowIso;
  return { ok: true, value: pullView(forge, repo, pull, origin), text: `pull request #${pull.number} opened: ${pull.head} into ${pull.base}` };
}

function mergePullRequest(forge: Forge, args: Json, origin: string): RunOutcome {
  const target = repoTarget(forge, args);
  if (!target.ok) return target;
  const repo = target.repo;
  const number = numberArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index']);
  if (number === null) return { ok: false, message: 'merge_pull_request needs a pull request number (pull_number)' };
  const pull = repo.pulls.find((entry) => entry.number === number);
  if (pull === undefined) return { ok: false, message: `no pull request #${number} in ${repo.owner}/${repo.name}` };
  // A pull that is already merged answers the merge it already had: the id and the sha never move.
  if (pull.merged) {
    return { ok: true, value: pullView(forge, repo, pull, origin), text: `pull request #${pull.number} is already merged as ${String(pull.mergeCommitSha)}` };
  }
  const outcome = mergePullInto(forge, repo, pull);
  if (!outcome.ok) return { ok: false, message: outcome.reason };
  return { ok: true, value: pullView(forge, repo, pull, origin), text: `merged pull request #${pull.number} into ${pull.base} as ${outcome.sha}` };
}

/** Run one named tool. */
function runTool(name: string, args: Json, forge: Forge, origin: string): RunOutcome {
  switch (name) {
    case 'create_repo':
      return createRepo(forge, args, origin);
    case 'get_repo':
      return getRepo(forge, args, origin);
    case 'list_repos':
      return listRepos(forge, args, origin);
    case 'create_issue':
      return createIssue(forge, args, origin);
    case 'list_issues':
      return listIssues(forge, args, origin);
    case 'get_issue':
      return getIssue(forge, args, origin);
    case 'create_pull_request':
      return createPullRequest(forge, args, origin);
    case 'merge_pull_request':
      return mergePullRequest(forge, args, origin);
    default:
      return { ok: false, message: `unknown tool ${name}` };
  }
}

// ---------------------------------------------------------------------------------------------
// JSON-RPC 2.0

/** A tool result block: the text an agent reads, and the same object as structured content. */
function toolSuccess(value: Json, text: string): Json {
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

/** A tool execution failure: `isError: true` with the reason, never a transport error. */
function toolFailure(message: string): Json {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** What one dispatch answered: a result, or a JSON-RPC error. */
type Dispatch = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: number; readonly message: string };

/** A successful dispatch. */
function result(value: unknown): Dispatch {
  return { ok: true, value };
}

/** A refused dispatch. */
function rpcError(code: number, message: string): Dispatch {
  return { ok: false, code, message };
}

/** The server's capabilities: tools, and nothing this forge does not serve. */
function serverCapabilities(): Json {
  return { tools: { listChanged: false } };
}

/** The server's identity, in both spellings a client may look for. */
function serverInfo(): Json {
  return { name: SERVER_NAME, version: SERVER_VERSION, title: 'Make.fun forge' };
}

/** The `server/discover` result (2026-07-28): identity, capabilities and every revision in one answer. */
function discoverResult(): Json {
  return {
    resultType: 'complete',
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: serverCapabilities(),
    serverInfo: serverInfo(),
    instructions: INSTRUCTIONS,
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
  };
}

/** The `initialize` result (2025-11-25 and earlier): the revision the client asked for, echoed back. */
function initializeResult(params: Json): Json {
  const asked = params.protocolVersion;
  const revision = typeof asked === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : PREFERRED_REVISION;
  return {
    protocolVersion: revision,
    capabilities: serverCapabilities(),
    serverInfo: serverInfo(),
    instructions: INSTRUCTIONS,
  };
}

/** Dispatch one method. Every request is answered from its own arguments; nothing is remembered. */
function dispatch(method: string, params: Json, forge: Forge, origin: string): Dispatch {
  switch (method) {
    case 'server/discover':
      return result(discoverResult());
    case 'initialize':
      return result(initializeResult(params));
    case 'ping':
      return result({});
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'notifications/progress':
    case 'notifications/roots/list_changed':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call':
      return callTool(params, forge, origin);
    case 'resources/list':
      return result({ resources: [] });
    case 'resources/templates/list':
      return result({ resourceTemplates: [] });
    case 'prompts/list':
      return result({ prompts: [] });
    default:
      return rpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** `tools/call`: resolve the tool, run it, and answer its content or its execution error. */
function callTool(params: Json, forge: Forge, origin: string): Dispatch {
  const name = typeof params.name === 'string' ? params.name : '';
  if (name === '') return rpcError(INVALID_PARAMS, 'tools/call needs a tool name');
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return rpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
  const args = isRecord(params.arguments) ? params.arguments : {};
  const outcome = runTool(tool.name, args, forge, origin);
  if (!outcome.ok) return result(toolFailure(outcome.message));
  return result(toolSuccess(outcome.value, outcome.text));
}

/** The id a request carries, as the answer must echo it: a string, a number, or null. */
function idOf(entry: Json): RpcId {
  const id = entry.id;
  if (typeof id === 'string') return id;
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  return null;
}

/** Answer one JSON-RPC entry: null for a notification (no id, no answer). */
function answerOne(entry: unknown, forge: Forge, origin: string): Json | null {
  if (!isRecord(entry)) {
    return { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Invalid Request' } };
  }
  const notification = !('id' in entry);
  const id = idOf(entry);
  const method = typeof entry.method === 'string' ? entry.method : '';
  if (method === '') {
    if (notification) return null;
    return { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'Invalid Request: no method' } };
  }
  const params = isRecord(entry.params) ? entry.params : {};
  try {
    const answer = dispatch(method, params, forge, origin);
    if (notification) return null;
    if (!answer.ok) return { jsonrpc: '2.0', id, error: { code: answer.code, message: answer.message } };
    return { jsonrpc: '2.0', id, result: answer.value };
  } catch (error) {
    if (notification) return null;
    return { jsonrpc: '2.0', id, error: { code: INTERNAL_ERROR, message: messageOf(error) } };
  }
}

// ---------------------------------------------------------------------------------------------
// the HTTP envelope

/** Answer with JSON, always with the request id. */
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

/** Answer with no body (202 for a notification, 204 for a session goodbye). */
function sendStatus(res: ServerResponse, requestId: string, status: number): void {
  res.writeHead(status, { 'content-length': 0, 'x-github-request-id': requestId });
  res.end();
}

/** Everything one MCP request needs, already read off the socket. */
export interface McpRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly forge: Forge;
  readonly requestId: string;
  readonly method: string;
  readonly origin: string;
  /** The request body's exact bytes: a body that is not JSON must answer -32700, not a generic 400. */
  readonly raw: Buffer;
}

/**
 * Answer one request at /mcp. POST is the whole protocol; DELETE is a legacy session's goodbye (this
 * server hands no session out, so it is always a no-op); GET is the optional server-to-client stream,
 * which this server does not open, so it is a 405 that names what it does serve.
 */
export function handleMcp(request: McpRequest): void {
  const { res, requestId, method } = request;
  if (method === 'POST') return handlePost(request);
  if (method === 'DELETE') return sendStatus(res, requestId, 204);
  return sendJson(
    res,
    requestId,
    405,
    { jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST, message: 'Method Not Allowed: POST /mcp is the transport' } },
    { allow: 'POST, DELETE' },
  );
}

/** POST /mcp: authenticate, read the body, and answer every entry in it. */
function handlePost(request: McpRequest): void {
  const { req, res, forge, requestId, origin, raw } = request;
  const token = bearerOf(req);
  if (token === null) return sendJson(res, requestId, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Bearer realm="mcp"' });
  if (!forge.authenticate(token)) return sendJson(res, requestId, 401, { message: 'Bad credentials' }, { 'www-authenticate': 'Bearer realm="mcp"' });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return sendJson(res, requestId, 400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error: the body is not JSON' } });
  }

  if (Array.isArray(parsed)) {
    const answers: Json[] = [];
    for (const entry of parsed) {
      const answer = answerOne(entry, forge, origin);
      if (answer !== null) answers.push(answer);
    }
    if (answers.length === 0) return sendStatus(res, requestId, 202);
    return sendJson(res, requestId, 200, answers);
  }

  const answer = answerOne(parsed, forge, origin);
  if (answer === null) return sendStatus(res, requestId, 202);
  return sendJson(res, requestId, 200, answer);
}
