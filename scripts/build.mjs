// Builds each plugin's release files into plugins/<name>/dist/, the folder
// Eidos MD loads it from: cli.js and app.js, CommonJS bundles whose one import
// from the host, eidosmd/plugin, the host answers; page.js, whose react and
// eidosmd/page imports the page answers; and manifest.yaml and instructions.md.
// The shared core is bundled into each, so a person installs one self-contained
// plugin. A Registry install downloads only the files its listing pins, so the
// release manifest also carries the guide as its `instructions`, and its
// `built_with`, the eidosmd this build compiled against (The Plugin Model REQ52).
// With --watch it builds again on every change.
import { copyFileSync, mkdirSync, readFileSync, readdirSync, watch, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { context } from 'esbuild';

const watching = process.argv.includes('--watch');
const builtWith = JSON.parse(readFileSync(createRequire(import.meta.url).resolve('eidosmd/package.json'), 'utf8')).version;
const node = { bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['eidosmd/plugin'], legalComments: 'none' };

for (const name of readdirSync('plugins')) {
  const dir = path.join('plugins', name);
  const dist = path.join(dir, 'dist');
  mkdirSync(dist, { recursive: true });
  const copy = () => {
    copyFileSync(path.join(dir, 'instructions.md'), path.join(dist, 'instructions.md'));
    const guide = readFileSync(path.join(dir, 'instructions.md'), 'utf8').replace(/\s+$/, '');
    const block = guide
      .split('\n')
      .map((line) => (line === '' ? '' : `  ${line}`))
      .join('\n');
    const manifest = readFileSync(path.join(dir, 'manifest.yaml'), 'utf8')
      .replace(/\s+$/, '')
      .replace(/^built_with:.*\n/m, '')
      .replace(/^(min_host:.*)$/m, `$1\nbuilt_with: ${builtWith}`);
    writeFileSync(path.join(dist, 'manifest.yaml'), `${manifest}\ninstructions: |\n${block}\n`);
  };
  copy();
  const builds = [
    { ...node, entryPoints: [path.join(dir, 'src/cli.ts')], outfile: path.join(dist, 'cli.js') },
    { ...node, entryPoints: [path.join(dir, 'src/app.ts')], outfile: path.join(dist, 'app.js') },
    {
      entryPoints: [path.join(dir, 'src/page.tsx')],
      outfile: path.join(dist, 'page.js'),
      bundle: true,
      platform: 'browser',
      format: 'cjs',
      target: 'es2022',
      jsx: 'automatic',
      external: ['react', 'react/jsx-runtime', 'eidosmd/page'],
      legalComments: 'none',
    },
  ];
  const contexts = await Promise.all(builds.map((options) => context(options)));
  if (watching) {
    for (const held of contexts) await held.watch();
    for (const file of ['manifest.yaml', 'instructions.md']) watch(path.join(dir, file), copy);
  } else {
    for (const held of contexts) {
      await held.rebuild();
      await held.dispose();
    }
  }
}
if (watching) console.log('watching; each plugin dist/ is rebuilt on every change');
