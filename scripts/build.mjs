// Builds the release files into dist/: cli.js, a CommonJS bundle whose one
// import from the CLI, eidosmd/plugin, is left for the host to answer; app.js,
// the app entry, built the same way; and page.js, the page half, whose
// imports of react and eidosmd/page the page answers; beside
// manifest.yaml and instructions.md. A Registry install downloads only the
// files its listing pins (manifest.yaml, cli.js, app.js, page.js), so the release manifest
// also carries the guide as its `instructions`, which the host reads when no
// instructions.md sits beside it, and its `built_with`, the eidosmd this build
// compiled against (The Plugin Model REQ52).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['eidosmd/plugin'],
  legalComments: 'none',
});
// the app entry, which only the Eidos MD app mounts: its routes for the page half
await build({
  entryPoints: ['src/app.ts'],
  outfile: 'dist/app.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['eidosmd/plugin'],
  legalComments: 'none',
});
// the page half, which the page evaluates: react, its JSX runtime, and the kit (eidosmd/page) are the page's own
await build({
  entryPoints: ['src/page.tsx'],
  outfile: 'dist/page.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'eidosmd/page'],
  legalComments: 'none',
});
copyFileSync('instructions.md', 'dist/instructions.md');
const guide = readFileSync('instructions.md', 'utf8').replace(/\s+$/, '');
const block = guide
  .split('\n')
  .map((line) => (line === '' ? '' : `  ${line}`))
  .join('\n');
const builtWith = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('eidosmd/package.json'), 'utf8')).version;
const manifest = readFileSync('manifest.yaml', 'utf8')
  .replace(/\s+$/, '')
  .replace(/^built_with:.*\n/m, '')
  .replace(/^(min_host:.*)$/m, `$1\nbuilt_with: ${builtWith}`);
writeFileSync('dist/manifest.yaml', `${manifest}\ninstructions: |\n${block}\n`);
