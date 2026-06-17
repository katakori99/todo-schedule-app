import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, "dist");
const indexPath = join(distDir, "index.html");

let html = readFileSync(indexPath, "utf8");

html = html.replace(
  /<link rel="stylesheet" crossorigin href="([^"]+)">/,
  (_, href) => {
    const cssPath = join(distDir, href.replace(/^\.\//, ""));
    const css = readFileSync(cssPath, "utf8");
    return `<style>\n${css}\n</style>`;
  },
);

html = html.replace(
  /<script type="module" crossorigin src="([^"]+)"><\/script>/,
  (_, src) => {
    const jsPath = join(distDir, src.replace(/^\.\//, ""));
    const js = readFileSync(jsPath, "utf8");
    return `<script type="module">\n${js}\n</script>`;
  },
);

writeFileSync(indexPath, html);
