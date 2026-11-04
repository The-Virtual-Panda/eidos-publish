// Microsoft from this machine, with nothing in between (Publish REQ12, REQ13,
// REQ17, REQ18, REQ21): the device code sign-in against Entra ID, and the three
// Graph v1.0 requests a message takes. A 429 waits as long as `Retry-After` says
// and tries again, a few times; a failure names the provider's status and
// message, and never a token.

import { ProviderError } from '../../../packages/core/src/errors.ts';

// The Virtual Panda's multi-tenant Entra app, a public client with no secret.
// Empty until the app is registered; `client_id`, a `me` setting, stands in.
export const DEFAULT_CLIENT_ID = '';

const SEND = 'ChannelMessage.Send';
const EDIT = 'ChannelMessage.ReadWrite';
const TIMEOUT_MS = 30_000;
const RETRIES = 4;

// Refused by the organization rather than by the person: said as such, with what to hand their administrator.
export class ConsentError extends Error {
  readonly address: string;
  readonly permissions: string[];
  constructor(message: string, address: string, permissions: string[]) {
    super(message);
    this.name = 'ConsentError';
    this.address = address;
    this.permissions = permissions;
  }
}

// The address requests go to. Microsoft's own, or a `localhost` one a test names, and nothing else, so no token leaves for anywhere else.
function base(variable: string, real: string): string {
  const given = process.env[variable]?.replace(/\/+$/, '');
  if (!given) return real;
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(given)) throw new ProviderError(`${variable} may only name a local address`, null);
  return given;
}
const loginBase = (): string => base('EIDOS_TEAMS_LOGIN_BASE', 'https://login.microsoftonline.com');
const graphBase = (): string => base('EIDOS_TEAMS_GRAPH_BASE', 'https://graph.microsoft.com');

const shortScope = (scope: string): string => scope.replace(/^.*\//, '');
export const canEdit = (scopes: string[]): boolean => scopes.some((scope) => shortScope(scope).toLowerCase() === EDIT.toLowerCase());
export const permissionsFor = (edit: boolean): string[] => (edit ? [SEND, EDIT] : [SEND]);
const scopeParam = (scopes: string[]): string => [...scopes.map((scope) => `https://graph.microsoft.com/${shortScope(scope)}`), 'offline_access', 'openid', 'profile'].join(' ');

export function adminConsentAddress(tenant: string, clientId: string, permissions: string[]): string {
  const query = new URLSearchParams({ client_id: clientId, scope: permissions.map((scope) => `https://graph.microsoft.com/${scope}`).join(' ') });
  return `${loginBase()}/${encodeURIComponent(tenant)}/v2.0/adminconsent?${query.toString()}`;
}

const consentAddress = (sign: Sign): string => adminConsentAddress(sign.consentTenant ?? sign.tenant, sign.clientId, sign.permissions);

const refused = (sign: Sign): ConsentError => {
  const { permissions } = sign;
  const address = consentAddress(sign);
  return new ConsentError(
    `Your organization has to approve this app before you can sign in. Send your administrator this address, which asks for ${permissions.join(' and ')}: ${address}`,
    address,
    permissions,
  );
};

const CONSENT_CODES = /AADSTS(65001|65004|90094|90095|90099|50105)\b/;

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ProviderError(`Microsoft sign-in could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`, null);
  }
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    return { status: response.status, body: {} };
  }
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

export interface Tokens {
  access_token: string;
  refresh_token: string;
  scopes: string[];
  name: string;
  username: string;
  tenant: string;
}

export interface Sign {
  clientId: string;
  tenant: string;
  permissions: string[];
  // the tenant an administrator approves for, when it is known and sign-in itself takes any
  consentTenant?: string;
}

export async function startDeviceCode(sign: Sign): Promise<DeviceCode> {
  const { status, body } = await postForm(`${loginBase()}/${encodeURIComponent(sign.tenant)}/oauth2/v2.0/devicecode`, { client_id: sign.clientId, scope: scopeParam(sign.permissions) });
  if (status !== 200 || typeof body['device_code'] !== 'string') {
    const said = String(body['error_description'] ?? body['error'] ?? status);
    if (CONSENT_CODES.test(said)) throw refused(sign);
    throw new ProviderError(`Microsoft would not start a sign-in: ${said}`, status);
  }
  return {
    device_code: body['device_code'],
    user_code: String(body['user_code']),
    verification_uri: String(body['verification_uri'] ?? 'https://microsoft.com/devicelogin'),
    interval: Number(body['interval'] ?? 5),
    expires_in: Number(body['expires_in'] ?? 900),
  };
}

// What the token holds of who signed in: read for display, never kept past the fields below.
function who(idToken: unknown): { name: string; username: string; tenant: string } {
  try {
    const claims = JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    return { name: String(claims['name'] ?? ''), username: String(claims['preferred_username'] ?? ''), tenant: String(claims['tid'] ?? '') };
  } catch {
    return { name: '', username: '', tenant: '' };
  }
}

const tokensOf = (body: Record<string, unknown>): Tokens => ({
  access_token: String(body['access_token']),
  refresh_token: String(body['refresh_token']),
  scopes: String(body['scope'] ?? '')
    .split(/\s+/)
    .map(shortScope)
    .filter((scope) => /^ChannelMessage\./i.test(scope)),
  ...who(body['id_token']),
});

export type Poll = { state: 'pending' } | { state: 'slower' } | { state: 'done'; tokens: Tokens };

// One ask of whether the person has finished. A code that ran out, or a sign-in
// that was turned down, may be the organization's refusal: the consent page says
// so to the person and Microsoft says nothing more here, so the address goes with it.
export async function pollDeviceCode(sign: Sign, deviceCode: string): Promise<Poll> {
  const { status, body } = await postForm(`${loginBase()}/${encodeURIComponent(sign.tenant)}/oauth2/v2.0/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    client_id: sign.clientId,
    device_code: deviceCode,
  });
  if (status === 200 && typeof body['access_token'] === 'string') return { state: 'done', tokens: tokensOf(body) };
  const code = String(body['error'] ?? '');
  if (code === 'authorization_pending') return { state: 'pending' };
  if (code === 'slow_down') return { state: 'slower' };
  const said = String(body['error_description'] ?? code);
  if (code === 'authorization_declined' || code === 'access_denied' || code === 'consent_required' || CONSENT_CODES.test(said)) throw refused(sign);
  if (code === 'expired_token' || code === 'code_expired') {
    const address = consentAddress(sign);
    throw new ProviderError(`The sign-in code ran out before it finished. If Microsoft said an administrator must approve this app, send them this address: ${address}`, null);
  }
  throw new ProviderError(`Microsoft refused the sign-in: ${said}`, status);
}

// A fresh access token from the one kept. Microsoft may hand back a new refresh token, which the caller keeps.
export async function refresh(sign: Sign, refreshToken: string): Promise<Tokens> {
  const { status, body } = await postForm(`${loginBase()}/${encodeURIComponent(sign.tenant)}/oauth2/v2.0/token`, {
    grant_type: 'refresh_token',
    client_id: sign.clientId,
    refresh_token: refreshToken,
    scope: scopeParam(sign.permissions),
  });
  if (status === 200 && typeof body['access_token'] === 'string') {
    const tokens = tokensOf(body);
    return { ...tokens, refresh_token: typeof body['refresh_token'] === 'string' ? body['refresh_token'] : refreshToken };
  }
  const said = String(body['error_description'] ?? body['error'] ?? status);
  if (CONSENT_CODES.test(said)) throw refused(sign);
  throw new ProviderError('Your Microsoft sign-in has ended. Run `eidos teams login` again.', status);
}

// ---- Graph ----------------------------------------------------------------------------

export interface Channel {
  team: string;
  channel: string;
}

export interface Graph {
  post(channel: Channel, html: string): Promise<{ id: string; url: string | null }>;
  edit(channel: Channel, message: string, html: string): Promise<void>;
  reply(channel: Channel, message: string, html: string): Promise<void>;
}

export function graph(accessToken: string, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))): Graph {
  const send = async (method: 'POST' | 'PATCH', below: string, html: string): Promise<Record<string, unknown>> => {
    const url = `${graphBase()}/v1.0${below}`;
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ body: { contentType: 'html', content: html } }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (cause) {
        throw new ProviderError(`Teams could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`, null);
      }
      if (response.status === 429 && attempt < RETRIES) {
        const seconds = Number(response.headers.get('retry-after'));
        await wait((Number.isFinite(seconds) && seconds > 0 ? seconds : 2 ** attempt) * 1000);
        continue;
      }
      const text = await response.text().catch(() => '');
      let body: Record<string, unknown> = {};
      try {
        body = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
      } catch {
        // not JSON: the status text says it
      }
      if (!response.ok) {
        const said = (body['error'] as { message?: string } | undefined)?.message ?? (response.statusText || 'no message');
        throw new ProviderError(`Teams answered ${response.status}: ${said}`, response.status);
      }
      return body;
    }
  };
  const channelPath = (channel: Channel): string => `/teams/${encodeURIComponent(channel.team)}/channels/${encodeURIComponent(channel.channel)}/messages`;
  return {
    post: async (channel, html) => {
      const body = await send('POST', channelPath(channel), html);
      return { id: String(body['id']), url: typeof body['webUrl'] === 'string' ? body['webUrl'] : null };
    },
    edit: async (channel, message, html) => {
      await send('PATCH', `${channelPath(channel)}/${encodeURIComponent(message)}`, html);
    },
    reply: async (channel, message, html) => {
      await send('POST', `${channelPath(channel)}/${encodeURIComponent(message)}/replies`, html);
    },
  };
}

// ---- a channel's link -----------------------------------------------------------------

export interface ChannelLink extends Channel {
  channel_name: string;
  tenant: string | null;
}

// A channel's link from Teams (Get link to channel) names the channel in its path and the team as `groupId`.
export function readChannelLink(link: string): ChannelLink {
  const help = 'Use Get link to channel on the channel in Teams, then paste that link.';
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    throw new ProviderError(`That is not a link. ${help}`, null);
  }
  const parts = url.pathname.split('/').filter(Boolean);
  const channel = parts[0] === 'l' && parts[1] === 'channel' && parts[2] ? decodeURIComponent(parts[2]) : '';
  const team = url.searchParams.get('groupId') ?? '';
  if (!/^(teams\.microsoft\.com|teams\.cloud\.microsoft)$/i.test(url.hostname) || !channel.startsWith('19:') || !/^[0-9a-f-]{36}$/i.test(team))
    throw new ProviderError(`That is not a link to a Teams channel. ${help}`, null);
  return { team, channel, channel_name: parts[3] ? decodeURIComponent(parts[3]) : '', tenant: url.searchParams.get('tenantId') };
}

// 28 KB is Microsoft's stated limit on a channel message, its HTML included.
export const TEAMS_LIMIT_BYTES = 28_000;
