const { copyFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const vendor = path.join(root, "vendor");
mkdirSync(vendor, { recursive: true });
for (const [source, target] of [
  ["marked/lib/marked.umd.js", "marked.umd.js"],
  ["marked/LICENSE.md", "marked-LICENSE.md"],
  ["dompurify/dist/purify.min.js", "purify.min.js"],
  ["dompurify/LICENSE", "dompurify-LICENSE"],
]) {
  copyFileSync(path.join(root, "node_modules", source), path.join(vendor, target));
}
console.log("Marked.js e DOMPurify copiados para vendor.");
