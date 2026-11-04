// What this machine keeps of a person's sign-in (Publish REQ12, REQ14): one file
// per plugin, `plugins/<name>/credentials.json` in the Eidos app data folder,
// outside every root, readable only by its owner. The same file on every
// operating system, found as the CLI finds the app data folder; EIDOS_APP_DATA
// moves it.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function appDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env['EIDOS_APP_DATA']) return path.resolve(env['EIDOS_APP_DATA']);
  if (platform === 'darwin') return path.join(homedir(), 'Library', 'Application Support', 'eidosmd');
  if (platform === 'win32') return path.join(env['APPDATA'] ?? path.join(homedir(), 'AppData', 'Roaming'), 'eidosmd');
  return path.join(env['XDG_CONFIG_HOME'] ? path.resolve(env['XDG_CONFIG_HOME']) : path.join(homedir(), '.config'), 'eidosmd');
}

export interface Credentials<T> {
  readonly where: string;
  get(): T | null;
  set(value: T): void;
  // whether there was anything to forget
  drop(): boolean;
}

export function credentials<T>(plugin: string): Credentials<T> {
  const file = (): string => path.join(appDataDir(), 'plugins', plugin, 'credentials.json');
  return {
    get where() {
      return file();
    },
    get: () => {
      if (!existsSync(file())) return null;
      try {
        return JSON.parse(readFileSync(file(), 'utf8')) as T;
      } catch {
        return null;
      }
    },
    // Written whole to a file beside it, then moved over it, so a failed write
    // never leaves half a file; owner-only on macOS and Linux (Windows keeps the
    // app data folder to its user already).
    set: (value) => {
      mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
      const next = `${file()}.${process.pid}.tmp`;
      writeFileSync(next, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      renameSync(next, file());
      chmodSync(file(), 0o600);
    },
    drop: () => {
      if (!existsSync(file())) return false;
      rmSync(file());
      return true;
    },
  };
}
