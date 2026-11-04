// Installs each built plugin under an app data folder, as `eidos plugin install`
// places one: `<app data>/plugins/<name>/<version>/`. The folder is
// EIDOS_APP_DATA's when it is set, so trying a plugin never touches the app data
// a person's real roots use unless they mean it to.
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appData =
  process.env.EIDOS_APP_DATA ??
  (process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'eidosmd')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? os.homedir(), 'eidosmd')
      : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'eidosmd'));
for (const name of readdirSync('plugins')) {
  const dist = path.join('plugins', name, 'dist');
  const version = /^version:\s*(\S+)/m.exec(readFileSync(path.join(dist, 'manifest.yaml'), 'utf8'))?.[1];
  const dir = path.join(appData, 'plugins', name, version);
  mkdirSync(dir, { recursive: true });
  for (const file of ['manifest.yaml', 'cli.js', 'app.js', 'page.js', 'instructions.md']) copyFileSync(path.join(dist, file), path.join(dir, file));
  console.log(`installed ${name} ${version} in ${dir}`);
}
