// Stamps a version on every app file URL so phones never mix old and new files.
// Run after changing anything in public/:  node scripts/version.mjs
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../public');
const v = Date.now().toString(36);
const files = ['index.html', 'sw.js', ...fs.readdirSync(path.join(root, 'js')).map((f) => 'js/' + f), ...fs.readdirSync(path.join(root, 'core')).map((f) => 'core/' + f)];
for (const f of files) {
  const p = path.join(root, f);
  let s = fs.readFileSync(p, 'utf8');
  s = s.replace(/((?:from|import)\s*\(?\s*['"])(\.{1,2}\/[^'"?]+\.js)(\?v=[\w]+)?(['"])/g, `$1$2?v=${v}$4`);
  if (f === 'index.html') s = s.replace(/(href="styles\.css|src="js\/app\.js)(\?v=[\w]+)?"/g, `$1?v=${v}"`);
  if (f === 'sw.js') s = s.replace(/const VERSION = '[\w]+';/, `const VERSION = '${v}';`);
  fs.writeFileSync(p, s);
}
console.log('version', v);
