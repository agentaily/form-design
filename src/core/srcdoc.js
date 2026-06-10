// srcdoc.js — Render pipeline (SPEC §5). Assemble the VFS into a self-contained
// HTML string for iframe `srcdoc`. Design-state only (iframe + Babel standalone).

// React 18 UMD + Babel standalone from CDN, with SRI (matches the prototype shell).
export const CDN_SCRIPTS = [
  {
    src: "https://unpkg.com/react@18.3.1/umd/react.development.js",
    integrity: "sha384-hD6/rw4ppMLGNu3tX5cjIb+uRZ7UkRJ6BPkLpg4hAu/6onKUg4lLsHAs9EBPT82L",
  },
  {
    src: "https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js",
    integrity: "sha384-u6aeetuaXnQ38mYT8rp6sbXaQe3NL9t+IBXmnYxwkUI2Hw4bsp2Wvmx4yRQF1uAm",
  },
  {
    src: "https://unpkg.com/@babel/standalone@7.29.0/babel.min.js",
    integrity: "sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y",
  },
];

function cdnTags() {
  return CDN_SCRIPTS.map(
    (s) => `<script src="${s.src}" integrity="${s.integrity}" crossorigin="anonymous"></script>`,
  ).join("\n");
}

/**
 * Compose a complete standalone HTML document.
 * @param {string} head  extra <head> content (title, meta, custom CDNs) — typically /index.html
 * @param {string} jsxBlocks  pre-wrapped <script type="text/babel"> blocks
 */
export function assembleHtml(head, jsxBlocks) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
${head || ""}
${cdnTags()}
</head>
<body>
<div id="root"></div>
${jsxBlocks}
</body>
</html>`;
}

/** Build the iframe srcdoc string from a VFS (SPEC §5). */
export function buildSrcDoc(vfs) {
  const index = vfs["/index.html"];
  const head = index ? index.content : "";
  const jsxBlocks = Object.values(vfs)
    .filter((f) => f.type === "jsx")
    .map((f) => `<script type="text/babel">\n${f.content}\n</script>`)
    .join("\n");
  return assembleHtml(head, jsxBlocks);
}
