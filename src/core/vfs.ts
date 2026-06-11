// vfs.ts — Virtual File System (SPEC §2).
// An in-memory map that the Agent edits and the renderer reads from.
// Operations mutate the vfs object in place (matches "改写 VFS" in the spec).

export type VFileType = "html" | "jsx" | "json";

export interface VFile {
  path: string;
  content: string;
  type: VFileType;
  updatedAt: number;
}

export type VFS = Record<string, VFile>;

const EXT_TYPE: Record<string, VFileType> = {
  html: "html",
  htm: "html",
  jsx: "jsx",
  js: "jsx",
  json: "json",
};

/** Infer a VFile.type from its path extension. Unknown → 'jsx'. */
export function inferType(path: string): VFileType {
  const ext = (String(path).split(".").pop() || "").toLowerCase();
  return EXT_TYPE[ext] || "jsx";
}

function makeFile(path: string, content: string, type?: VFileType): VFile {
  return { path, content, type: type || inferType(path), updatedAt: Date.now() };
}

/** Create a VFS from a `{ path: content }` map. */
export function createVfs(files: Record<string, string> = {}): VFS {
  const vfs: VFS = {};
  for (const [path, content] of Object.entries(files)) {
    vfs[path] = makeFile(path, content);
  }
  return vfs;
}

/** Sorted list of file paths (the "file tree"). */
export function listFiles(vfs: VFS): string[] {
  return Object.keys(vfs).sort();
}

/** Read a file's content. Throws if missing. */
export function readFile(vfs: VFS, path: string): string {
  const f = vfs[path];
  if (!f) throw new Error(`File not found: ${path}`);
  return f.content;
}

/** Create or fully overwrite a file. */
export function writeFile(vfs: VFS, path: string, content: string, type?: VFileType): VFile {
  vfs[path] = makeFile(path, content, type);
  return vfs[path];
}

/**
 * Replace the single unique occurrence of `oldStr` with `newStr`.
 * Throws if the file is missing, `oldStr` is empty, or it does not match exactly once.
 */
export function strReplace(vfs: VFS, path: string, oldStr: string, newStr: string): VFile {
  const f = vfs[path];
  if (!f) throw new Error(`File not found: ${path}`);
  if (oldStr === "") throw new Error("old_str must not be empty");
  const count = f.content.split(oldStr).length - 1;
  if (count === 0) throw new Error(`old_str not found in ${path}`);
  if (count > 1) throw new Error(`old_str is not unique in ${path} (${count} matches)`);
  f.content = f.content.replace(oldStr, newStr);
  f.updatedAt = Date.now();
  return f;
}

/** Delete a file. Throws if missing. */
export function deleteFile(vfs: VFS, path: string): boolean {
  if (!vfs[path]) throw new Error(`File not found: ${path}`);
  delete vfs[path];
  return true;
}
