import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Only publish the assets served by server.js, not server.js, tests or documentation.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'dist');
const assets = ['index.html', 'css', 'js'];

for (const asset of assets) {
  if (!existsSync(join(root, asset))) throw new Error('Missing static asset: ' + asset);
}
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
for (const asset of assets) {
  cpSync(join(root, asset), join(output, asset), { recursive: true });
}
console.log('Prepared static assets in dist/');
