// Git smart HTTP: upload-pack (protocol v2, with a v0 fallback) and receive-pack (v0 only), served
// straight from the forge's own store. No git binary, no dependency: node:crypto and node:zlib do
// the hashing and the deflating, and every byte the suite reads is produced here.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   v2 or v0 capability advertisement
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  the v0 ref advertisement + push caps
//   POST /{owner}/{repo}.git/git-upload-pack                     ls-refs / fetch (v2), want-have (v0)
//   POST /{owner}/{repo}.git/git-receive-pack                    command list + packfile -> report-status
//
// The rules the suite checks, and where each lives:
//   - the v2 advertisement opens with "version 2"; the two v0 advertisements open with their
//     "# service=..." preamble (advertiseV0 / advertiseV2).
//   - receive-pack advertises report-status, side-band-64k and delete-refs, and its report arrives
//     sideband-framed in band 1 (serveReceivePack).
//   - every update fast-forwards; a non-fast-forward is "ng <ref> non-fast-forward" and the ref does
//     not move (applyCommand).
//   - ls-refs honours ref-prefix, reports the HEAD symref and peels annotated tags (serveLsRefs).
//   - fetch sends only what the haves do not reach, honours deepen/shallow and frames its packfile in
//     sideband band 1 (planFetch / serveFetchV2).
//   - a missing repository is 404 on both services and the server stays up.
//
// Determinism: nothing here reads the clock or draws a random number. Object ids are SHA-1s of the
// bytes, packs are built in insertion order, and the advertisement lists refs sorted by name, so a
// live run and its replay answer byte for byte alike.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ServerResponse } from 'node:http';
import { hashObject, parseCommitData, parseTreeData, type ObjectType } from './gitobj.ts';
import type { CommitRecord, Forge, Repo } from './store.ts';

/** An unborn ref's old/new value in a receive-pack command list. */
const ZERO_OID = '0'.repeat(40);
/** The agent string both advertisements name. */
const AGENT = 'makefun-forge/1.0';
/** The largest band-1 payload one sideband pkt-line carries (65520 total minus 4 length minus 1 band). */
const MAX_SIDEBAND = 65_000;
/** The pack type code for each object type. */
const TYPE_CODE: Readonly<Record<ObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const TYPE_BY_CODE: Readonly<Record<number, ObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

/** A malformed request body: answered 400, never a crash. */
class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireError';
  }
}

/** One decoded pkt-line. */
interface Packet {
  readonly kind: 'data' | 'flush' | 'delim';
  readonly payload: Buffer;
}

/** An object as the store holds it. */
interface StoredObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

/** What one fetch request asks the server to send. */
interface FetchPlan {
  readonly objects: string[];
  readonly shallow: string[];
  readonly unshallow: string[];
}

/** The git surface's one entry point, called from app.ts before the JSON body parse. */
export interface GitHttpRequest {
  readonly res: ServerResponse;
  readonly forge: Forge;
  readonly requestId: string;
  readonly method: string;
  readonly query: URLSearchParams;
  readonly owner: string;
  readonly repo: string;
  /** `info/refs`, `git-upload-pack` or `git-receive-pack`. */
  readonly action: string;
  /** The Git-Protocol request header, verbatim (`version=2` when the client wants v2). */
  readonly gitProtocol: string;
  readonly body: Buffer;
}

// ---------------------------------------------------------------------------------------------
// replies
// ---------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, requestId: string, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    'x-github-request-id': requestId,
  });
  res.end(body);
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

function pkt(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65_516) throw new WireError('pkt-line payload is too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

/**
 * Decode the pkt-line stream at the head of `body`. Stops at the first flush and hands the trailing
 * bytes back untouched: a receive-pack body is a command list followed by a raw packfile.
 */
function readPackets(body: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new WireError('invalid pkt-line length');
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      offset += 4;
      return { packets, rest: body.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > body.length) throw new WireError('truncated pkt-line');
    packets.push({ kind: 'data', payload: body.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: body.subarray(offset) };
}

// ---------------------------------------------------------------------------------------------
// the object store
// ---------------------------------------------------------------------------------------------

function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

function getObject(repo: Repo, oid: string): StoredObject | null {
  const data = repo.objects.get(oid);
  if (data === undefined) return null;
  const type = repo.objectTypes.get(oid);
  if (type === undefined) return null;
  return { type, data };
}

function putObject(repo: Repo, type: ObjectType, data: Buffer): string {
  const sha = hashObject(type, data);
  if (!repo.objects.has(sha)) {
    repo.objects.set(sha, data);
    repo.objectTypes.set(sha, type);
  }
  return sha;
}

/** The headers of an annotated tag object (`object`, `type`, `tag`, `tagger`). */
function tagHeaders(data: Buffer): Map<string, string> {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const headers = new Map<string, string>();
  for (const line of head.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return headers;
}

/** Follow a chain of tag objects to the object it finally names. */
function peel(repo: Repo, oid: string): string {
  let current = oid;
  for (let step = 0; step < 16; step += 1) {
    const object = getObject(repo, current);
    if (object === null || object.type !== 'tag') return current;
    const target = tagHeaders(object.data).get('object');
    if (target === undefined || !isOid(target)) return current;
    current = target;
  }
  return current;
}

/** Add every tree and blob below `treeSha` to `out`. A gitlink names a commit the repo does not hold. */
function addTreeClosure(repo: Repo, treeSha: string, out: Set<string>): void {
  if (out.has(treeSha)) return;
  const object = getObject(repo, treeSha);
  if (object === null || object.type !== 'tree') return;
  out.add(treeSha);
  for (const entry of parseTreeData(object.data)) {
    if (entry.mode === '160000') continue;
    if (entry.mode === '40000') addTreeClosure(repo, entry.sha, out);
    else if (!out.has(entry.sha)) out.add(entry.sha);
  }
}

/**
 * Add every object reachable from `root` (commits through parents, tags through their target).
 * `boundaries` names commits whose parents the client does not have: a shallow client's tip is one,
 * so the walk stops there instead of pretending the whole history is present.
 */
function collectClosure(repo: Repo, root: string, out: Set<string>, boundaries: ReadonlySet<string> = new Set()): void {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === null) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommitData(object.data);
      stack.push(parsed.tree);
      if (!boundaries.has(oid)) for (const parent of parsed.parents) stack.push(parent);
    } else if (object.type === 'tag') {
      const target = tagHeaders(object.data).get('object');
      if (target !== undefined && isOid(target)) stack.push(target);
    } else if (object.type === 'tree') {
      for (const entry of parseTreeData(object.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.sha);
      }
    }
  }
}

/** True when `ancestor` is on the first-parent-and-merge walk of `descendant`. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    for (const parent of parseCommitData(object.data).parents) stack.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// refs
// ---------------------------------------------------------------------------------------------

/** Every ref the repository has: what git pushed, plus what REST wrote to a branch. */
function allRefs(repo: Repo): Map<string, string> {
  const refs = new Map<string, string>();
  for (const [name, oid] of repo.refs) if (isOid(oid) && oid !== ZERO_OID) refs.set(name, oid);
  for (const [branch, oid] of repo.branches) if (isOid(oid) && oid !== ZERO_OID) refs.set(`refs/heads/${branch}`, oid);
  return refs;
}

/** The refs sorted by name, so two runs advertise the same bytes. */
function sortedRefs(repo: Repo): Array<[string, string]> {
  const refs = allRefs(repo);
  return [...refs.entries()].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

/** The v0 advertisement: the `# service=` preamble, flush, then the ref list with its capabilities. */
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const capabilities =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress symref=HEAD:${headTarget(repo)} agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), FLUSH];
  const refs = sortedRefs(repo);
  const lines: string[] = [];
  if (service === 'git-upload-pack') {
    const head = refs.find((entry) => entry[0] === headTarget(repo));
    if (head !== undefined) lines.push(`${head[1]} HEAD`);
  }
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}`);
    const object = getObject(repo, oid);
    if (object !== null && object.type === 'tag') lines.push(`${peel(repo, oid)} ${name}^{}`);
  }
  if (lines.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`));
  } else {
    parts.push(pkt(`${lines[0] as string}\u0000${capabilities}\n`));
    for (const line of lines.slice(1)) parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: `version 2` and the capability lines the suite reads. */
function advertiseV2(repo: Repo): Buffer {
  return Buffer.concat([
    pkt('# service=git-upload-pack\n'),
    FLUSH,
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    pkt(`symref=HEAD:${headTarget(repo)}\n`),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------------------------

/** The type/size varint that opens a pack entry. */
function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** A version-2 pack of plain (non-delta) objects, in the order given, with its SHA-1 trailer. */
function buildPack(repo: Repo, oids: readonly string[]): Buffer {
  const objects: StoredObject[] = [];
  for (const oid of oids) {
    const object = getObject(repo, oid);
    if (object !== null) objects.push(object);
  }
  const chunks: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  chunks.push(header);
  for (const object of objects) {
    chunks.push(packObjectHeader(object.type, object.data.length));
    chunks.push(deflateSync(object.data));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// packfile read (a push's pack)
// ---------------------------------------------------------------------------------------------

function readSizeHeader(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('truncated pack entry header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while ((byte & 0x80) !== 0) {
    if (offset >= buffer.length) throw new Error('truncated pack entry header');
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsBase(buffer: Buffer, start: number): { distance: number; next: number } {
  if (start >= buffer.length) throw new Error('truncated ofs-delta base');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    if (offset >= buffer.length) throw new Error('truncated ofs-delta base');
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong number of bytes');
  return out;
}

/** Parse a pushed pack into the repository, resolving OFS_DELTA and REF_DELTA entries. */
function unpackPack(repo: Repo, pack: Buffer): void {
  if (pack.length < 32) throw new Error('pack is shorter than its header and trailer');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declared = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (pack.toString('hex', trailerStart) !== expected) throw new Error('pack checksum mismatch');
  const body = pack.subarray(0, trailerStart);

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset: number | null;
    baseOid: string | null;
    resolved: StoredObject | null;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declared; index += 1) {
    const entryOffset = offset;
    const header = readSizeHeader(body, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = {
      offset: entryOffset,
      typeCode,
      size: header.size,
      data: Buffer.alloc(0),
      baseOffset: null,
      baseOid: null,
      resolved: null,
    };
    if (typeCode === 6) {
      const base = readOfsBase(body, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.distance;
    } else if (typeCode === 7) {
      if (offset + 20 > body.length) throw new Error('ref-delta base id is truncated');
      entry.baseOid = body.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (TYPE_BY_CODE[typeCode] === undefined) {
      throw new Error(`pack entry has unknown type ${typeCode}`);
    }
    const inflated = inflateAt(body, offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const resolvedByOid = new Map<string, StoredObject>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): StoredObject => {
    if (entry.resolved !== null) return entry.resolved;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in the pack');
    resolving.add(entry.offset);
    let out: StoredObject;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (baseEntry === undefined) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid as string;
      const base = resolvedByOid.get(wanted) ?? getObject(repo, wanted);
      if (base === null || base === undefined) throw new Error('ref-delta base is not available');
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      out = { type: TYPE_BY_CODE[entry.typeCode] as ObjectType, data: entry.data };
    }
    entry.resolved = out;
    resolving.delete(entry.offset);
    return out;
  };

  for (const entry of raw) {
    const object = resolve(entry);
    const sha = hashObject(object.type, object.data);
    resolvedByOid.set(sha, object);
    if (!repo.objects.has(sha)) {
      repo.objects.set(sha, object.data);
      repo.objectTypes.set(sha, object.type);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

/**
 * The objects one fetch must send: everything reachable from the wants, cut at `depth` commits and
 * minus everything the haves already reach. `shallow` / `unshallow` carry the boundary moves the
 * response's shallow-info section reports.
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[],
): FetchPlan {
  const have = new Set<string>();
  const clientBoundary = new Set(clientShallow);
  for (const oid of haves) collectClosure(repo, oid, have, clientBoundary);

  const include = new Set<string>();
  const depthOf = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    const object = getObject(repo, want);
    if (object === null) continue;
    if (object.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
    } else if (object.type === 'tag') {
      include.add(want);
      const target = tagHeaders(object.data).get('object');
      if (target !== undefined && isOid(target)) {
        const peeled = getObject(repo, target);
        if (peeled !== null && peeled.type === 'commit') queue.push({ oid: target, depth: 1 });
        else if (peeled !== null) collectClosure(repo, target, include);
      }
    } else {
      collectClosure(repo, want, include);
    }
  }

  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; depth: number };
    const seen = depthOf.get(item.oid);
    if (seen !== undefined && seen <= item.depth) continue;
    depthOf.set(item.oid, item.depth);
    const object = getObject(repo, item.oid);
    if (object === null || object.type !== 'commit') continue;
    include.add(item.oid);
    const parsed = parseCommitData(object.data);
    addTreeClosure(repo, parsed.tree, include);
    if (depth === null || item.depth < depth) {
      for (const parent of parsed.parents) {
        if (getObject(repo, parent) !== null) queue.push({ oid: parent, depth: item.depth + 1 });
      }
    }
  }

  const boundary = new Set<string>();
  if (depth !== null) {
    for (const oid of depthOf.keys()) {
      const object = getObject(repo, oid);
      if (object === null || object.type !== 'commit') continue;
      const parsed = parseCommitData(object.data);
      if (parsed.parents.some((parent) => !include.has(parent))) boundary.add(oid);
    }
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const oid of [...boundary].sort()) if (!clientShallow.includes(oid)) shallow.push(oid);
  for (const oid of [...clientShallow].sort()) if (include.has(oid) && !boundary.has(oid)) unshallow.push(oid);

  const objects: string[] = [];
  for (const oid of include) if (!have.has(oid)) objects.push(oid);
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2
// ---------------------------------------------------------------------------------------------

/** Split a v2 command request into its command name and the argument lines after the delimiter. */
function readV2Request(body: Buffer): { command: string; args: string[] } {
  const { packets } = readPackets(body);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text === '') continue;
    if (!afterDelim) {
      const equals = text.indexOf('=');
      if (equals > 0 && text.slice(0, equals) === 'command') command = text.slice(equals + 1);
      continue;
    }
    args.push(text);
  }
  return { command, args };
}

/** v2 ls-refs: the ref list, filtered by ref-prefix, with the HEAD symref and peeled tags. */
function serveLsRefs(repo: Repo, args: readonly string[]): Buffer {
  let peelWanted = false;
  let symrefsWanted = false;
  let unbornWanted = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peelWanted = true;
    else if (arg === 'symrefs') symrefsWanted = true;
    else if (arg === 'unborn') unbornWanted = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const refs = allRefs(repo);
  const target = headTarget(repo);
  const parts: Buffer[] = [];
  if (matches('HEAD')) {
    const headOid = refs.get(target);
    const symref = symrefsWanted ? ` symref-target:${target}` : '';
    if (headOid !== undefined) parts.push(pkt(`${headOid} HEAD${symref}\n`));
    else if (unbornWanted) parts.push(pkt(`unborn HEAD${symref}\n`));
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peelWanted) {
      const object = getObject(repo, oid);
      if (object !== null && object.type === 'tag') line += ` peeled:${peel(repo, oid)}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** v2 fetch: an optional shallow-info section, then the packfile framed in sideband band 1. */
function serveFetchV2(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) {
      const oid = arg.slice(5).split(' ')[0] ?? '';
      if (isOid(oid)) wants.push(oid);
    } else if (arg.startsWith('have ')) {
      const oid = arg.slice(5).split(' ')[0] ?? '';
      if (isOid(oid)) haves.push(oid);
    } else if (arg.startsWith('shallow ')) {
      const oid = arg.slice(8).split(' ')[0] ?? '';
      if (isOid(oid)) clientShallow.push(oid);
    } else if (arg.startsWith('deepen ')) {
      const value = Number.parseInt(arg.slice(7), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  const plan = planFetch(repo, wants, haves, depth, clientShallow);
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  const pack = buildPack(repo, plan.objects);
  for (let offset = 0; offset < pack.length; offset += MAX_SIDEBAND) {
    const chunk = pack.subarray(offset, Math.min(offset + MAX_SIDEBAND, pack.length));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The whole v2 upload-pack POST. */
function serveV2(repo: Repo, body: Buffer): Buffer {
  const { command, args } = readV2Request(body);
  if (command === 'ls-refs') return serveLsRefs(repo, args);
  if (command === 'fetch') return serveFetchV2(repo, args);
  throw new WireError(`unsupported protocol v2 command ${JSON.stringify(command)}`);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0 (the fallback when the client does not ask for v2)
// ---------------------------------------------------------------------------------------------

function serveV0(repo: Repo, body: Buffer): Buffer {
  const { packets } = readPackets(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const clientShallow: string[] = [];
  let depth: number | null = null;
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const bits = text.slice(5).split(' ');
      const oid = bits[0] ?? '';
      if (isOid(oid)) wants.push(oid);
      for (const capability of bits.slice(1)) if (capability === 'side-band-64k') sideband = true;
    } else if (text.startsWith('have ')) {
      const oid = text.slice(5).split(' ')[0] ?? '';
      if (isOid(oid)) haves.push(oid);
    } else if (text.startsWith('shallow ')) {
      const oid = text.slice(8).split(' ')[0] ?? '';
      if (isOid(oid)) clientShallow.push(oid);
    } else if (text.startsWith('deepen ')) {
      const value = Number.parseInt(text.slice(7), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  const plan = planFetch(repo, wants, haves, depth, clientShallow);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  const pack = buildPack(repo, plan.objects);
  if (sideband) {
    for (let offset = 0; offset < pack.length; offset += MAX_SIDEBAND) {
      const chunk = pack.subarray(offset, Math.min(offset + MAX_SIDEBAND, pack.length));
      parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(FLUSH);
  } else {
    parts.push(pack);
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

/** Remember a pushed commit the way REST reads one: its tree folded into a path -> bytes map. */
function collectFiles(repo: Repo, treeSha: string, prefix: string, files: Map<string, Buffer>): void {
  const object = getObject(repo, treeSha);
  if (object === null || object.type !== 'tree') return;
  for (const entry of parseTreeData(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      collectFiles(repo, entry.sha, path, files);
      continue;
    }
    if (entry.mode === '160000') continue;
    const blob = repo.objects.get(entry.sha);
    if (blob !== undefined) files.set(path, blob);
  }
}

function recordCommit(repo: Repo, sha: string): void {
  if (repo.commits.has(sha)) return;
  const object = getObject(repo, sha);
  if (object === null || object.type !== 'commit') return;
  const parsed = parseCommitData(object.data);
  const files = new Map<string, Buffer>();
  collectFiles(repo, parsed.tree, '', files);
  const record: CommitRecord = {
    sha,
    tree: parsed.tree,
    parents: [...parsed.parents],
    message: parsed.message,
    authorName: parsed.authorName,
    authorEmail: parsed.authorEmail,
    epochSec: parsed.epochSec,
    files,
  };
  repo.commits.set(sha, record);
}

/** Apply one receive-pack command: create, fast-forward update, or delete. */
function applyCommand(repo: Repo, command: PushCommand): { ok: boolean; reason: string } {
  const refs = allRefs(repo);
  const current = refs.get(command.ref) ?? null;
  if (command.newOid === ZERO_OID) {
    repo.refs.delete(command.ref);
    if (command.ref.startsWith('refs/heads/')) repo.branches.delete(command.ref.slice('refs/heads/'.length));
    return { ok: true, reason: '' };
  }
  const object = getObject(repo, command.newOid);
  if (object === null) return { ok: false, reason: 'missing necessary objects' };
  // Every branch update must fast-forward: the ref's current tip has to be an ancestor of the new
  // one. A tag (or any other non-branch ref) may be created and deleted freely.
  if (command.ref.startsWith('refs/heads/') && current !== null && current !== command.newOid) {
    if (!isAncestor(repo, current, command.newOid)) return { ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(command.ref, command.newOid);
  if (command.ref.startsWith('refs/heads/')) {
    repo.branches.set(command.ref.slice('refs/heads/'.length), command.newOid);
  }
  if (object.type === 'commit') recordCommit(repo, command.newOid);
  repo.pushedAt = repo.updatedAt;
  return { ok: true, reason: '' };
}

/** The whole receive-pack POST: unpack, apply each command, report per ref inside band 1. */
function serveReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = readPackets(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8');
    const nul = text.indexOf('\u0000');
    if (nul >= 0) {
      for (const capability of text.slice(nul + 1).trim().split(' ')) {
        if (capability === 'side-band-64k') sideband = true;
      }
      text = text.slice(0, nul);
    }
    text = text.replace(/\n$/, '');
    const bits = text.split(' ');
    if (bits.length < 3) throw new WireError('malformed receive-pack command');
    const oldOid = bits[0] as string;
    const newOid = bits[1] as string;
    const ref = bits[2] as string;
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) {
      throw new WireError('malformed receive-pack command');
    }
    commands.push({ oldOid, newOid, ref });
  }

  let unpack = 'ok';
  if (rest.length > 0) {
    try {
      unpackPack(repo, rest);
    } catch (err) {
      unpack = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const lines: string[] = [`unpack ${unpack}\n`];
  for (const command of commands) {
    if (unpack !== 'ok') {
      lines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const verdict = applyCommand(repo, command);
    lines.push(verdict.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${verdict.reason}\n`);
  }
  const inner = Buffer.concat([...lines.map((line) => pkt(line)), FLUSH]);
  if (!sideband) return inner;
  const frames: Buffer[] = [];
  for (let offset = 0; offset < inner.length; offset += MAX_SIDEBAND) {
    const chunk = inner.subarray(offset, Math.min(offset + MAX_SIDEBAND, inner.length));
    frames.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  frames.push(FLUSH);
  return Buffer.concat(frames);
}

// ---------------------------------------------------------------------------------------------
// the entry point
// ---------------------------------------------------------------------------------------------

/** Serve one git smart-HTTP request. A missing repository is 404; a malformed body is 400. */
export function handleGitHttp(request: GitHttpRequest): void {
  const { res, forge, requestId, method, query, owner, repo: repoName, action, body } = request;
  const repo = forge.ownsLogin(owner) ? forge.getRepo(owner, repoName) : null;
  if (repo === null) {
    sendJson(res, requestId, 404, { message: 'Not Found' });
    return;
  }
  try {
    if (action === 'info/refs') {
      if (method !== 'GET' && method !== 'HEAD') {
        sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
        return;
      }
      const service = query.get('service') ?? '';
      if (service === 'git-upload-pack') {
        const wantsV2 = request.gitProtocol.includes('version=2');
        sendBuffer(res, requestId, 200, 'application/x-git-upload-pack-advertisement', wantsV2 ? advertiseV2(repo) : advertiseV0(repo, 'git-upload-pack'));
        return;
      }
      if (service === 'git-receive-pack') {
        sendBuffer(res, requestId, 200, 'application/x-git-receive-pack-advertisement', advertiseV0(repo, 'git-receive-pack'));
        return;
      }
      sendJson(res, requestId, 400, { message: 'smart HTTP requires a service parameter' });
      return;
    }
    if (method !== 'POST') {
      sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (action === 'git-upload-pack') {
      const wantsV2 = request.gitProtocol.includes('version=2');
      const out = wantsV2 ? serveV2(repo, body) : serveV0(repo, body);
      sendBuffer(res, requestId, 200, 'application/x-git-upload-pack-result', out);
      return;
    }
    if (action === 'git-receive-pack') {
      const out = serveReceivePack(repo, body);
      sendBuffer(res, requestId, 200, 'application/x-git-receive-pack-result', out);
      return;
    }
    sendJson(res, requestId, 404, { message: 'Not Found' });
  } catch (err) {
    if (err instanceof WireError) {
      sendJson(res, requestId, 400, { message: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, requestId, 500, { message: `git service error: ${message}` });
  }
}
