// GraphQL v4 over the same in-memory forge REST serves: POST /api/graphql takes
// {"query": ..., "variables": {...}} with the trial's bearer token and answers {data, errors}.
//
// No library and no generated schema: this file carries a hand-written tokenizer, a recursive-descent
// parser for the document subset gh and github-mcp-server send (operations, variables, aliases,
// inline fragments, enum/Int/String/Boolean/ID/list/object literals, `__type` and `__typename`), and a
// selection-set executor over the resolver table below. The resolver table is also the introspection
// source: `__type(name: "Issue")` lists the fields the same table resolves, so a field can never be
// served without being described.
//
// Everything reads and writes the store REST reads and writes (store.ts's Forge): an issue created by
// `createIssue` is the same IssueRecord POST /api/v3/repos/{o}/{r}/issues makes, a pull request merged
// by `mergePullRequest` moves the same base branch REST's PUT .../merge moves, and a comment added by
// `addComment` lands in the same issue.comments list REST's comment route reads.
//
// Nothing here reads the wall clock or Math.random: global ids are base64 of `Type:counter-id`, which
// is opaque, deterministic and stable across reads, and every timestamp comes from forge.nowIso.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CommitRecord, Forge, IssueRecord, PullRecord, Repo } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with JSON, always with the request id, as every other route does. */
function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
  });
  res.end(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The bearer token of a request, or null when the header names none. */
function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^\s*(?:bearer|token)\s+(.+?)\s*$/iu.exec(header);
  if (match !== null) return match[1] as string;
  return null;
}

// ---------------------------------------------------------------------------------------------------
// Global (Relay) ids: base64 of `Type:id`, opaque to the client and identical on every read.
// ---------------------------------------------------------------------------------------------------

function encodeGlobalId(type: string, id: number | string): string {
  return Buffer.from(`${type}:${String(id)}`, 'utf8').toString('base64');
}

interface DecodedId {
  readonly type: string;
  /** The id's own parts: `Repository:5001` is ['5001'], `Issue:5001:100001` is ['5001', '100001']. */
  readonly parts: readonly string[];
}

function decodeGlobalId(value: unknown): DecodedId | null {
  if (typeof value !== 'string' || value === '') return null;
  let text: string;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const index = text.indexOf(':');
  if (index <= 0 || index === text.length - 1) return null;
  const parts = text.slice(index + 1).split(':');
  if (parts.length === 0 || parts.some((part) => part === '')) return null;
  return { type: text.slice(0, index), parts };
}

// ---------------------------------------------------------------------------------------------------
// Tokens.
// ---------------------------------------------------------------------------------------------------

type TokenKind = 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';

interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly line: number;
  readonly column: number;
}

const PUNCTUATORS = new Set(['!', '$', '&', '(', ')', ':', '=', '@', '[', ']', '{', '|', '}']);

class GraphQLSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQLSyntaxError';
  }
}

/** Split a document into tokens, skipping whitespace, commas, comments and byte-order marks. */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;
  const length = source.length;

  const advance = (count: number): void => {
    for (let step = 0; step < count && index < length; step += 1) {
      if (source[index] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      index += 1;
    }
  };

  while (index < length) {
    const ch = source[index] as string;
    if (ch === '\uFEFF' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      advance(1);
      continue;
    }
    if (ch === '#') {
      while (index < length && source[index] !== '\n') advance(1);
      continue;
    }
    const startLine = line;
    const startColumn = column;
    if (ch === '.') {
      if (source.slice(index, index + 3) === '...') {
        tokens.push({ kind: 'punct', value: '...', line: startLine, column: startColumn });
        advance(3);
        continue;
      }
      throw new GraphQLSyntaxError(`Unexpected "." at line ${line}, column ${column}`);
    }
    if (PUNCTUATORS.has(ch)) {
      tokens.push({ kind: 'punct', value: ch, line: startLine, column: startColumn });
      advance(1);
      continue;
    }
    if (ch === '"') {
      // A block string opens with three quotes and runs to the next three.
      if (source.slice(index, index + 3) === '"""') {
        advance(3);
        let text = '';
        for (;;) {
          if (index >= length) throw new GraphQLSyntaxError('Unterminated block string');
          if (source.slice(index, index + 3) === '"""') {
            advance(3);
            break;
          }
          const current = source[index] as string;
          if (current === '\\' && source.slice(index, index + 4) === '\\"""') {
            text += '"""';
            advance(4);
            continue;
          }
          text += current;
          advance(1);
        }
        tokens.push({ kind: 'string', value: text, line: startLine, column: startColumn });
        continue;
      }
      advance(1);
      let text = '';
      for (;;) {
        if (index >= length) throw new GraphQLSyntaxError('Unterminated string');
        const current = source[index] as string;
        if (current === '"') {
          advance(1);
          break;
        }
        if (current === '\n') throw new GraphQLSyntaxError('Unterminated string');
        if (current === '\\') {
          const escape = source[index + 1];
          advance(2);
          switch (escape) {
            case '"':
              text += '"';
              break;
            case '\\':
              text += '\\';
              break;
            case '/':
              text += '/';
              break;
            case 'b':
              text += '\b';
              break;
            case 'f':
              text += '\f';
              break;
            case 'n':
              text += '\n';
              break;
            case 'r':
              text += '\r';
              break;
            case 't':
              text += '\t';
              break;
            case 'u': {
              const hex = source.slice(index, index + 4);
              if (!/^[0-9a-fA-F]{4}$/u.test(hex)) throw new GraphQLSyntaxError('Invalid unicode escape');
              text += String.fromCharCode(Number.parseInt(hex, 16));
              advance(4);
              break;
            }
            default:
              throw new GraphQLSyntaxError(`Invalid escape \\${String(escape)}`);
          }
          continue;
        }
        text += current;
        advance(1);
      }
      tokens.push({ kind: 'string', value: text, line: startLine, column: startColumn });
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let text = '';
      if (ch === '-') {
        text += '-';
        advance(1);
      }
      let digits = '';
      while (index < length && source[index] >= '0' && source[index] <= '9') {
        digits += source[index] as string;
        advance(1);
      }
      if (digits === '') throw new GraphQLSyntaxError(`Unexpected character "${ch}"`);
      text += digits;
      let kind: TokenKind = 'int';
      if (source[index] === '.') {
        kind = 'float';
        text += '.';
        advance(1);
        let fraction = '';
        while (index < length && source[index] >= '0' && source[index] <= '9') {
          fraction += source[index] as string;
          advance(1);
        }
        if (fraction === '') throw new GraphQLSyntaxError('Invalid float');
        text += fraction;
      }
      const exponent = source[index];
      if (exponent === 'e' || exponent === 'E') {
        kind = 'float';
        text += exponent;
        advance(1);
        const sign = source[index];
        if (sign === '+' || sign === '-') {
          text += sign;
          advance(1);
        }
        let power = '';
        while (index < length && source[index] >= '0' && source[index] <= '9') {
          power += source[index] as string;
          advance(1);
        }
        if (power === '') throw new GraphQLSyntaxError('Invalid exponent');
        text += power;
      }
      tokens.push({ kind, value: text, line: startLine, column: startColumn });
      continue;
    }
    if (ch === '_' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      let text = '';
      while (index < length) {
        const current = source[index] as string;
        const ok = current === '_' || (current >= '0' && current <= '9') || (current >= 'A' && current <= 'Z') || (current >= 'a' && current <= 'z');
        if (!ok) break;
        text += current;
        advance(1);
      }
      tokens.push({ kind: 'name', value: text, line: startLine, column: startColumn });
      continue;
    }
    throw new GraphQLSyntaxError(`Unexpected character "${ch}" at line ${line}, column ${column}`);
  }

  tokens.push({ kind: 'eof', value: '', line, column });
  return tokens;
}

// ---------------------------------------------------------------------------------------------------
// The document's shape.
// ---------------------------------------------------------------------------------------------------

type ValueNode =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'int'; readonly value: string }
  | { readonly kind: 'float'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: readonly { readonly name: string; readonly value: ValueNode }[] };

interface ArgumentNode {
  readonly name: string;
  readonly value: ValueNode;
}

interface DirectiveNode {
  readonly name: string;
  readonly args: readonly ArgumentNode[];
}

interface FieldNode {
  readonly alias: string | null;
  readonly name: string;
  readonly args: readonly ArgumentNode[];
  readonly directives: readonly DirectiveNode[];
  readonly selections: readonly SelectionNode[];
}

interface InlineFragmentNode {
  readonly kind: 'inline';
  readonly typeCondition: string | null;
  readonly directives: readonly DirectiveNode[];
  readonly selections: readonly SelectionNode[];
}

interface FragmentSpreadNode {
  readonly kind: 'spread';
  readonly name: string;
  readonly directives: readonly DirectiveNode[];
}

type SelectionNode = { readonly kind: 'field'; readonly field: FieldNode } | InlineFragmentNode | FragmentSpreadNode;

interface VariableDefinition {
  readonly name: string;
  readonly type: string;
  readonly defaultValue: ValueNode | null;
}

interface OperationNode {
  readonly kind: 'query' | 'mutation' | 'subscription';
  readonly name: string | null;
  readonly variables: readonly VariableDefinition[];
  readonly selections: readonly SelectionNode[];
}

interface FragmentNode {
  readonly name: string;
  readonly typeCondition: string;
  readonly selections: readonly SelectionNode[];
}

interface ParsedDocument {
  readonly operations: OperationNode[];
  readonly fragments: Map<string, FragmentNode>;
}

// ---------------------------------------------------------------------------------------------------
// The parser: recursive descent over the token list.
// ---------------------------------------------------------------------------------------------------

class Parser {
  private readonly tokens: readonly Token[];
  private position = 0;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[Math.min(this.position, this.tokens.length - 1)] as Token;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== 'eof') this.position += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private atName(value: string): boolean {
    const token = this.peek();
    return token.kind === 'name' && token.value === value;
  }

  private expectPunct(value: string): void {
    const token = this.peek();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GraphQLSyntaxError(`Expected "${value}" but found "${token.value || token.kind}" at line ${token.line}`);
    }
    this.next();
  }

  private expectName(): string {
    const token = this.peek();
    if (token.kind !== 'name') {
      throw new GraphQLSyntaxError(`Expected a name but found "${token.value || token.kind}" at line ${token.line}`);
    }
    this.next();
    return token.value;
  }

  parseDocument(): ParsedDocument {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      if (this.atPunct('{')) {
        operations.push({ kind: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
        continue;
      }
      const keyword = this.peek();
      if (keyword.kind !== 'name') {
        throw new GraphQLSyntaxError(`Expected an operation but found "${keyword.value || keyword.kind}" at line ${keyword.line}`);
      }
      if (keyword.value === 'fragment') {
        this.next();
        const name = this.expectName();
        if (!this.atName('on')) throw new GraphQLSyntaxError('A fragment needs an "on" type condition');
        this.next();
        const typeCondition = this.expectName();
        this.parseDirectives();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      if (keyword.value === 'query' || keyword.value === 'mutation' || keyword.value === 'subscription') {
        this.next();
        const kind = keyword.value;
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.expectName();
        const variables = this.atPunct('(') ? this.parseVariableDefinitions() : [];
        this.parseDirectives();
        const selections = this.parseSelectionSet();
        operations.push({ kind, name, variables, selections });
        continue;
      }
      throw new GraphQLSyntaxError(`Unexpected "${keyword.value}" at line ${keyword.line}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): readonly VariableDefinition[] {
    this.expectPunct('(');
    const out: VariableDefinition[] = [];
    while (!this.atPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.atPunct('=')) {
        this.next();
        defaultValue = this.parseValue();
      }
      this.parseDirectives();
      out.push({ name, type, defaultValue });
    }
    this.expectPunct(')');
    return out;
  }

  private parseType(): string {
    if (this.atPunct('[')) {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      const list = `[${inner}]`;
      if (this.atPunct('!')) {
        this.next();
        return `${list}!`;
      }
      return list;
    }
    const name = this.expectName();
    if (this.atPunct('!')) {
      this.next();
      return `${name}!`;
    }
    return name;
  }

  private parseSelectionSet(): readonly SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('Unterminated selection set');
      out.push(this.parseSelection());
    }
    this.expectPunct('}');
    return out;
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.next();
      if (this.atName('on')) {
        this.next();
        const typeCondition = this.expectName();
        const directives = this.parseDirectives();
        const selections = this.parseSelectionSet();
        return { kind: 'inline', typeCondition, directives, selections };
      }
      if (this.atPunct('{') || this.atPunct('@')) {
        const directives = this.parseDirectives();
        const selections = this.parseSelectionSet();
        return { kind: 'inline', typeCondition: null, directives, selections };
      }
      const name = this.expectName();
      const directives = this.parseDirectives();
      return { kind: 'spread', name, directives };
    }
    let alias: string | null = null;
    let name = this.expectName();
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArguments() : [];
    const directives = this.parseDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', field: { alias, name, args, directives, selections } };
  }

  private parseArguments(): readonly ArgumentNode[] {
    this.expectPunct('(');
    const out: ArgumentNode[] = [];
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      out.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return out;
  }

  private parseDirectives(): readonly DirectiveNode[] {
    const out: DirectiveNode[] = [];
    while (this.atPunct('@')) {
      this.next();
      const name = this.expectName();
      const args = this.atPunct('(') ? this.parseArguments() : [];
      out.push({ name, args });
    }
    return out;
  }

  private parseValue(): ValueNode {
    const token = this.peek();
    if (token.kind === 'punct') {
      if (token.value === '$') {
        this.next();
        return { kind: 'variable', name: this.expectName() };
      }
      if (token.value === '[') {
        this.next();
        const values: ValueNode[] = [];
        while (!this.atPunct(']')) {
          if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('Unterminated list');
          values.push(this.parseValue());
        }
        this.expectPunct(']');
        return { kind: 'list', values };
      }
      if (token.value === '{') {
        this.next();
        const fields: { name: string; value: ValueNode }[] = [];
        while (!this.atPunct('}')) {
          if (this.peek().kind === 'eof') throw new GraphQLSyntaxError('Unterminated object');
          const name = this.expectName();
          this.expectPunct(':');
          fields.push({ name, value: this.parseValue() });
        }
        this.expectPunct('}');
        return { kind: 'object', fields };
      }
      throw new GraphQLSyntaxError(`Unexpected "${token.value}" in a value at line ${token.line}`);
    }
    if (token.kind === 'int') {
      this.next();
      return { kind: 'int', value: token.value };
    }
    if (token.kind === 'float') {
      this.next();
      return { kind: 'float', value: token.value };
    }
    if (token.kind === 'string') {
      this.next();
      return { kind: 'string', value: token.value };
    }
    if (token.kind === 'name') {
      this.next();
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new GraphQLSyntaxError(`Unexpected end of a value at line ${token.line}`);
  }
}

function parseDocument(source: string): ParsedDocument {
  return new Parser(tokenize(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------------
// The resolver table. Its keys are the schema: introspection answers from this same table, so every
// field the executor can resolve is a field `__type` describes, and the other way round.
// ---------------------------------------------------------------------------------------------------

interface ArgumentDef {
  readonly name: string;
  readonly type: string;
}

interface FieldDef {
  /** A scalar/enum name, an object type name, or a bracketed list of either (`[Issue]`). */
  readonly type: string;
  readonly args?: readonly ArgumentDef[];
  readonly resolve: (value: never, args: Record<string, unknown>) => unknown;
}

type SchemaTable = Record<string, Record<string, FieldDef>>;

/** The enums the schema exposes (their values, for `__type(...).enumValues`). */
const ENUMS: Record<string, readonly string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  IssueStateReason: ['COMPLETED', 'NOT_PLANNED', 'REOPENED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'PULL_REQUEST', 'CODE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

/** The scalars the schema exposes. */
const SCALARS = new Set(['ID', 'String', 'Int', 'Float', 'Boolean', 'DateTime', 'URI']);

const INPUT_TYPES: Record<string, readonly ArgumentDef[]> = {
  CreateIssueInput: [
    { name: 'repositoryId', type: 'ID!' },
    { name: 'title', type: 'String!' },
    { name: 'body', type: 'String' },
    { name: 'clientMutationId', type: 'String' },
  ],
  CloseIssueInput: [
    { name: 'issueId', type: 'ID!' },
    { name: 'stateReason', type: 'IssueStateReason' },
    { name: 'clientMutationId', type: 'String' },
  ],
  CreatePullRequestInput: [
    { name: 'repositoryId', type: 'ID!' },
    { name: 'baseRefName', type: 'String!' },
    { name: 'headRefName', type: 'String!' },
    { name: 'title', type: 'String!' },
    { name: 'body', type: 'String' },
    { name: 'draft', type: 'Boolean' },
    { name: 'clientMutationId', type: 'String' },
  ],
  MergePullRequestInput: [
    { name: 'pullRequestId', type: 'ID!' },
    { name: 'mergeMethod', type: 'PullRequestMergeMethod' },
    { name: 'commitHeadline', type: 'String' },
    { name: 'commitBody', type: 'String' },
    { name: 'clientMutationId', type: 'String' },
  ],
  AddCommentInput: [
    { name: 'subjectId', type: 'ID!' },
    { name: 'body', type: 'String!' },
    { name: 'clientMutationId', type: 'String' },
  ],
};

// ---------------------------------------------------------------------------------------------------
// Arguments and values.
// ---------------------------------------------------------------------------------------------------

function valueOf(node: ValueNode, variables: Readonly<Record<string, unknown>>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] === undefined ? null : variables[node.name];
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => valueOf(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
    default:
      return null;
  }
}

function argumentsOf(nodes: readonly ArgumentNode[], variables: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of nodes) out[node.name] = valueOf(node.value, variables);
  return out;
}

/** A connection's cursor: base64 of `cursor:<offset>`, so it is opaque and deterministic. */
function encodeCursor(offset: number): string {
  return Buffer.from(`cursor:${String(offset)}`, 'utf8').toString('base64');
}

function decodeCursor(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0;
  let text: string;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return 0;
  }
  const match = /^cursor:(\d+)$/u.exec(text);
  if (match === null) return 0;
  return Number.parseInt(match[1] as string, 10);
}

function firstOf(args: Record<string, unknown>, fallback: number): number {
  const value = args.first;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.floor(value);
  return fallback;
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

// ---------------------------------------------------------------------------------------------------
// The schema, bound to one forge.
// ---------------------------------------------------------------------------------------------------

interface ChangedFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly sha: string;
}

/** The newest commit both of a pull request's branches reach. */
function mergeBaseOf(forge: Forge, repo: Repo, pull: PullRecord): CommitRecord | null {
  const headHistory = forge.history(repo, forge.resolveRef(repo, pull.headSha === '' ? pull.head : pull.headSha));
  const baseShas = new Set(forge.history(repo, forge.resolveRef(repo, pull.base)).map((commit) => commit.sha));
  for (const commit of headHistory) if (baseShas.has(commit.sha)) return commit;
  return null;
}

/** The paths a pull request changes: the merge base's snapshot against the head's. */
function changedFilesOf(forge: Forge, repo: Repo, pull: PullRecord): ChangedFile[] {
  const base = mergeBaseOf(forge, repo, pull);
  const head = forge.resolveRef(repo, pull.headSha === '' ? pull.head : pull.headSha);
  if (base === null || head === null) return [];
  const paths = new Set<string>([...base.files.keys(), ...head.files.keys()]);
  const out: ChangedFile[] = [];
  for (const path of [...paths].sort()) {
    const before = base.files.get(path);
    const after = head.files.get(path);
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
    out.push({ path, status, additions, deletions, sha: '' });
  }
  return out;
}

/** The GitHub GraphQL spelling of an issue's state. */
function issueStateOf(issue: IssueRecord): string {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

/** The GitHub GraphQL spelling of a pull request's state: a merge is MERGED, not CLOSED. */
function pullStateOf(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

/** A pull request's mergeability, as the enum the checks accept. */
function mergeableOf(pull: PullRecord): string {
  return pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN';
}

/** Build the resolver table for one forge. */
function buildSchema(forge: Forge): SchemaTable {
  const nowIso = forge.nowIso;
  /** The repository each projected pull request belongs to: the store keeps pulls inside their repo. */
  const pullRepos = new WeakMap<PullRecord, Repo>();
  /** The repository each projected issue belongs to (an issue's id is only unique inside its repo). */
  const issueRepos = new WeakMap<IssueRecord, Repo>();

  /** Bind a pull request to its repository and hand it back, for a projection to carry. */
  const bindPull = (repo: Repo, pull: PullRecord): PullRecord => {
    pullRepos.set(pull, repo);
    return pull;
  };

  /** Bind an issue to its repository and hand it back, for a projection to carry. */
  const bindIssue = (repo: Repo, issue: IssueRecord): IssueRecord => {
    issueRepos.set(issue, repo);
    return issue;
  };

  const repoOfNumericId = (numeric: number): Repo | null => {
    for (const repo of forge.repos.values()) if (repo.id === numeric) return repo;
    return null;
  };

  const repoOfId = (value: unknown): Repo | null => {
    const decoded = decodeGlobalId(value);
    if (decoded === null || decoded.type !== 'Repository') return null;
    const numeric = Number(decoded.parts[0]);
    if (!Number.isFinite(numeric)) return null;
    return repoOfNumericId(numeric);
  };

  const issueOfId = (value: unknown): { repo: Repo; issue: IssueRecord } | null => {
    const decoded = decodeGlobalId(value);
    if (decoded === null || decoded.type !== 'Issue') return null;
    if (decoded.parts.length === 2) {
      const repo = repoOfNumericId(Number(decoded.parts[0]));
      if (repo === null) return null;
      const found = repo.issues.find((issue) => issue.id === Number(decoded.parts[1]));
      return found === undefined ? null : { repo, issue: found };
    }
    const numeric = Number(decoded.parts[0]);
    if (!Number.isFinite(numeric)) return null;
    for (const repo of forge.repos.values()) {
      const found = repo.issues.find((issue) => issue.id === numeric);
      if (found !== undefined) return { repo, issue: found };
    }
    return null;
  };

  const pullOfId = (value: unknown): { repo: Repo; pull: PullRecord } | null => {
    const decoded = decodeGlobalId(value);
    if (decoded === null || decoded.type !== 'PullRequest') return null;
    if (decoded.parts.length === 2) {
      const repo = repoOfNumericId(Number(decoded.parts[0]));
      if (repo === null) return null;
      const found = repo.pulls.find((pull) => pull.id === Number(decoded.parts[1]));
      return found === undefined ? null : { repo, pull: bindPull(repo, found) };
    }
    const numeric = Number(decoded.parts[0]);
    if (!Number.isFinite(numeric)) return null;
    for (const repo of forge.repos.values()) {
      const found = repo.pulls.find((pull) => pull.id === numeric);
      if (found !== undefined) return { repo, pull: bindPull(repo, found) };
    }
    return null;
  };

  const createIssueRecord = (repo: Repo, title: string, body: string): IssueRecord => {
    const issue: IssueRecord = {
      id: 100_000 + repo.nextIssue,
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels: [],
      createdAt: nowIso,
      updatedAt: nowIso,
      closedAt: null,
      comments: [],
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return issue;
  };

  const createPullRecord = (
    repo: Repo,
    options: { title: string; body: string; head: string; base: string },
  ): PullRecord | string => {
    if (!repo.branches.has(options.head)) return `No commits between ${options.base} and ${options.head}`;
    if (!repo.branches.has(options.base)) return `Base branch ${options.base} does not exist`;
    const pull: PullRecord = {
      id: 200_000 + repo.nextPull,
      number: repo.nextPull,
      title: options.title,
      body: options.body,
      state: 'open',
      head: options.head,
      base: options.base,
      createdAt: nowIso,
      updatedAt: nowIso,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headSha: repo.branches.get(options.head) as string,
      baseSha: repo.branches.get(options.base) as string,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return pull;
  };

  /** Squash/merge/rebase a pull request into its base branch, refusing a conflicting one. */
  const mergeRecord = (repo: Repo, pull: PullRecord, message: string): boolean => {
    if (pull.state !== 'open') return false;
    const baseCommit = forge.resolveRef(repo, pull.base);
    const headCommit = forge.resolveRef(repo, pull.headSha === '' ? pull.head : pull.headSha);
    if (baseCommit === null || headCommit === null) return false;
    const base = mergeBaseOf(forge, repo, pull);
    if (base === null) return false;
    const changes = changedFilesOf(forge, repo, pull);
    const same = (left: Buffer | null, right: Buffer | null): boolean => {
      if (left === null && right === null) return true;
      if (left === null || right === null) return false;
      return left.equals(right);
    };
    for (const file of changes) {
      const ancestor = base.files.get(file.path) ?? null;
      const current = baseCommit.files.get(file.path) ?? null;
      const theirs = headCommit.files.get(file.path) ?? null;
      if (!same(current, ancestor) && !same(theirs, ancestor) && !same(current, theirs)) return false;
    }
    const files = new Map(baseCommit.files);
    for (const file of changes) {
      const theirs = headCommit.files.get(file.path);
      if (theirs === undefined) files.delete(file.path);
      else files.set(file.path, theirs);
    }
    const record = forge.writeCommit(repo, { branch: pull.base, files, message, parents: [baseCommit.sha] });
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = nowIso;
    pull.mergeCommitSha = record.sha;
    pull.updatedAt = nowIso;
    return true;
  };

  const paginate = <T>(items: readonly T[], args: Record<string, unknown>): { page: T[]; total: number; hasNextPage: boolean; start: number } => {
    const total = items.length;
    // `endCursor` names the last item a page returned, so the next page starts one past it.
    const after = typeof args.after === 'string' && args.after !== '';
    const start = Math.min(after ? decodeCursor(args.after) + 1 : 0, total);
    const count = firstOf(args, total);
    const page = items.slice(start, start + count);
    return { page, total, hasNextPage: start + page.length < total, start };
  };

  const connection = <T>(
    items: readonly T[],
    args: Record<string, unknown>,
    toNode: (item: T) => unknown,
  ): Record<string, unknown> => {
    const { page, total, hasNextPage, start } = paginate(items, args);
    return {
      nodes: page.map(toNode),
      totalCount: total,
      edges: page.map((item, index) => ({ cursor: encodeCursor(start + index), node: toNode(item) })),
      pageInfo: {
        hasNextPage,
        hasPreviousPage: start > 0,
        startCursor: page.length === 0 ? null : encodeCursor(start),
        endCursor: page.length === 0 ? null : encodeCursor(start + page.length - 1),
      },
    };
  };

  const sortIssues = (issues: readonly IssueRecord[], args: Record<string, unknown>): IssueRecord[] => {
    const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
    const field = typeof orderBy.field === 'string' ? orderBy.field.toUpperCase() : 'CREATED_AT';
    const direction = typeof orderBy.direction === 'string' ? orderBy.direction.toUpperCase() : 'DESC';
    const list = [...issues];
    list.sort((left, right) => {
      let comparison = 0;
      if (field === 'COMMENTS') comparison = left.comments.length - right.comments.length;
      else if (field === 'UPDATED_AT') comparison = left.updatedAt < right.updatedAt ? -1 : left.updatedAt > right.updatedAt ? 1 : 0;
      else comparison = left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
      // Ties break on the issue number, in the same direction as the sort.
      if (comparison === 0) comparison = left.number - right.number;
      return direction === 'ASC' ? comparison : -comparison;
    });
    return list;
  };

  const schema: SchemaTable = {
    Query: {
      viewer: { type: 'User', resolve: () => forge.user },
      repository: {
        type: 'Repository',
        args: [
          { name: 'owner', type: 'String!' },
          { name: 'name', type: 'String!' },
        ],
        resolve: (_value, args) => {
          const owner = typeof args.owner === 'string' ? args.owner : '';
          const name = typeof args.name === 'string' ? args.name : '';
          if (owner === '' || name === '') return null;
          if (!forge.ownsLogin(owner)) return null;
          return forge.getRepo(owner, name);
        },
      },
      node: {
        type: 'Node',
        args: [{ name: 'id', type: 'ID!' }],
        resolve: (_value, args) => {
          const decoded = decodeGlobalId(args.id);
          if (decoded === null) return null;
          if (decoded.type === 'Repository') {
            const repo = repoOfId(args.id);
            return repo === null ? null : { __typename: 'Repository', value: repo };
          }
          if (decoded.type === 'Issue') {
            const found = issueOfId(args.id);
            return found === null ? null : { __typename: 'Issue', value: bindIssue(found.repo, found.issue) };
          }
          if (decoded.type === 'PullRequest') {
            const found = pullOfId(args.id);
            return found === null ? null : { __typename: 'PullRequest', value: bindPull(found.repo, found.pull) };
          }
          if (decoded.type === 'User') return { __typename: 'User', value: forge.user };
          return null;
        },
      },
      user: {
        type: 'User',
        args: [{ name: 'login', type: 'String!' }],
        resolve: (_value, args) => {
          const login = typeof args.login === 'string' ? args.login : '';
          return login.toLowerCase() === forge.user.login.toLowerCase() ? forge.user : null;
        },
      },
      __type: {
        type: '__Type',
        args: [{ name: 'name', type: 'String!' }],
        resolve: (_value, args) => typeIntrospection(typeof args.name === 'string' ? args.name : ''),
      },
      __schema: { type: '__Schema', resolve: () => ({}) },
    },

    Mutation: {
      createIssue: {
        type: 'CreateIssuePayload',
        args: [{ name: 'input', type: 'CreateIssueInput!' }],
        resolve: (_value, args) => {
          const input = isRecord(args.input) ? args.input : {};
          const repo = repoOfId(input.repositoryId);
          if (repo === null) throw new Error('Could not resolve to a Repository with the given id');
          const title = typeof input.title === 'string' ? input.title : '';
          if (title === '') throw new Error('A title is required to create an issue');
          const body = typeof input.body === 'string' ? input.body : '';
          const issue = createIssueRecord(repo, title, body);
          return { issue: bindIssue(repo, issue), clientMutationId: input.clientMutationId ?? null };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        args: [{ name: 'input', type: 'CloseIssueInput!' }],
        resolve: (_value, args) => {
          const input = isRecord(args.input) ? args.input : {};
          const found = issueOfId(input.issueId);
          if (found === null) throw new Error('Could not resolve to an Issue with the given id');
          const issue = found.issue;
          if (issue.state !== 'closed') {
            issue.state = 'closed';
            issue.closedAt = nowIso;
            issue.updatedAt = nowIso;
          }
          return { issue: bindIssue(found.repo, issue), clientMutationId: input.clientMutationId ?? null };
        },
      },
      reopenIssue: {
        type: 'ReopenIssuePayload',
        args: [{ name: 'input', type: 'CloseIssueInput!' }],
        resolve: (_value, args) => {
          const input = isRecord(args.input) ? args.input : {};
          const found = issueOfId(input.issueId);
          if (found === null) throw new Error('Could not resolve to an Issue with the given id');
          const issue = found.issue;
          if (issue.state !== 'open') {
            issue.state = 'open';
            issue.closedAt = null;
            issue.updatedAt = nowIso;
          }
          return { issue: bindIssue(found.repo, issue), clientMutationId: input.clientMutationId ?? null };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        args: [{ name: 'input', type: 'CreatePullRequestInput!' }],
        resolve: (_value, args) => {
          const input = isRecord(args.input) ? args.input : {};
          const repo = repoOfId(input.repositoryId);
          if (repo === null) throw new Error('Could not resolve to a Repository with the given id');
          const head = typeof input.headRefName === 'string' ? input.headRefName : '';
          const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
          const title = typeof input.title === 'string' ? input.title : '';
          if (title === '') throw new Error('A title is required to create a pull request');
          const created = createPullRecord(repo, {
            title,
            body: typeof input.body === 'string' ? input.body : '',
            head,
            base,
          });
          if (typeof created === 'string') throw new Error(created);
          return { pullRequest: bindPull(repo, created), clientMutationId: input.clientMutationId ?? null };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        args: [{ name: 'input', type: 'MergePullRequestInput!' }],
        resolve: (_value, args) => {
          const input = isRecord(args.input) ? args.input : {};
          const found = pullOfId(input.pullRequestId);
          if (found === null) throw new Error('Could not resolve to a PullRequest with the given id');
          const pull = found.pull;
          const repo = found.repo;
          const message =
            typeof input.commitHeadline === 'string' && input.commitHeadline !== ''
              ? input.commitHeadline
              : `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}`;
          if (!mergeRecord(repo, pull, message)) throw new Error('Pull request is not mergeable');
          return { pullRequest: pull, clientMutationId: input.clientMutationId ?? null };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        args: [{ name: 'input', type: 'AddCommentInput!' }],
        resolve: (_value, args) => {
          const input = isRecord(args.input) ? args.input : {};
          const text = typeof input.body === 'string' ? input.body : '';
          if (text === '') throw new Error('A body is required to add a comment');
          const decoded = decodeGlobalId(input.subjectId);
          if (decoded === null) throw new Error('Could not resolve to a node with the given id');
          if (decoded.type === 'Issue') {
            const found = issueOfId(input.subjectId);
            if (found === null) throw new Error('Could not resolve to an Issue with the given id');
            const id = forge.nextCommentId();
            const comment = { id, body: text, createdAt: nowIso };
            found.issue.comments.push(comment);
            found.issue.updatedAt = nowIso;
            return { commentEdge: { cursor: encodeCursor(0), node: comment }, comment, clientMutationId: input.clientMutationId ?? null };
          }
          if (decoded.type === 'PullRequest') {
            const found = pullOfId(input.subjectId);
            if (found === null) throw new Error('Could not resolve to a PullRequest with the given id');
            const id = forge.nextCommentId();
            const comment = { id, body: text, createdAt: nowIso };
            found.pull.updatedAt = nowIso;
            return { commentEdge: { cursor: encodeCursor(0), node: comment }, comment, clientMutationId: input.clientMutationId ?? null };
          }
          throw new Error('Could not resolve to a commentable node with the given id');
        },
      },
      __typename: { type: 'String', resolve: () => 'Mutation' },
    },

    User: {
      id: { type: 'ID', resolve: () => encodeGlobalId('User', forge.user.id) },
      databaseId: { type: 'Int', resolve: () => forge.user.id },
      login: { type: 'String', resolve: (user: { login: string }) => user.login },
      name: { type: 'String', resolve: (user: { name?: string }) => user.name ?? null },
      email: { type: 'String', resolve: (user: { email?: string }) => user.email ?? null },
      isViewer: { type: 'Boolean', resolve: () => true },
      url: { type: 'URI', resolve: (user: { login: string }) => `/${user.login}` },
      avatarUrl: { type: 'URI', resolve: (user: { login: string }) => `/avatars/u/${user.login}` },
      resourcePath: { type: 'URI', resolve: (user: { login: string }) => `/${user.login}` },
    },

    Repository: {
      id: { type: 'ID', resolve: (repo: Repo) => encodeGlobalId('Repository', repo.id) },
      databaseId: { type: 'Int', resolve: (repo: Repo) => repo.id },
      name: { type: 'String', resolve: (repo: Repo) => repo.name },
      nameWithOwner: { type: 'String', resolve: (repo: Repo) => `${repo.owner}/${repo.name}` },
      owner: { type: 'User', resolve: () => forge.user },
      description: { type: 'String', resolve: (repo: Repo) => (repo.description === '' ? null : repo.description) },
      isPrivate: { type: 'Boolean', resolve: (repo: Repo) => repo.private },
      isFork: { type: 'Boolean', resolve: () => false },
      isArchived: { type: 'Boolean', resolve: () => false },
      createdAt: { type: 'DateTime', resolve: (repo: Repo) => repo.createdAt },
      updatedAt: { type: 'DateTime', resolve: (repo: Repo) => repo.updatedAt },
      pushedAt: { type: 'DateTime', resolve: (repo: Repo) => repo.pushedAt },
      url: { type: 'URI', resolve: (repo: Repo) => `/${repo.owner}/${repo.name}` },
      resourcePath: { type: 'URI', resolve: (repo: Repo) => `/${repo.owner}/${repo.name}` },
      viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
      viewerCanAdminister: { type: 'Boolean', resolve: () => true },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      hasPullRequestsEnabled: { type: 'Boolean', resolve: () => true },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (repo: Repo) => {
          const tip = repo.branches.get(repo.defaultBranch);
          if (tip === undefined) return null;
          return { name: repo.defaultBranch, oid: tip };
        },
      },
      issue: {
        type: 'Issue',
        args: [{ name: 'number', type: 'Int!' }],
        resolve: (repo: Repo, args) => {
          const number = typeof args.number === 'number' ? args.number : Number(args.number);
          const found = repo.issues.find((issue) => issue.number === number);
          return found === undefined ? null : bindIssue(repo, found);
        },
      },
      issues: {
        type: 'IssueConnection',
        args: [
          { name: 'first', type: 'Int' },
          { name: 'last', type: 'Int' },
          { name: 'after', type: 'String' },
          { name: 'before', type: 'String' },
          { name: 'states', type: '[IssueState!]' },
          { name: 'orderBy', type: 'IssueOrder' },
          { name: 'filterBy', type: 'IssueFilters' },
          { name: 'labels', type: '[String!]' },
        ],
        resolve: (repo: Repo, args) => {
          let issues: IssueRecord[] = [...repo.issues];
          const states = stringsOf(args.states).map((state) => state.toUpperCase());
          if (states.length > 0) issues = issues.filter((issue) => states.includes(issueStateOf(issue)));
          const labels = stringsOf(args.labels);
          if (labels.length > 0) issues = issues.filter((issue) => labels.every((label) => issue.labels.includes(label)));
          const filterBy = isRecord(args.filterBy) ? args.filterBy : null;
          if (filterBy !== null && typeof filterBy.states === 'string') {
            const wanted = filterBy.states.toUpperCase();
            issues = issues.filter((issue) => issueStateOf(issue) === wanted);
          }
          return connection(sortIssues(issues, args), args, (issue) => bindIssue(repo, issue));
        },
      },
      pullRequests: {
        type: 'PullRequestConnection',
        args: [
          { name: 'first', type: 'Int' },
          { name: 'last', type: 'Int' },
          { name: 'after', type: 'String' },
          { name: 'before', type: 'String' },
          { name: 'states', type: '[PullRequestState!]' },
          { name: 'baseRefName', type: 'String' },
          { name: 'headRefName', type: 'String' },
          { name: 'orderBy', type: 'IssueOrder' },
        ],
        resolve: (repo: Repo, args) => {
          let pulls = [...repo.pulls];
          const states = stringsOf(args.states).map((state) => state.toUpperCase());
          if (states.length > 0) pulls = pulls.filter((pull) => states.includes(pullStateOf(pull)));
          if (typeof args.baseRefName === 'string') pulls = pulls.filter((pull) => pull.base === args.baseRefName);
          if (typeof args.headRefName === 'string') pulls = pulls.filter((pull) => pull.head === args.headRefName);
          pulls.sort((left, right) => right.number - left.number);
          return connection(pulls, args, (pull) => bindPull(repo, pull));
        },
      },
      pullRequest: {
        type: 'PullRequest',
        args: [{ name: 'number', type: 'Int!' }],
        resolve: (repo: Repo, args) => {
          const number = typeof args.number === 'number' ? args.number : Number(args.number);
          const found = repo.pulls.find((pull) => pull.number === number);
          return found === undefined ? null : bindPull(repo, found);
        },
      },
      ref: {
        type: 'Ref',
        args: [{ name: 'qualifiedName', type: 'String!' }],
        resolve: (repo: Repo, args) => {
          const raw = typeof args.qualifiedName === 'string' ? args.qualifiedName : '';
          const name = raw.replace(/^refs\/heads\//u, '');
          const tip = repo.branches.get(name);
          return tip === undefined ? null : { name, oid: tip };
        },
      },
      refs: {
        type: 'RefConnection',
        args: [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
          { name: 'refPrefix', type: 'String!' },
        ],
        resolve: (repo: Repo) => {
          const refs = [...repo.branches.entries()].map(([name, oid]) => ({ name, oid }));
          return { nodes: refs, totalCount: refs.length, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
        },
      },
      object: {
        type: 'Node',
        args: [{ name: 'expression', type: 'String!' }],
        resolve: (repo: Repo, args) => {
          const name = typeof args.expression === 'string' ? args.expression : '';
          const tip = repo.branches.get(name) ?? repo.commits.get(name)?.sha;
          return tip === undefined ? null : { __typename: 'Commit', value: { oid: tip } };
        },
      },
      issueOrPullRequest: {
        type: 'Node',
        args: [{ name: 'number', type: 'Int!' }],
        resolve: (repo: Repo, args) => {
          const number = typeof args.number === 'number' ? args.number : Number(args.number);
          const issue = repo.issues.find((entry) => entry.number === number);
          if (issue !== undefined) return { __typename: 'Issue', value: bindIssue(repo, issue) };
          const pull = repo.pulls.find((entry) => entry.number === number);
          if (pull !== undefined) return { __typename: 'PullRequest', value: bindPull(repo, pull) };
          return null;
        },
      },
    },

    Issue: {
      id: {
        type: 'ID',
        resolve: (issue: IssueRecord) => {
          const repo = issueRepos.get(issue);
          return repo === undefined ? encodeGlobalId('Issue', issue.id) : encodeGlobalId('Issue', `${repo.id}:${issue.id}`);
        },
      },
      databaseId: { type: 'Int', resolve: (issue: IssueRecord) => issue.id },
      number: { type: 'Int', resolve: (issue: IssueRecord) => issue.number },
      title: { type: 'String', resolve: (issue: IssueRecord) => issue.title },
      state: { type: 'IssueState', resolve: (issue: IssueRecord) => issueStateOf(issue) },
      stateReason: { type: 'IssueStateReason', resolve: (issue: IssueRecord) => (issue.state === 'closed' ? 'COMPLETED' : null) },
      body: { type: 'String', resolve: (issue: IssueRecord) => issue.body },
      bodyText: { type: 'String', resolve: (issue: IssueRecord) => issue.body },
      createdAt: { type: 'DateTime', resolve: (issue: IssueRecord) => issue.createdAt },
      updatedAt: { type: 'DateTime', resolve: (issue: IssueRecord) => issue.updatedAt },
      closedAt: { type: 'DateTime', resolve: (issue: IssueRecord) => issue.closedAt },
      isClosed: { type: 'Boolean', resolve: (issue: IssueRecord) => issue.state === 'closed' },
      isOpen: { type: 'Boolean', resolve: (issue: IssueRecord) => issue.state === 'open' },
      author: { type: 'User', resolve: () => forge.user },
      url: { type: 'URI', resolve: (issue: IssueRecord) => `/issues/${issue.number}` },
      resourcePath: { type: 'URI', resolve: (issue: IssueRecord) => `/issues/${issue.number}` },
      comments: {
        type: 'IssueCommentConnection',
        args: [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
        resolve: (issue: IssueRecord, args) => connection(issue.comments, args, (comment) => comment),
      },
      labels: {
        type: '[Label]',
        args: [{ name: 'first', type: 'Int' }],
        resolve: (issue: IssueRecord) => issue.labels.map((name) => ({ name })),
      },
    },

    PullRequest: {
      id: {
        type: 'ID',
        resolve: (pull: PullRecord) => {
          const repo = pullRepos.get(pull);
          return repo === undefined ? encodeGlobalId('PullRequest', pull.id) : encodeGlobalId('PullRequest', `${repo.id}:${pull.id}`);
        },
      },
      databaseId: { type: 'Int', resolve: (pull: PullRecord) => pull.id },
      number: { type: 'Int', resolve: (pull: PullRecord) => pull.number },
      title: { type: 'String', resolve: (pull: PullRecord) => pull.title },
      body: { type: 'String', resolve: (pull: PullRecord) => pull.body },
      state: { type: 'PullRequestState', resolve: (pull: PullRecord) => pullStateOf(pull) },
      merged: { type: 'Boolean', resolve: (pull: PullRecord) => pull.merged },
      mergedAt: { type: 'DateTime', resolve: (pull: PullRecord) => pull.mergedAt },
      isDraft: { type: 'Boolean', resolve: () => false },
      isCrossRepository: { type: 'Boolean', resolve: () => false },
      mergeable: { type: 'MergeableState', resolve: (pull: PullRecord) => mergeableOf(pull) },
      mergeStateStatus: { type: 'String', resolve: (pull: PullRecord) => (pull.state === 'open' ? 'CLEAN' : 'UNKNOWN') },
      headRefName: { type: 'String', resolve: (pull: PullRecord) => pull.head },
      baseRefName: { type: 'String', resolve: (pull: PullRecord) => pull.base },
      headRefOid: { type: 'String', resolve: (pull: PullRecord) => pull.headSha },
      baseRefOid: { type: 'String', resolve: (pull: PullRecord) => pull.baseSha },
      headRef: { type: 'Ref', resolve: (pull: PullRecord) => ({ name: pull.head, oid: pull.headSha }) },
      baseRef: { type: 'Ref', resolve: (pull: PullRecord) => ({ name: pull.base, oid: pull.baseSha }) },
      createdAt: { type: 'DateTime', resolve: (pull: PullRecord) => pull.createdAt },
      updatedAt: { type: 'DateTime', resolve: (pull: PullRecord) => pull.updatedAt },
      closedAt: { type: 'DateTime', resolve: (pull: PullRecord) => (pull.merged ? pull.mergedAt : null) },
      author: { type: 'User', resolve: () => forge.user },
      url: { type: 'URI', resolve: (pull: PullRecord) => `/pull/${pull.number}` },
      resourcePath: { type: 'URI', resolve: (pull: PullRecord) => `/pull/${pull.number}` },
      changedFiles: { type: 'Int', resolve: (pull: PullRecord) => 0 },
      additions: { type: 'Int', resolve: () => 0 },
      deletions: { type: 'Int', resolve: () => 0 },
      files: {
        type: 'PullRequestChangedFileConnection',
        args: [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
        resolve: (pull: PullRecord, args) => {
          const repo = pullRepos.get(pull) ?? null;
          const files = repo === null ? [] : changedFilesOf(forge, repo, pull);
          return connection(files, args, (file) => file);
        },
      },
      commits: {
        type: 'PullRequestCommitConnection',
        args: [
          { name: 'first', type: 'Int' },
          { name: 'after', type: 'String' },
        ],
        resolve: (pull: PullRecord, args) => {
          const repo = pullRepos.get(pull) ?? null;
          if (repo === null) return connection([], args, (entry) => entry);
          return connection(forge.pullCommits(repo, pull), args, (commit) => ({ oid: commit.sha, message: commit.message }));
        },
      },
    },

    Ref: {
      name: { type: 'String', resolve: (ref: { name: string }) => ref.name },
      target: { type: 'Node', resolve: (ref: { oid: string }) => ({ __typename: 'Commit', value: { oid: ref.oid } }) },
      repository: { type: 'Repository', resolve: () => null },
    },

    Commit: {
      oid: { type: 'String', resolve: (commit: { oid: string }) => commit.oid },
      abbreviatedOid: { type: 'String', resolve: (commit: { oid: string }) => commit.oid.slice(0, 7) },
      message: { type: 'String', resolve: (commit: { message?: string }) => commit.message ?? '' },
      messageHeadline: { type: 'String', resolve: (commit: { message?: string }) => (commit.message ?? '').split('\n')[0] ?? '' },
    },

    Label: {
      name: { type: 'String', resolve: (label: { name: string }) => label.name },
      color: { type: 'String', resolve: () => 'ededed' },
    },

    IssueConnection: {
      nodes: { type: '[Issue]', resolve: (value: { nodes: unknown[] }) => value.nodes },
      edges: { type: '[IssueEdge]', resolve: (value: { edges?: unknown[] }) => value.edges ?? [] },
      totalCount: { type: 'Int', resolve: (value: { totalCount?: number }) => value.totalCount ?? 0 },
      pageInfo: { type: 'PageInfo', resolve: (value: { pageInfo: unknown }) => value.pageInfo },
    },

    IssueEdge: {
      cursor: { type: 'String', resolve: (value: { cursor: string }) => value.cursor },
      node: { type: 'Issue', resolve: (value: { node: unknown }) => value.node },
    },

    PullRequestConnection: {
      nodes: { type: '[PullRequest]', resolve: (value: { nodes: unknown[] }) => value.nodes },
      edges: { type: '[PullRequestEdge]', resolve: (value: { edges?: unknown[] }) => value.edges ?? [] },
      totalCount: { type: 'Int', resolve: (value: { totalCount?: number }) => value.totalCount ?? 0 },
      pageInfo: { type: 'PageInfo', resolve: (value: { pageInfo: unknown }) => value.pageInfo },
    },

    PullRequestEdge: {
      cursor: { type: 'String', resolve: (value: { cursor: string }) => value.cursor },
      node: { type: 'PullRequest', resolve: (value: { node: unknown }) => value.node },
    },

    PullRequestChangedFileConnection: {
      nodes: { type: '[PullRequestChangedFile]', resolve: (value: { nodes: unknown[] }) => value.nodes },
      totalCount: { type: 'Int', resolve: (value: { totalCount?: number }) => value.totalCount ?? 0 },
      pageInfo: { type: 'PageInfo', resolve: (value: { pageInfo: unknown }) => value.pageInfo },
    },

    PullRequestChangedFile: {
      path: { type: 'String', resolve: (file: ChangedFile) => file.path },
      additions: { type: 'Int', resolve: (file: ChangedFile) => file.additions },
      deletions: { type: 'Int', resolve: (file: ChangedFile) => file.deletions },
      changeType: { type: 'String', resolve: (file: ChangedFile) => file.status.toUpperCase() },
      viewerViewedState: { type: 'String', resolve: () => 'UNVIEWED' },
    },

    PullRequestCommitConnection: {
      nodes: { type: '[Commit]', resolve: (value: { nodes: unknown[] }) => value.nodes },
      totalCount: { type: 'Int', resolve: (value: { totalCount?: number }) => value.totalCount ?? 0 },
      pageInfo: { type: 'PageInfo', resolve: (value: { pageInfo: unknown }) => value.pageInfo },
    },

    RefConnection: {
      nodes: { type: '[Ref]', resolve: (value: { nodes: unknown[] }) => value.nodes },
      totalCount: { type: 'Int', resolve: (value: { totalCount?: number }) => value.totalCount ?? 0 },
      pageInfo: { type: 'PageInfo', resolve: (value: { pageInfo: unknown }) => value.pageInfo },
    },

    IssueCommentConnection: {
      nodes: { type: '[IssueComment]', resolve: (value: { nodes: unknown[] }) => value.nodes },
      totalCount: { type: 'Int', resolve: (value: { totalCount?: number }) => value.totalCount ?? 0 },
      pageInfo: { type: 'PageInfo', resolve: (value: { pageInfo: unknown }) => value.pageInfo },
    },

    IssueComment: {
      id: { type: 'ID', resolve: (comment: { id: number }) => encodeGlobalId('IssueComment', comment.id) },
      databaseId: { type: 'Int', resolve: (comment: { id: number }) => comment.id },
      body: { type: 'String', resolve: (comment: { body: string }) => comment.body },
      bodyText: { type: 'String', resolve: (comment: { body: string }) => comment.body },
      createdAt: { type: 'DateTime', resolve: (comment: { createdAt: string }) => comment.createdAt },
      author: { type: 'User', resolve: () => forge.user },
    },

    CommentEdge: {
      cursor: { type: 'String', resolve: (value: { cursor: string }) => value.cursor },
      node: { type: 'IssueComment', resolve: (value: { node: unknown }) => value.node },
    },

    PageInfo: {
      hasNextPage: { type: 'Boolean', resolve: (value: { hasNextPage: boolean }) => value.hasNextPage },
      hasPreviousPage: { type: 'Boolean', resolve: (value: { hasPreviousPage: boolean }) => value.hasPreviousPage },
      startCursor: { type: 'String', resolve: (value: { startCursor: string | null }) => value.startCursor },
      endCursor: { type: 'String', resolve: (value: { endCursor: string | null }) => value.endCursor },
    },

    CreateIssuePayload: {
      issue: { type: 'Issue', resolve: (value: { issue: unknown }) => value.issue },
      clientMutationId: { type: 'String', resolve: (value: { clientMutationId: unknown }) => value.clientMutationId },
    },
    CloseIssuePayload: {
      issue: { type: 'Issue', resolve: (value: { issue: unknown }) => value.issue },
      clientMutationId: { type: 'String', resolve: (value: { clientMutationId: unknown }) => value.clientMutationId },
    },
    ReopenIssuePayload: {
      issue: { type: 'Issue', resolve: (value: { issue: unknown }) => value.issue },
      clientMutationId: { type: 'String', resolve: (value: { clientMutationId: unknown }) => value.clientMutationId },
    },
    CreatePullRequestPayload: {
      pullRequest: { type: 'PullRequest', resolve: (value: { pullRequest: unknown }) => value.pullRequest },
      clientMutationId: { type: 'String', resolve: (value: { clientMutationId: unknown }) => value.clientMutationId },
    },
    MergePullRequestPayload: {
      pullRequest: { type: 'PullRequest', resolve: (value: { pullRequest: unknown }) => value.pullRequest },
      clientMutationId: { type: 'String', resolve: (value: { clientMutationId: unknown }) => value.clientMutationId },
    },
    AddCommentPayload: {
      commentEdge: { type: 'CommentEdge', resolve: (value: { commentEdge: unknown }) => value.commentEdge },
      comment: { type: 'IssueComment', resolve: (value: { comment?: unknown }) => value.comment ?? null },
      subject: { type: 'Node', resolve: () => null },
      clientMutationId: { type: 'String', resolve: (value: { clientMutationId: unknown }) => value.clientMutationId },
    },

    __Schema: {
      queryType: { type: '__Type', resolve: () => typeIntrospection('Query') },
      mutationType: { type: '__Type', resolve: () => typeIntrospection('Mutation') },
      subscriptionType: { type: '__Type', resolve: () => null },
      types: {
        type: '[__Type]',
        resolve: () => [...Object.keys(schema).map((name) => typeIntrospection(name)), ...Object.keys(ENUMS).map((name) => typeIntrospection(name))],
      },
      directives: { type: '[__Directive]', resolve: () => [] },
    },

    __Type: {
      kind: { type: 'String', resolve: (value: { kind: string }) => value.kind },
      name: { type: 'String', resolve: (value: { name: string | null }) => value.name },
      description: { type: 'String', resolve: (value: { description?: string | null }) => value.description ?? null },
      fields: {
        type: '[__Field]',
        args: [{ name: 'includeDeprecated', type: 'Boolean' }],
        resolve: (value: { fields?: unknown[] | null }) => value.fields ?? null,
      },
      enumValues: {
        type: '[__EnumValue]',
        args: [{ name: 'includeDeprecated', type: 'Boolean' }],
        resolve: (value: { enumValues?: unknown[] | null }) => value.enumValues ?? null,
      },
      inputFields: {
        type: '[__InputValue]',
        args: [{ name: 'includeDeprecated', type: 'Boolean' }],
        resolve: (value: { inputFields?: unknown[] | null }) => value.inputFields ?? null,
      },
      interfaces: { type: '[__Type]', resolve: () => [] },
      possibleTypes: { type: '[__Type]', resolve: () => null },
      ofType: { type: '__Type', resolve: () => null },
    },

    __Field: {
      name: { type: 'String', resolve: (value: { name: string }) => value.name },
      description: { type: 'String', resolve: (value: { description?: string | null }) => value.description ?? null },
      isDeprecated: { type: 'Boolean', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
      args: { type: '[__InputValue]', resolve: (value: { args?: unknown[] }) => value.args ?? [] },
      type: { type: '__Type', resolve: (value: { type: unknown }) => value.type },
    },

    __EnumValue: {
      name: { type: 'String', resolve: (value: { name: string }) => value.name },
      description: { type: 'String', resolve: (value: { description?: string | null }) => value.description ?? null },
      isDeprecated: { type: 'Boolean', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
    },

    __InputValue: {
      name: { type: 'String', resolve: (value: { name: string }) => value.name },
      description: { type: 'String', resolve: () => null },
      defaultValue: { type: 'String', resolve: () => null },
      type: { type: '__Type', resolve: (value: { type: unknown }) => value.type },
    },

    __Directive: {
      name: { type: 'String', resolve: (value: { name: string }) => value.name },
      description: { type: 'String', resolve: () => null },
      locations: { type: '[String]', resolve: () => [] },
      args: { type: '[__InputValue]', resolve: () => [] },
      isRepeatable: { type: 'Boolean', resolve: () => false },
    },
  };


  /** A `__Type` object for one type name, from the resolver table or the enum table. */
  function typeIntrospection(name: string): Record<string, unknown> | null {
    if (name === '') return null;
    const enums = ENUMS[name];
    if (enums !== undefined) {
      return {
        kind: 'ENUM',
        name,
        description: null,
        fields: null,
        enumValues: enums.map((value) => ({ name: value, description: null })),
        inputFields: null,
      };
    }
    if (SCALARS.has(name)) {
      return { kind: 'SCALAR', name, description: null, fields: null, enumValues: null, inputFields: null };
    }
    const inputs = INPUT_TYPES[name];
    if (inputs !== undefined) {
      return {
        kind: 'INPUT_OBJECT',
        name,
        description: null,
        fields: null,
        enumValues: null,
        inputFields: inputs.map((arg) => ({ name: arg.name, type: typeRef(arg.type) })),
      };
    }
    if (name === 'Node') {
      return {
        kind: 'INTERFACE',
        name,
        description: null,
        fields: [
          { name: 'id', type: typeRef('ID!'), args: [] },
          { name: '__typename', type: typeRef('String!'), args: [] },
        ],
        enumValues: null,
        inputFields: null,
      };
    }
    const fields = schema[name];
    if (fields === undefined) return null;
    return {
      kind: 'OBJECT',
      name,
      description: null,
      fields: Object.entries(fields).map(([fieldName, definition]) => ({
        name: fieldName,
        description: null,
        isDeprecated: false,
        args: (definition.args ?? []).map((arg) => ({ name: arg.name, type: typeRef(arg.type) })),
        type: typeRef(definition.type),
      })),
      enumValues: null,
      inputFields: null,
    };
  }

  return schema;
}

/** A `__Type` reference for a type expression (`[Issue!]!` unwraps to its named type). */
function typeRef(expression: string): Record<string, unknown> {
  let text = expression.trim();
  let wrapper = 0;
  while (text.startsWith('[')) {
    text = text.slice(1, text.lastIndexOf(']'));
    wrapper += 1;
  }
  text = text.replace(/!$/u, '');
  const base = SCALARS.has(text) ? { kind: 'SCALAR', name: text } : ENUMS[text] !== undefined ? { kind: 'ENUM', name: text } : INPUT_TYPES[text] !== undefined ? { kind: 'INPUT_OBJECT', name: text } : { kind: 'OBJECT', name: text };
  if (wrapper === 0) return base;
  let current: Record<string, unknown> = base;
  for (let index = 0; index < wrapper; index += 1) current = { kind: 'LIST', name: null, ofType: current };
  return current;
}

// ---------------------------------------------------------------------------------------------------
// The executor: walk a selection set against the resolver table.
// ---------------------------------------------------------------------------------------------------

interface CollectedField {
  readonly key: string;
  readonly field: FieldNode;
}

/** The root value of every operation: the resolvers of Query and Mutation take no parent object. */
const ROOT_VALUE: Readonly<Record<string, never>> = Object.freeze({});

class Executor {
  private readonly forge: Forge;
  private readonly variables: Readonly<Record<string, unknown>>;
  private readonly fragments: Map<string, FragmentNode>;
  private readonly schema: SchemaTable;
  private readonly errors: { message: string; path?: (string | number)[] }[] = [];

  constructor(forge: Forge, variables: Readonly<Record<string, unknown>>, fragments: Map<string, FragmentNode>) {
    this.forge = forge;
    this.variables = variables;
    this.fragments = fragments;
    this.schema = buildSchema(forge);
  }

  /** Run one operation and answer the {data, errors} envelope. */
  run(operation: OperationNode): Record<string, unknown> {
    const variables: Record<string, unknown> = { ...this.variables };
    for (const definition of operation.variables) {
      if (variables[definition.name] === undefined && definition.defaultValue !== null) {
        variables[definition.name] = valueOf(definition.defaultValue, this.variables);
      }
    }
    const bound = new Executor(this.forge, variables, this.fragments);
    const root = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const data = bound.project(root, ROOT_VALUE, operation.selections, []);
    const envelope: Record<string, unknown> = { data };
    if (bound.errors.length > 0) envelope.errors = bound.errors;
    return envelope;
  }

  private error(message: string, path?: (string | number)[]): void {
    this.errors.push(path === undefined ? { message } : { message, path });
  }

  /** The fields a selection set asks for on one concrete type, fragments flattened in. */
  private collectFields(typeName: string, selections: readonly SelectionNode[], visited: Set<string> = new Set()): CollectedField[] {
    const out: CollectedField[] = [];
    for (const selection of selections) {
      if (selection.kind === 'field') {
        if (!this.included(selection.field.directives)) continue;
        out.push({ key: selection.field.alias ?? selection.field.name, field: selection.field });
        continue;
      }
      if (selection.kind === 'inline') {
        if (!this.included(selection.directives)) continue;
        if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
        out.push(...this.collectFields(typeName, selection.selections, visited));
        continue;
      }
      if (!this.included(selection.directives)) continue;
      const fragment = this.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== typeName) continue;
      if (visited.has(selection.name)) continue;
      visited.add(selection.name);
      out.push(...this.collectFields(typeName, fragment.selections, visited));
    }
    return out;
  }

  /** Whether `@skip`/`@include` leave a selection in. */
  private included(directives: readonly DirectiveNode[]): boolean {
    for (const directive of directives) {
      const args = argumentsOf(directive.args, this.variables);
      if (directive.name === 'skip' && args.if === true) return false;
      if (directive.name === 'include' && args.if === false) return false;
    }
    return true;
  }

  /** Project a selection set over a value of one type. */
  project(typeName: string, value: unknown, selections: readonly SelectionNode[], path: (string | number)[]): unknown {
    if (typeName === 'Node') {
      if (!isRecord(value)) return null;
      const concrete = value.__typename;
      if (typeof concrete !== 'string') return null;
      return this.project(concrete, value.value, selections, path);
    }
    if (value === null || value === undefined) return null;
    const fields = this.collectFields(typeName, selections);
    const out: Record<string, unknown> = {};
    const definitions = this.schema[typeName];
    for (const entry of fields) {
      const field = entry.field;
      if (field.name === '__typename') {
        out[entry.key] = typeName;
        continue;
      }
      const definition = definitions === undefined ? undefined : definitions[field.name];
      if (definition === undefined) {
        this.error(`Cannot query field "${field.name}" on type "${typeName}".`, [...path, entry.key]);
        out[entry.key] = null;
        continue;
      }
      const args = argumentsOf(field.args, this.variables);
      let raw: unknown;
      try {
        raw = definition.resolve(value as never, args);
      } catch (err) {
        this.error(err instanceof Error ? err.message : String(err), [...path, entry.key]);
        out[entry.key] = null;
        continue;
      }
      out[entry.key] = this.projectValue(definition.type, raw, field.selections, [...path, entry.key]);
    }
    return out;
  }

  /** Project one field value, unwrapping a list type expression. */
  private projectValue(typeExpression: string, value: unknown, selections: readonly SelectionNode[], path: (string | number)[]): unknown {
    if (typeExpression.startsWith('[')) {
      const inner = typeExpression.slice(1, typeExpression.lastIndexOf(']'));
      if (!Array.isArray(value)) return value === null || value === undefined ? null : [];
      return value.map((entry, index) => this.projectValue(inner, entry, selections, [...path, index]));
    }
    const bare = typeExpression.replace(/!$/u, '');
    if (this.schema[bare] !== undefined || bare === 'Node') {
      return this.project(bare, value, selections, path);
    }
    return value === undefined ? null : value;
  }
}

// ---------------------------------------------------------------------------------------------------
// The HTTP surface: POST /api/graphql.
// ---------------------------------------------------------------------------------------------------

export interface GraphQLHttpRequest {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly forge: Forge;
  readonly requestId: string;
  readonly method: string;
  readonly body: unknown;
}

/** Run one request body entry (one operation, or one entry of a batch). */
function runOne(forge: Forge, entry: unknown): Record<string, unknown> {
  if (!isRecord(entry) || typeof entry.query !== 'string') {
    return { errors: [{ message: 'A GraphQL request body needs a "query" string' }] };
  }
  const variables = isRecord(entry.variables) ? entry.variables : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  let parsed: ParsedDocument;
  try {
    parsed = parseDocument(entry.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (parsed.operations.length === 0) return { errors: [{ message: 'The document holds no operation' }] };
  let operation = parsed.operations[0] as OperationNode;
  if (operationName !== null) {
    const found = parsed.operations.find((candidate) => candidate.name === operationName);
    if (found === undefined) return { errors: [{ message: `Unknown operation named "${operationName}"` }] };
    operation = found;
  }
  try {
    return new Executor(forge, variables, parsed.fragments).run(operation);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

/**
 * Answer one GraphQL v4 request: 401 without the trial's bearer token, 200 with {data, errors} for one
 * operation, or a JSON array of the same for a batched body (GitHub's operation batching).
 */
export function handleGraphQL(request: GraphQLHttpRequest): void {
  const { req, res, forge, requestId, method, body } = request;
  if (method !== 'POST') return sendJson(res, requestId, 404, { message: 'Not Found' });
  const token = bearerOf(req);
  if (token === null) return sendJson(res, requestId, 401, { message: 'Requires authentication' });
  if (!forge.authenticate(token)) return sendJson(res, requestId, 401, { message: 'Bad credentials' });
  if (Array.isArray(body)) {
    if (body.length === 0) return sendJson(res, requestId, 400, { message: 'No operations were supplied' });
    return sendJson(res, requestId, 200, body.map((entry) => runOne(forge, entry)));
  }
  if (!isRecord(body)) return sendJson(res, requestId, 400, { message: 'Problems parsing JSON' });
  return sendJson(res, requestId, 200, runOne(forge, body));
}
