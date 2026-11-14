// Real git object plumbing: SHA-1 over the canonical git object framing, and the tree and commit
// builders/parsers the REST surface needs. No git binary, no dependency: node:crypto is the only
// import, and every hash here is the byte-exact id a stock `git` would compute for the same object.
//
//   blob    sha1("blob <len>\0" + content)
//   tree    sha1("tree <len>\0" + ("<mode> <name>\0" + 20-byte raw sha)*)
//   commit  sha1("commit <len>\0" + "tree <sha>\n" ["parent <sha>\n"]* "author ...\n" "committer ...\n\n<message>")
//
// Trees are sorted the way git sorts them: by name, with a directory's name compared as "name/".

import { createHash } from 'node:crypto';

/** The three object types this forge writes. */
export type ObjectType = 'blob' | 'tree' | 'commit';

/** The git object id of `data` framed as `type`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\u0000`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** One tree entry: a file (100644) or a subdirectory (40000). */
export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly sha: string;
}

/** Git's tree sort key: a directory sorts as if its name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** The raw tree object body for `entries`, in git's sort order. */
export function buildTreeData(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const left = treeSortKey(a);
    const right = treeSortKey(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const chunks: Buffer[] = [];
  for (const entry of sorted) {
    chunks.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    chunks.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(chunks);
}

/** The entries of a raw tree object body. */
export function parseTreeData(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let index = 0;
  while (index < data.length) {
    const space = data.indexOf(0x20, index);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const mode = data.toString('utf8', index, space);
    const name = data.toString('utf8', space + 1, nul);
    const sha = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, sha });
    index = nul + 21;
  }
  return entries;
}

/** Where a tree build parks the objects it creates. */
export interface TreeSink {
  blob(sha: string, content: Buffer): void;
  tree(sha: string, data: Buffer): void;
}

/** A nested directory node while a flat file map is folded into trees. */
interface DirNode {
  readonly files: Map<string, Buffer>;
  readonly dirs: Map<string, DirNode>;
}

function emptyNode(): DirNode {
  return { files: new Map<string, Buffer>(), dirs: new Map<string, DirNode>() };
}

/**
 * Fold a flat `path -> bytes` map into git trees and return the root tree's sha. Every blob and tree
 * it writes goes to `sink`, so a commit's whole reachable tree set is stored with it.
 */
export function buildTree(files: ReadonlyMap<string, Buffer>, sink: TreeSink): string {
  const root = emptyNode();
  for (const [path, content] of files) {
    const parts = path.split('/').filter((part) => part !== '');
    if (parts.length === 0) continue;
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = emptyNode();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, content);
  }

  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, content] of node.files) {
      const sha = hashObject('blob', content);
      sink.blob(sha, content);
      entries.push({ mode: '100644', name, sha });
    }
    for (const [name, child] of node.dirs) {
      entries.push({ mode: '40000', name, sha: build(child) });
    }
    const data = buildTreeData(entries);
    const sha = hashObject('tree', data);
    sink.tree(sha, data);
    return sha;
  };

  return build(root);
}

/** The fields one commit object body is built from. */
export interface CommitFields {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly epochSec: number;
}

/** The identity line git writes for an author or committer, in UTC. */
function identLine(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

/** The raw commit object body. */
export function buildCommitData(fields: CommitFields): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  let body = `tree ${fields.tree}\n`;
  for (const parent of fields.parents) body += `parent ${parent}\n`;
  body += `author ${identLine(fields.authorName, fields.authorEmail, fields.epochSec)}\n`;
  body += `committer ${identLine(fields.authorName, fields.authorEmail, fields.epochSec)}\n`;
  body += `\n${message}`;
  return Buffer.from(body, 'utf8');
}

/** A parsed commit object body. */
export interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly message: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly epochSec: number;
}

/** Parse a raw commit object body (enough of it for this forge's own reads). */
export function parseCommitData(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let authorName = '';
  let authorEmail = '';
  let epochSec = 0;
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const ident = line.slice(7);
      const match = /^(.*?) <([^>]*)> (\d+) [+-]\d{4}$/.exec(ident);
      if (match !== null) {
        authorName = match[1] ?? '';
        authorEmail = match[2] ?? '';
        epochSec = Number.parseInt(match[3] ?? '0', 10);
      }
    }
  }
  return { tree, parents, message, authorName, authorEmail, epochSec };
}

/** The 40-hex sha of a commit id, or null when it is not one. */
export function isSha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}
