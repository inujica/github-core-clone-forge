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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitHttp } from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleRest } from './rest.ts';
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

/** Read a request body whole, or throw when it is over the cap. */
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** The body-carrying methods whose JSON is parsed before dispatch. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
    handle(req, res, forge, requestId).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, requestId, 500, { message: `Internal Server Error: ${message}` });
    });
  });
  return server;
}

/** Route one request: the boot probe, the REST surface, or a JSON 404. */
async function handle(req: IncomingMessage, res: ServerResponse, forge: Forge, requestId: string): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'entry'}`);
  } catch {
    return sendJson(res, requestId, 400, { message: 'Invalid request URL' });
  }
  const origin = `http://${req.headers.host ?? 'entry'}`;
  const pathname = url.pathname;

  // The env's boot probe: 200 {"ok":true}, twice.
  if (pathname === '/healthz' || pathname === '/healthz/') {
    if (BODY_METHODS.has(method)) await readBody(req).catch(() => Buffer.alloc(0));
    return sendJson(res, requestId, 200, { ok: true });
  }

  // The git smart-HTTP surface. It is routed before the JSON body parse: its bodies are pkt-lines
  // and a raw packfile, not JSON.
  const gitMatch = GIT_PATH.exec(pathname);
  if (gitMatch !== null) {
    let raw: Buffer = Buffer.alloc(0);
    if (BODY_METHODS.has(method)) {
      try {
        raw = await readBody(req);
      } catch {
        return sendJson(res, requestId, 413, { message: 'Request body too large' });
      }
    }
    handleGitHttp({
      res,
      forge,
      requestId,
      method,
      query: url.searchParams,
      owner: decodeURIComponent(gitMatch[1] as string),
      repo: decodeURIComponent(gitMatch[2] as string),
      action: gitMatch[3] as string,
      gitProtocol: String(req.headers['git-protocol'] ?? ''),
      body: raw,
    });
    return;
  }

  let body: unknown;
  if (BODY_METHODS.has(method)) {
    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      return sendJson(res, requestId, 413, { message: 'Request body too large' });
    }
    const text = raw.toString('utf8').trim();
    if (text !== '') {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        // A malformed JSON body is a 400, with a JSON error body of its own.
        return sendJson(res, requestId, 400, { message: 'Problems parsing JSON' });
      }
    }
  }

  // The GraphQL v4 surface: one POST path, its own {data, errors} envelope.
  if (pathname === '/api/graphql' || pathname === '/api/graphql/') {
    handleGraphQL({ req, res, forge, requestId, method, body });
    return;
  }

  const isRest = pathname === '/api/v3' || pathname.startsWith('/api/v3/');
  if (isRest) {
    handleRest({ req, res, forge, requestId, url, body, method, origin });
    return;
  }

  // Everything else — including a git smart-HTTP path this forge does not serve yet — is a JSON 404.
  return sendJson(res, requestId, 404, { message: 'Not Found' });
}
