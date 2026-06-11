import { describe, it, expect } from "vitest";
import {
  createVfs,
  inferType,
  listFiles,
  readFile,
  writeFile,
  strReplace,
  deleteFile,
} from "../../src/core/vfs";

describe("vfs · type inference", () => {
  it("maps extensions to VFile types", () => {
    expect(inferType("/index.html")).toBe("html");
    expect(inferType("/form.jsx")).toBe("jsx");
    expect(inferType("/app.js")).toBe("jsx");
    expect(inferType("/schema.json")).toBe("json");
  });

  it("defaults unknown extensions to jsx", () => {
    expect(inferType("/weird.xyz")).toBe("jsx");
  });
});

describe("vfs · createVfs + listFiles", () => {
  it("builds files with inferred type and a timestamp", () => {
    const vfs = createVfs({ "/index.html": "<head></head>", "/form.jsx": "x" });
    expect(vfs["/index.html"].type).toBe("html");
    expect(vfs["/form.jsx"].type).toBe("jsx");
    expect(typeof vfs["/form.jsx"].updatedAt).toBe("number");
  });

  it("lists paths sorted", () => {
    const vfs = createVfs({ "/b.jsx": "1", "/a.jsx": "2" });
    expect(listFiles(vfs)).toEqual(["/a.jsx", "/b.jsx"]);
  });
});

describe("vfs · readFile / writeFile", () => {
  it("writes then reads content back", () => {
    const vfs = createVfs();
    writeFile(vfs, "/form.jsx", "hello");
    expect(readFile(vfs, "/form.jsx")).toBe("hello");
  });

  it("write overwrites existing content", () => {
    const vfs = createVfs({ "/form.jsx": "old" });
    writeFile(vfs, "/form.jsx", "new");
    expect(readFile(vfs, "/form.jsx")).toBe("new");
  });

  it("reading a missing file throws", () => {
    const vfs = createVfs();
    expect(() => readFile(vfs, "/nope.jsx")).toThrow(/not found/i);
  });
});

describe("vfs · strReplace", () => {
  it("replaces a unique occurrence in place", () => {
    const vfs = createVfs({ "/form.jsx": "const a = 1; const b = 2;" });
    strReplace(vfs, "/form.jsx", "const b = 2;", "const b = 3;");
    expect(readFile(vfs, "/form.jsx")).toBe("const a = 1; const b = 3;");
  });

  it("throws when old_str is not found", () => {
    const vfs = createVfs({ "/form.jsx": "abc" });
    expect(() => strReplace(vfs, "/form.jsx", "xyz", "q")).toThrow(/not found/i);
  });

  it("throws when old_str is not unique (the spec's uniqueness rule)", () => {
    const vfs = createVfs({ "/form.jsx": "x x x" });
    expect(() => strReplace(vfs, "/form.jsx", "x", "y")).toThrow(/not unique/i);
  });

  it("throws on empty old_str", () => {
    const vfs = createVfs({ "/form.jsx": "abc" });
    expect(() => strReplace(vfs, "/form.jsx", "", "q")).toThrow(/empty/i);
  });
});

describe("vfs · deleteFile", () => {
  it("removes the file", () => {
    const vfs = createVfs({ "/form.jsx": "x" });
    deleteFile(vfs, "/form.jsx");
    expect(listFiles(vfs)).toEqual([]);
  });

  it("throws when deleting a missing file", () => {
    const vfs = createVfs();
    expect(() => deleteFile(vfs, "/nope.jsx")).toThrow(/not found/i);
  });
});
