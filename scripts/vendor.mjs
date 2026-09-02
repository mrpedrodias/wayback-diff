// Copies the jsdiff UMD build into src/vendor so the extension needs no bundler.
// Run after `npm install` (or whenever the `diff` dependency is bumped): `npm run vendor`.
import { copyFile, mkdir, readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const src = new URL('node_modules/diff/dist/diff.js', root);
const destDir = new URL('src/vendor/', root);

await mkdir(destDir, { recursive: true });
await copyFile(src, new URL('diff.js', destDir));

const { version } = JSON.parse(await readFile(new URL('node_modules/diff/package.json', root), 'utf8'));
console.log(`vendored diff@${version} -> src/vendor/diff.js`);
