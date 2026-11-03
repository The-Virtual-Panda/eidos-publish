// What this machine keeps of a person's sign-in (Publish REQ12): one file,
// `plugins/channels/credentials.json` in the Eidos app data folder, outside
// every root, readable only by its owner. It holds the Microsoft refresh token
// and the permissions Microsoft granted with it. The same file on every
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

export const credentialsFile = (env: NodeJS.ProcessEnv = process.env): string => path.join(appDataDir(env), 'plugins', 'channels', 'credentials.json');

export interface TeamsSignIn {
  refresh_token: string;
  // the permissions Microsoft granted, by their short names
  scopes: string[];
  name: string;
  username: string;
  tenant: string;
  client_id: string;
}

interface Held {
  teams?: TeamsSignIn;
}

function read(file: string): Held {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Held;
  } catch {
    return {};
  }
}

// Written whole to a file beside it, then moved over it, so a failed write
// never leaves half a file; owner-only on macOS and Linux (Windows keeps the
// app data folder to its user already).
function write(file: string, held: Held): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const next = `${file}.${process.pid}.tmp`;
  writeFileSync(next, `${JSON.stringify(held, null, 2)}\n`, { mode: 0o600 });
  renameSync(next, file);
  chmodSync(file, 0o600);
}

export const teamsSignIn = (env: NodeJS.ProcessEnv = process.env): TeamsSignIn | null => read(credentialsFile(env)).teams ?? null;

export function keepTeamsSignIn(signIn: TeamsSignIn, env: NodeJS.ProcessEnv = process.env): void {
  const file = credentialsFile(env);
  write(file, { ...read(file), teams: signIn });
}

export function dropTeamsSignIn(env: NodeJS.ProcessEnv = process.env): boolean {
  const file = credentialsFile(env);
  const held = read(file);
  if (!held.teams) return false;
  delete held.teams;
  if (Object.keys(held).length === 0) rmSync(file);
  else write(file, held);
  return true;
}
