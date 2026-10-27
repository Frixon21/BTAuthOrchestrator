// Build step (npm run build): copy the static admin console files
// (CONTRACT-010) from src/console/ to dist/console/, where
// src/adminConsole.ts serves them. tsc does not copy non-TypeScript files.
// The list is fixed and matches the server's allow-list.
const { copyFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const files = ['index.html', 'app.js', 'theme.js', 'app.css'];
const source = join(__dirname, '..', 'src', 'console');
const target = join(__dirname, '..', 'dist', 'console');
mkdirSync(target, { recursive: true });
for (const file of files) copyFileSync(join(source, file), join(target, file));
console.log(`Copied ${files.length} admin console files to dist/console/`);
