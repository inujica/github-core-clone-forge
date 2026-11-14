// The forge server: one Node http server that answers GitHub's surface. main.ts owns the
// entry <-> env lifecycle (bind an ephemeral port, register it, wait for done) and imports createApp
// from here; this file owns everything the suite talks to.
//
//   GET /healthz                    200 {"ok":true} — the env's boot probe
//   /api/v3/...                     the REST v3 surface (rest.ts)
//   anything else                   a JSON 404, never HTML
//
// Every reply is application/json and carries a non-empty X-GitHub-Request-Id. Nothing here reads the
// wall clock or Math.random: ids come from a counter and dates from MAKEFUN_TRIAL_NOW, so a live run
// and its replay answer byte for byte alike.
//
// Hot-path notes: a request whose target needs no URL normalization is routed from the raw request
// target (no `new URL()` per request), and a request with no body is answered without entering the
// promise chain at all. Both are pure cost removals: the same bytes go out, in the same order.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitHttp } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp, MCP_PATH } from './mcp.ts';
import { handleRest, noteMutation } from './rest.ts';
import { Forge } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** `/{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}`: the smart-HTTP surface. */
const GIT_PATH = /^\/([^/]+)\/([^/]+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** The login the bearer token names. The suite's one seeded viewer, overridable for a local run. */
const DEFAULT_LOGIN = 'adaiversen';
/** The trial's clock when MAKEFUN_TRIAL_NOW is unset (a fixed instant, never the wall clock). */
const FALLBACK_NOW_MS = 1_739_175_597_000;

/** The largest request body this forge reads (the contents API carries a whole file). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** An empty body, shared: a request without one never allocates. */
const EMPTY_BODY = Buffer.alloc(0);
/** An empty query, shared: a request without a query string never allocates one. */
const EMPTY_QUERY = new URLSearchParams();

/** The boot probe's body, shared. */
const HEALTHZ_BODY = { ok: true };

/** The instant every response timestamp is taken from: MAKEFUN_TRIAL_NOW, else a fixed fallback. */
function trialNowMs(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber;
  }
  return FALLBACK_NOW_MS;
}

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

/**
 * Read a request body whole, or throw when it is over the cap. Event-based rather than an async
 * iterator: the iterator allocates a stream reader per request, and a small body (the usual case)
 * arrives as one chunk, which is returned as-is instead of being re-concatenated.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const cleanup = (): void => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };
    const onData = (chunk: Buffer | string): void => {
      if (done) return;
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += buffer.length;
      if (total > MAX_BODY_BYTES) {
        done = true;
        cleanup();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = (): void => {
      if (done) return;
      done = true;
      cleanup();
      if (chunks.length === 0) resolve(EMPTY_BODY);
      else if (chunks.length === 1) resolve(chunks[0] as Buffer);
      else resolve(Buffer.concat(chunks, total));
    };
    const onError = (err: Error): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };
    const onAborted = (): void => onError(new Error('request aborted'));
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/** The body-carrying methods whose JSON is parsed before dispatch. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * A request target split into its raw path and raw query, or null when WHATWG URL parsing could
 * normalize it (a `..` segment, a doubled leading slash, an absolute-form target, a character URL
 * would re-encode). A null means the caller takes the `new URL()` path, exactly as before.
 *
 * For everything else `pathname` is byte-identical to what `new URL(target).pathname` returns: the
 * path is not decoded here, and rest.ts decodes each segment itself.
 */
function splitTarget(target: string): { pathname: string; search: string } | null {
  const length = target.length;
  if (length === 0 || target.charCodeAt(0) !== 47 /* / */) return null;
  if (length > 1 && target.charCodeAt(1) === 47) return null;
  let question = -1;
  for (let index = 0; index < length; index += 1) {
    const code = target.charCodeAt(index);
    if (code === 63 /* ? */) {
      question = index;
      break;
    }
    // Only the characters URL leaves alone in a path. Anything else takes the URL path.
    const plain =
      (code >= 97 && code <= 122) ||
      (code >= 65 && code <= 90) ||
      (code >= 48 && code <= 57) ||
      code === 45 || code === 46 || code === 95 || code === 126 || // - . _ ~
      code === 33 || code === 36 || code === 38 || code === 39 || // ! $ & '
      code === 40 || code === 41 || code === 42 || code === 43 || // ( ) * +
      code === 44 || code === 59 || code === 61 || code === 58 || // , ; = :
      code === 64 || code === 47 || code === 37; // @ / %
    if (!plain) return null;
  }
  const pathname = question < 0 ? target : target.slice(0, question);
  const search = question < 0 ? '' : target.slice(question + 1);
  // `.` and `..` segments are what URL resolves; leave those to it.
  if (pathname === '/.' || pathname === '/..') return null;
  if (pathname.includes('/./') || pathname.includes('/../')) return null;
  if (pathname.endsWith('/.') || pathname.endsWith('/..')) return null;
  return { pathname, search };
}

/** Build the server. It binds nothing until the caller listens; main.ts listens on an ephemeral port. */
export function createApp(): Server {
  const nowMs = trialNowMs();
  const forge = new Forge({
    login: process.env.FORGE_LOGIN ?? DEFAULT_LOGIN,
    name: process.env.FORGE_USER_NAME ?? 'ada iversen',
    email: process.env.FORGE_USER_EMAIL ?? 'adaiversen@example.invalid',
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
    nowIso: new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    nowSec: Math.floor(nowMs / 1000),
  });
  let requestCounter = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    const requestId = `FORGE:${String(requestCounter).padStart(8, '0')}`;
    try {
      const pending = handle(req, res, forge, requestId);
      if (pending !== null) pending.catch((err: unknown) => fail(err, res, requestId));
    } catch (err: unknown) {
      fail(err, res, requestId);
    }
  });
  return server;
}

/** Answer a request that threw: a 500 with the same JSON shape the suite already knows. */
function fail(err: unknown, res: ServerResponse, requestId: string): void {
  const message = err instanceof Error ? err.message : String(err);
  if (res.headersSent) {
    res.end();
    return;
  }
  sendJson(res, requestId, 500, { message: `Internal Server Error: ${message}` });
}

/**
 * Route one request: the boot probe, the REST surface, or a JSON 404. Returns null when the answer
 * was written synchronously (every request without a body), or the promise of a body-carrying one.
 */
function handle(req: IncomingMessage, res: ServerResponse, forge: Forge, requestId: string): Promise<void> | null {
  const method = (req.method ?? 'GET').toUpperCase();
  const origin = `http://${req.headers.host ?? 'entry'}`;
  const rawTarget = req.url ?? '/';
  const split = splitTarget(rawTarget);
  let pathname: string;
  let query: URLSearchParams;
  if (split === null) {
    let url: URL;
    try {
      url = new URL(rawTarget, origin);
    } catch {
      sendJson(res, requestId, 400, { message: 'Invalid request URL' });
      return null;
    }
    pathname = url.pathname;
    query = url.searchParams;
  } else {
    pathname = split.pathname;
    query = split.search === '' ? EMPTY_QUERY : new URLSearchParams(split.search);
  }

  // Any body-carrying method may change the store, so a cached serialization must not outlive it.
  if (BODY_METHODS.has(method)) noteMutation();

  // The env's boot probe: 200 {"ok":true}, twice.
  if (pathname === '/healthz' || pathname === '/healthz/') {
    if (!BODY_METHODS.has(method)) {
      sendJson(res, requestId, 200, HEALTHZ_BODY);
      return null;
    }
    return readBody(req).then(
      () => sendJson(res, requestId, 200, HEALTHZ_BODY),
      () => sendJson(res, requestId, 200, HEALTHZ_BODY),
    );
  }

  // The Model Context Protocol endpoint. Its body is JSON-RPC, and a body that is not JSON must answer
  // HTTP 400 with JSON-RPC -32700, so it reads its own bytes here instead of the generic JSON parse
  // below (which would answer a plain {"message": ...} 400).
  if (pathname === MCP_PATH || pathname === `${MCP_PATH}/`) {
    if (!BODY_METHODS.has(method)) {
      handleMcp({ req, res, forge, requestId, method, origin, raw: EMPTY_BODY });
      return null;
    }
    return readBody(req).then(
      (raw) => handleMcp({ req, res, forge, requestId, method, origin, raw }),
      () => sendJson(res, requestId, 413, { message: 'Request body too large' }),
    );
  }

  // The git smart-HTTP surface. It is routed before the JSON body parse: its bodies are pkt-lines
  // and a raw packfile, not JSON.
  const gitMatch = GIT_PATH.exec(pathname);
  if (gitMatch !== null) {
    const gitRequest = {
      res,
      forge,
      requestId,
      method,
      query,
      owner: decodeURIComponent(gitMatch[1] as string),
      repo: decodeURIComponent(gitMatch[2] as string),
      action: gitMatch[3] as string,
      gitProtocol: String(req.headers['git-protocol'] ?? ''),
    };
    if (!BODY_METHODS.has(method)) {
      handleGitHttp({ ...gitRequest, body: EMPTY_BODY });
      return null;
    }
    return readBody(req).then(
      (raw) => handleGitHttp({ ...gitRequest, body: raw }),
      () => sendJson(res, requestId, 413, { message: 'Request body too large' }),
    );
  }

  // The GraphQL v4 surface: one POST path, its own {data, errors} envelope.
  const isGraphQL = pathname === '/api/graphql' || pathname === '/api/graphql/';
  const isRest = pathname === '/api/v3' || pathname.startsWith('/api/v3/');

  if (!BODY_METHODS.has(method)) {
    if (isGraphQL) {
      handleGraphQL({ req, res, forge, requestId, method, body: undefined });
      return null;
    }
    if (isRest) {
      handleRest({ req, res, forge, requestId, pathname, query, body: undefined, method, origin });
      return null;
    }
    sendJson(res, requestId, 404, { message: 'Not Found' });
    return null;
  }

  return readBody(req).then(
    (raw) => {
      let body: unknown;
      const text = raw.toString('utf8').trim();
      if (text !== '') {
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          // A malformed JSON body is a 400, with a JSON error body of its own.
          sendJson(res, requestId, 400, { message: 'Problems parsing JSON' });
          return;
        }
      }
      if (isGraphQL) {
        handleGraphQL({ req, res, forge, requestId, method, body });
        return;
      }
      if (isRest) {
        handleRest({ req, res, forge, requestId, pathname, query, body, method, origin });
        return;
      }
      sendJson(res, requestId, 404, { message: 'Not Found' });
    },
    () => sendJson(res, requestId, 413, { message: 'Request body too large' }),
  );
}
