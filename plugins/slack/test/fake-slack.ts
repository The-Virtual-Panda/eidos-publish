// A fake Slack for the tests: the Web API methods the plugin calls, with what each
// request sent kept so a test can say exactly what reached Slack. Nothing here is a
// real workspace or token.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

export const TOKEN = 'xoxb-fake-token-not-a-secret';

const READ_METHODS = new Set(['conversations.info', 'chat.getPermalink']);

export interface FakeSlack {
  address: string;
  calls: Array<{ method: string; body: Record<string, unknown> }>;
  // what the next calls of a method answer, consumed one by one: an error code, or an HTTP status with Retry-After
  failNext: Array<{ method: string; error?: string; status?: number; retryAfter?: string }>;
  // what conversations.info calls each channel; a channel not here is one the app cannot see
  channelNames: Record<string, string>;
  close(): Promise<void>;
}

export async function startFakeSlack(port = 0): Promise<FakeSlack> {
  let next = 1;
  const server = createServer((request, response) => {
    void (async () => {
      let text = '';
      for await (const chunk of request) text += String(chunk);
      const method = (request.url ?? '').replace('/api/', '');
      const send = (status: number, body: unknown): void => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      if (request.headers.authorization !== `Bearer ${TOKEN}`) return send(200, { ok: false, error: 'invalid_auth' });
      const form = String(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
      const body = (form ? Object.fromEntries(new URLSearchParams(text)) : text ? JSON.parse(text) : {}) as Record<string, unknown>;
      state.calls.push({ method, body });
      // as the real Slack does, a read method takes its arguments form-encoded and answers a JSON body with invalid_arguments
      if (READ_METHODS.has(method) && !form) return send(200, { ok: false, error: 'invalid_arguments' });
      const failing = state.failNext.findIndex((held) => held.method === method);
      if (failing >= 0) {
        const [fail] = state.failNext.splice(failing, 1);
        if (fail!.status) {
          if (fail!.retryAfter) response.setHeader('retry-after', fail!.retryAfter);
          return send(fail!.status, {});
        }
        return send(200, { ok: false, error: fail!.error });
      }
      if (method === 'auth.test') return send(200, { ok: true, team: 'Test Workspace', user: 'eidos_publish' });
      if (method === 'chat.postMessage') return send(200, { ok: true, channel: body['channel'], ts: `17000.${next++}` });
      if (method === 'chat.update') return send(200, { ok: true, ts: body['ts'] });
      if (method === 'conversations.info') {
        const name = state.channelNames[String(body['channel'])];
        return send(200, name ? { ok: true, channel: { id: body['channel'], name } } : { ok: false, error: 'channel_not_found' });
      }
      if (method === 'chat.getPermalink') return send(200, { ok: true, permalink: `https://test.slack.com/archives/${String(body['channel'])}/p${String(body['message_ts'])}` });
      return send(200, { ok: false, error: 'unknown_method' });
    })();
  });
  const state: FakeSlack = { address: '', calls: [], failNext: [], channelNames: { C0123ABCDE: 'product-updates' }, close: () => new Promise((resolve) => server.close(() => resolve())) };
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  state.address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

// Run on its own (`node --experimental-strip-types plugins/slack/test/fake-slack.ts`) it serves on PORT until stopped, for trying the plugin by hand.
if (process.argv[1]?.endsWith('fake-slack.ts')) console.log((await startFakeSlack(Number(process.env['PORT'] ?? 0))).address);
