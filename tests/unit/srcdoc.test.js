import { describe, it, expect } from "vitest";
import { buildSrcDoc, assembleHtml, CDN_SCRIPTS } from "../../src/core/srcdoc";
import { createVfs } from "../../src/core/vfs";

describe("srcdoc · assembleHtml", () => {
  it("produces a standalone doc with #root, React/Babel CDN, and the jsx blocks", () => {
    const html = assembleHtml("<title>t</title>", '<script type="text/babel">X</script>');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain("<title>t</title>");
    expect(html).toContain('<script type="text/babel">X</script>');
    expect(html).toContain("react@18.3.1");
    expect(html).toContain("@babel/standalone");
  });

  it("includes SRI integrity hashes on CDN scripts", () => {
    const html = assembleHtml("", "");
    for (const s of CDN_SCRIPTS) {
      expect(html).toContain(`integrity="${s.integrity}"`);
    }
  });
});

describe("srcdoc · buildSrcDoc", () => {
  it("wraps every jsx file as a text/babel block and uses index.html as head", () => {
    const vfs = createVfs({
      "/index.html": "<title>Form</title>",
      "/theme.jsx": "const theme = {};",
      "/form.jsx": "const Form = () => null;",
      "/schema.json": '{"fields":[]}',
    });
    const doc = buildSrcDoc(vfs);
    expect(doc).toContain("<title>Form</title>");
    expect(doc).toContain("const theme = {};");
    expect(doc).toContain("const Form = () => null;");
    // json files are not emitted as babel scripts
    expect(doc).not.toContain('{"fields":[]}');
  });

  it("orders babel blocks and includes a mount point", () => {
    const vfs = createVfs({ "/a.jsx": "AAA", "/b.jsx": "BBB" });
    const doc = buildSrcDoc(vfs);
    expect(doc.indexOf('<div id="root">')).toBeGreaterThan(-1);
    expect(doc.indexOf("AAA")).toBeLessThan(doc.indexOf("BBB"));
  });
});
