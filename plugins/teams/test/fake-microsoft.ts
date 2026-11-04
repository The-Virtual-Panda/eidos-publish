// A fake Microsoft for the tests: Entra's authorize, device code, and token endpoints and
// the three Graph requests, over channels held in memory, with what each
// request sent kept so a test can say exactly what reached Teams. Nothing here
// is a real tenant, person, or token.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const REFRESH = 'fake-refresh-token-not-a-secret';
export const ACCESS = 'fake-access-token-not-a-secret';
export const REFRESH_ROTATED = 'fake-refresh-token-rotated';

const idToken = `x.${Buffer.from(JSON.stringify({ name: 'Ada Test', preferred_username: 'ada@example.com', tid: 'tenant-1' })).toString('base64url')}.y`;

export interface FakeMicrosoft {
  address: string;
  // every Graph request, in order
  graph: Array<{ method: string; path: string; body: { body: { contentType: string; content: string }; mentions?: Array<{ id: number; mentionText: string; mentioned: Record<string, Record<string, string>> }> } }>;
  messages: Map<string, string>;
  // what the next Graph requests answer, consumed one by one; empty, they succeed
  failNext: Array<{ status: number; retryAfter?: string; message?: string }>;
  // the answers a device code poll gives, consumed one by one; empty, signed in
  pollAnswers: Array<{ status: number; body: Record<string, unknown> }>;
  // every request for the sign-in page, and what the next ones send back in place of a code
  authorizes: Array<Record<string, string>>;
  authorizeAnswers: Array<Record<string, string>>;
  forms: Array<Record<string, string>>;
  lookups: string[];
  // how many replies to refuse next, whatever else succeeds
  failReplies: number;
  close(): Promise<void>;
}

// Run on its own (`node --experimental-strip-types test/fake-microsoft.ts`) it serves on PORT until stopped, for trying the plugin by hand.
export async function startFakeMicrosoft(port = 0): Promise<FakeMicrosoft> {
  const state: FakeMicrosoft = {
    address: '',
    graph: [],
    messages: new Map(),
    failNext: [],
    pollAnswers: [],
    authorizes: [],
    authorizeAnswers: [],
    forms: [],
    lookups: [],
    failReplies: 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  let next = 1;
  const send = (response: ServerResponse, status: number, body?: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(body === undefined ? '' : JSON.stringify(body));
  };
  const read = async (request: IncomingMessage): Promise<string> => {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    return text;
  };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const text = await read(request);
      if (url.pathname.endsWith('/oauth2/v2.0/authorize')) {
        const asked = Object.fromEntries(url.searchParams);
        state.authorizes.push(asked);
        const back = new URL(asked['redirect_uri'] ?? '');
        back.search = new URLSearchParams({ ...(state.authorizeAnswers.shift() ?? { code: 'fake-auth-code' }), state: asked['state'] ?? '' }).toString();
        response.writeHead(302, { location: back.toString() });
        response.end();
        return;
      }
      if (url.pathname.endsWith('/oauth2/v2.0/devicecode')) {
        state.forms.push(Object.fromEntries(new URLSearchParams(text)));
        return send(response, 200, { device_code: 'fake-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', interval: 0, expires_in: 900 });
      }
      if (url.pathname.endsWith('/oauth2/v2.0/token')) {
        const form = Object.fromEntries(new URLSearchParams(text));
        state.forms.push(form);
        if (form['grant_type'] === 'authorization_code') {
          const asked = state.authorizes.at(-1);
          const proved = createHash('sha256')
            .update(form['code_verifier'] ?? '')
            .digest('base64url');
          if (form['code'] !== 'fake-auth-code' || form['redirect_uri'] !== asked?.['redirect_uri'] || proved !== asked?.['code_challenge']) return send(response, 400, { error: 'invalid_grant', error_description: 'AADSTS70008: the code does not prove out' });
        }
        const answer = form['grant_type']?.endsWith('device_code') ? state.pollAnswers.shift() : undefined;
        if (answer) return send(response, answer.status, answer.body);
        const scope = (form['scope'] ?? [...state.forms].reverse().find((held) => held['scope'])?.['scope'] ?? '')
          .split(' ')
          .filter((held) => /ChannelMessage|TeamworkTag|User\.ReadBasic/.test(held))
          .join(' ');
        return send(response, 200, { access_token: ACCESS, refresh_token: form['grant_type'] === 'refresh_token' ? REFRESH_ROTATED : REFRESH, scope, id_token: idToken });
      }
      const body = (text ? JSON.parse(text) : {}) as FakeMicrosoft['graph'][number]['body'];
      assertBearer(request);
      if (request.method === 'GET' && url.pathname.endsWith('/tags')) return send(response, 200, { value: [{ id: 'tag-1', displayName: 'Project Managers' }, { id: 'tag-2', displayName: 'Designers' }] });
      if (request.method === 'GET' && url.pathname.endsWith('/users')) {
        state.lookups.push(request.headers.consistencylevel === 'eventual' ? url.search : `no consistency level: ${url.search}`);
        return send(response, 200, { value: url.searchParams.get('$search')?.includes('janelle') ? [{ id: 'user-1', displayName: 'Janelle Reyes', mail: 'janelle@example.com' }] : [] });
      }
      state.graph.push({ method: request.method ?? '', path: url.pathname, body });
      const fail = state.failNext.shift();
      if (fail) {
        if (fail.retryAfter) response.setHeader('retry-after', fail.retryAfter);
        return send(response, fail.status, { error: { message: fail.message ?? 'refused' } });
      }
      const reply = /\/messages\/([^/]+)\/replies$/.exec(url.pathname);
      if (reply && state.failReplies > 0) {
        state.failReplies -= 1;
        return send(response, 500, { error: { message: 'no reply' } });
      }
      if (reply) return send(response, 201, { id: `reply-${next++}` });
      const edit = /\/messages\/([^/]+)$/.exec(url.pathname);
      if (edit && request.method === 'PATCH') {
        state.messages.set(edit[1]!, body.body.content);
        return send(response, 204);
      }
      const id = `m${next++}`;
      state.messages.set(id, body.body.content);
      return send(response, 201, { id, webUrl: `https://teams.microsoft.com/l/message/${id}` });
    })().catch(() => send(response, 500, { error: { message: 'the fake broke' } }));
  });
  const assertBearer = (request: IncomingMessage): void => {
    if (request.headers.authorization !== `Bearer ${ACCESS}`) throw new Error('no token');
  };
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  state.address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

if (process.argv[1]?.endsWith('fake-microsoft.ts')) console.log((await startFakeMicrosoft(Number(process.env['PORT'] ?? 0))).address);
