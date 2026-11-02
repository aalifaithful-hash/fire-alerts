// Copies the pdf.js worker (library code only, no customer data) into /public
// so the in-browser evidence viewer can render PDF pages.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const src = require.resolve("pdfjs-dist/build/pdf.worker.min.mjs");
mkdirSync(new URL("../public/", import.meta.url), { recursive: true });
copyFileSync(src, new URL("../public/pdf.worker.min.mjs", import.meta.url));
console.log("pdf.worker.min.mjs copied to public/");
