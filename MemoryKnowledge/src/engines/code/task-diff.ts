import { createHash } from "node:crypto";

export type TaskCodeChangeType = "added" | "modified" | "deleted";
export type TaskCodeEntityKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "type"
  | "variable"
  | "route"
  | "component";

export interface TaskCodeFileChange {
  path: string;
  change_type: TaskCodeChangeType;
  additions: number;
  deletions: number;
}

export interface TaskCodeEntityChange {
  stable_key: string;
  name: string;
  kind: TaskCodeEntityKind;
  path: string;
  change_type: TaskCodeChangeType;
  before_signature?: string;
  after_signature?: string;
  line?: number;
}

export interface TaskCodeRelationChange {
  stable_key: string;
  source: string;
  target: string;
  kind: "imports" | "calls" | "inherits";
  path: string;
  change_type: TaskCodeChangeType;
}

export interface TaskCodeGraphDiff {
  files: TaskCodeFileChange[];
  entities: TaskCodeEntityChange[];
  relations: TaskCodeRelationChange[];
  summary: {
    files: number;
    entities: number;
    relations: number;
    added: number;
    modified: number;
    deleted: number;
  };
}

export interface BuildTaskCodeGraphDiffInput {
  patch: string;
  /** 可选的完整快照。提供时用快照比较实体；patch 仍用于确定文件范围和行级变化。 */
  before_files?: Record<string, string>;
  after_files?: Record<string, string>;
}

interface PatchLine {
  text: string;
  line?: number;
}

interface PatchFile {
  oldPath: string;
  newPath: string;
  added: PatchLine[];
  removed: PatchLine[];
  additions: number;
  deletions: number;
}

interface ParsedEntity {
  stable_key: string;
  name: string;
  kind: TaskCodeEntityKind;
  path: string;
  signature: string;
  fingerprint: string;
  line?: number;
}

interface ParsedRelation {
  stable_key: string;
  source: string;
  target: string;
  kind: TaskCodeRelationChange["kind"];
  path: string;
}

const CALL_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "throw", "typeof", "sizeof",
  "def", "class", "function", "func", "new", "super", "this", "print",
]);

const CODE_EXTENSIONS = new Set([
  ".py", ".pyi", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".java", ".kt",
  ".kts", ".go", ".rs", ".c", ".h", ".hh", ".cc", ".cpp", ".cxx", ".hpp", ".cs", ".php", ".rb",
  ".swift", ".scala", ".vue", ".svelte",
]);

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function normalizePath(value: string): string {
  return value.replace(/^([ab])\//, "").replace(/\\/g, "/");
}

function stableEntityKey(path: string, kind: TaskCodeEntityKind, name: string): string {
  return `${normalizePath(path)}:${kind}:${name}`;
}

function isCodePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && CODE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const line of patch.split(/\r?\n/)) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) {
      current = {
        oldPath: normalizePath(header[1]),
        newPath: normalizePath(header[2]),
        added: [],
        removed: [],
        additions: 0,
        deletions: 0,
      };
      files.push(current);
      oldLine = undefined;
      newLine = undefined;
      continue;
    }
    if (!current) continue;

    if (line.startsWith("--- ")) {
      const raw = line.slice(4).trim();
      current.oldPath = raw === "/dev/null" ? "" : normalizePath(raw);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const raw = line.slice(4).trim();
      current.newPath = raw === "/dev/null" ? "" : normalizePath(raw);
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.added.push({ text: line.slice(1), line: newLine });
      current.additions += 1;
      if (newLine !== undefined) newLine += 1;
      continue;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      current.removed.push({ text: line.slice(1), line: oldLine });
      current.deletions += 1;
      if (oldLine !== undefined) oldLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      if (oldLine !== undefined) oldLine += 1;
      if (newLine !== undefined) newLine += 1;
    }
  }
  return files;
}

function classifyFile(file: PatchFile): TaskCodeChangeType {
  if (!file.oldPath) return "added";
  if (!file.newPath) return "deleted";
  return "modified";
}

function entityFromLine(path: string, text: string, line?: number): ParsedEntity | undefined {
  const trimmed = text.trim();
  const patterns: Array<{ re: RegExp; kind: TaskCodeEntityKind; nameIndex: number }> = [
    { re: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, kind: "function", nameIndex: 1 },
    { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/, kind: "function", nameIndex: 1 },
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/, kind: "function", nameIndex: 1 },
    { re: /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class", nameIndex: 1 },
    { re: /^class\s+([A-Za-z_]\w*)/, kind: "class", nameIndex: 1 },
    { re: /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface", nameIndex: 1 },
    { re: /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[={]/, kind: "type", nameIndex: 1 },
    { re: /^type\s+([A-Za-z_]\w*)\s+/, kind: "type", nameIndex: 1 },
    { re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, kind: "function", nameIndex: 1 },
  ];
  for (const pattern of patterns) {
    const match = trimmed.match(pattern.re);
    if (!match) continue;
    const name = match[pattern.nameIndex];
    return {
      stable_key: stableEntityKey(path, pattern.kind, name),
      name,
      kind: pattern.kind,
      path,
      signature: trimmed,
      fingerprint: hash(trimmed),
      line,
    };
  }
  return undefined;
}

function relationsFromLine(path: string, text: string, source: string): ParsedRelation[] {
  const trimmed = text.trim();
  const relations: ParsedRelation[] = [];
  const add = (target: string, kind: ParsedRelation["kind"]) => {
    if (!target || target === source) return;
    const stableKey = `${path}:${kind}:${source}->${target}`;
    relations.push({ stable_key: stableKey, source, target, kind, path });
  };

  const pyImport = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)$/);
  if (pyImport) add(pyImport[1], "imports");
  const directImport = trimmed.match(/^import\s+([\w./@-]+)/);
  if (directImport) add(directImport[1], "imports");
  const jsImport = trimmed.match(/\bfrom\s+["']([^"']+)["']/) ?? trimmed.match(/require\(["']([^"']+)["']\)/);
  if (jsImport) add(jsImport[1], "imports");
  const include = trimmed.match(/^#include\s*[<"]([^>"]+)[>"]/);
  if (include) add(include[1], "imports");

  const inheritance = trimmed.match(/\bclass\s+[A-Za-z_$][\w$]*\s*(?:extends\s+([A-Za-z_$][\w$]*)|\(([^)]+)\))/);
  const parent = inheritance?.[1] ?? inheritance?.[2]?.split(",")[0]?.trim();
  if (parent) add(parent, "inherits");

  for (const match of trimmed.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const target = match[1];
    if (!CALL_KEYWORDS.has(target)) add(target, "calls");
  }
  return relations;
}

function scanLines(path: string, lines: PatchLine[]): { entities: ParsedEntity[]; relations: ParsedRelation[] } {
  const entities: ParsedEntity[] = [];
  const relations: ParsedRelation[] = [];
  let currentSource = path;
  for (const line of lines) {
    const entity = entityFromLine(path, line.text, line.line);
    if (entity) {
      entities.push(entity);
      currentSource = entity.name;
    }
    relations.push(...relationsFromLine(path, line.text, currentSource));
  }
  return { entities, relations };
}

function scanContent(path: string, content: string): { entities: ParsedEntity[]; relations: ParsedRelation[] } {
  const lines = content.split(/\r?\n/);
  const entities = lines
    .map((text, index) => entityFromLine(path, text, index + 1))
    .filter((item): item is ParsedEntity => Boolean(item));
  for (let index = 0; index < entities.length; index += 1) {
    const start = (entities[index].line ?? 1) - 1;
    const end = index + 1 < entities.length ? (entities[index + 1].line ?? lines.length + 1) - 1 : lines.length;
    entities[index].fingerprint = hash(lines.slice(start, end).join("\n").trim());
  }

  const relations: ParsedRelation[] = [];
  let currentSource = path;
  for (let index = 0; index < lines.length; index += 1) {
    const entity = entityFromLine(path, lines[index], index + 1);
    if (entity) currentSource = entity.name;
    relations.push(...relationsFromLine(path, lines[index], currentSource));
  }
  return { entities, relations };
}

function diffEntities(before: ParsedEntity[], after: ParsedEntity[]): TaskCodeEntityChange[] {
  const oldByKey = new Map(before.map((item) => [item.stable_key, item]));
  const newByKey = new Map(after.map((item) => [item.stable_key, item]));
  const keys = new Set([...oldByKey.keys(), ...newByKey.keys()]);
  const result: TaskCodeEntityChange[] = [];
  for (const key of keys) {
    const oldItem = oldByKey.get(key);
    const newItem = newByKey.get(key);
    if (oldItem && newItem && oldItem.fingerprint === newItem.fingerprint) continue;
    const item = newItem ?? oldItem!;
    result.push({
      stable_key: key,
      name: item.name,
      kind: item.kind,
      path: item.path,
      change_type: oldItem && newItem ? "modified" : newItem ? "added" : "deleted",
      before_signature: oldItem?.signature,
      after_signature: newItem?.signature,
      line: newItem?.line ?? oldItem?.line,
    });
  }
  return result;
}

function diffRelations(before: ParsedRelation[], after: ParsedRelation[]): TaskCodeRelationChange[] {
  const oldByKey = new Map(before.map((item) => [item.stable_key, item]));
  const newByKey = new Map(after.map((item) => [item.stable_key, item]));
  const result: TaskCodeRelationChange[] = [];
  for (const key of new Set([...oldByKey.keys(), ...newByKey.keys()])) {
    const oldItem = oldByKey.get(key);
    const newItem = newByKey.get(key);
    if (oldItem && newItem) continue;
    const item = newItem ?? oldItem!;
    result.push({ ...item, change_type: newItem ? "added" : "deleted" });
  }
  return result;
}

function uniqueByKey<T extends { stable_key: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.stable_key, item])).values()];
}

export function buildTaskCodeGraphDiff(input: BuildTaskCodeGraphDiffInput): TaskCodeGraphDiff {
  const patchFiles = parsePatch(input.patch);
  const files = patchFiles.map((file) => ({
    path: file.newPath || file.oldPath,
    change_type: classifyFile(file),
    additions: file.additions,
    deletions: file.deletions,
  }));
  const entities: TaskCodeEntityChange[] = [];
  const relations: TaskCodeRelationChange[] = [];

  for (const file of patchFiles) {
    const path = file.newPath || file.oldPath;
    if (!isCodePath(path)) continue;
    const hasSnapshots = input.before_files?.[path] !== undefined || input.after_files?.[path] !== undefined;
    const before = hasSnapshots
      ? scanContent(path, input.before_files?.[path] ?? "")
      : scanLines(path, file.removed);
    const after = hasSnapshots
      ? scanContent(path, input.after_files?.[path] ?? "")
      : scanLines(path, file.added);
    entities.push(...diffEntities(before.entities, after.entities));
    relations.push(...diffRelations(before.relations, after.relations));
  }

  const uniqueEntities = uniqueByKey(entities);
  const uniqueRelations = uniqueByKey(relations);
  return {
    files,
    entities: uniqueEntities,
    relations: uniqueRelations,
    summary: {
      files: files.length,
      entities: uniqueEntities.length,
      relations: uniqueRelations.length,
      added: uniqueEntities.filter((item) => item.change_type === "added").length,
      modified: uniqueEntities.filter((item) => item.change_type === "modified").length,
      deleted: uniqueEntities.filter((item) => item.change_type === "deleted").length,
    },
  };
}
