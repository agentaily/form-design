// vfs.js — Virtual File System (SPEC §2).
// An in-memory map that the Agent edits and the renderer reads from.
// Operations mutate the vfs object in place (matches "改写 VFS" in the spec).

/** @typedef {{ path: string, content: string, type: 'html'|'jsx'|'json', updatedAt: number }} VFile */
/** @typedef {Record<string, VFile>} VFS */

const EXT_TYPE = { html: "html", htm: "html", jsx: "jsx", js: "jsx", json: "json" };

/** Infer a VFile.type from its path extension. Unknown → 'jsx'. */
export function inferType(path) {
  const ext = String(path).split(".").pop().toLowerCase();
  return EXT_TYPE[ext] || "jsx";
}

function makeFile(path, content, type) {
  return { path, content, type: type || inferType(path), updatedAt: Date.now() };
}

/** Create a VFS from a `{ path: content }` map. */
export function createVfs(files = {}) {
  /** @type {VFS} */
  const vfs = {};
  for (const [path, content] of Object.entries(files)) {
    vfs[path] = makeFile(path, content);
  }
  return vfs;
}

/** Sorted list of file paths (the "file tree"). */
export function listFiles(vfs) {
  return Object.keys(vfs).sort();
}

/** Read a file's content. Throws if missing. */
export function readFile(vfs, path) {
  const f = vfs[path];
  if (!f) throw new Error(`File not found: ${path}`);
  return f.content;
}

/** Create or fully overwrite a file. */
export function writeFile(vfs, path, content, type) {
  vfs[path] = makeFile(path, content, type);
  return vfs[path];
}

/**
 * Replace the single unique occurrence of `oldStr` with `newStr`.
 * Throws if the file is missing, `oldStr` is empty, or it does not match exactly once.
 */
export function strReplace(vfs, path, oldStr, newStr) {
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
export function deleteFile(vfs, path) {
  if (!vfs[path]) throw new Error(`File not found: ${path}`);
  delete vfs[path];
  return true;
}
