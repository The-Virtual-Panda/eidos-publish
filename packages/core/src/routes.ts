// The routes every publishing plugin's page half calls, under
// `/api/plugins/<name>/`. Each answers through the CLI entry's API, so a
// destination or a publish made from the page is the one a command makes. No
// answer carries a token.
import { HostError, type AppHost } from 'eidosmd/plugin';
import { isMention, type PublishApi } from './commands.ts';
import type { PlanOptions } from './publish.ts';

export const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const options = (body: Record<string, unknown>): PlanOptions => ({
  ...(Array.isArray(body['properties']) ? { properties: body['properties'].filter((name): name is string => typeof name === 'string') } : {}),
  ...(Array.isArray(body['mentions']) ? { mentions: body['mentions'].filter(isMention) } : {}),
  ...(body['force'] === true ? { force: true } : {}),
  ...(body['no_reply'] === true ? { noReply: true } : {}),
  ...(body['take_over'] === true ? { takeOver: true } : {}),
});

export async function answer<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof HostError) throw cause;
    throw new HostError(400, cause instanceof Error ? cause.message : String(cause));
  }
}

export function mountPublish(host: AppHost, api: PublishApi): void {
  host.route('GET', 'state', () => answer(() => ({ destinations: api.destinations(), account: api.account() })));
  host.route('GET', 'standing', (request) => answer(() => api.standing(request.query.get('file') ?? '')));
  host.route('POST', 'plan', (request) => answer(() => api.plan(text(request.body['file']), text(request.body['destination']), options(request.body))));
  host.route('POST', 'publish', (request) => answer(() => api.publish(text(request.body['file']), text(request.body['destination']), options(request.body))));
  host.route('POST', 'connect', (request) => answer(() => api.connect(text(request.body['name']), text(request.body['link']))));
  host.route('POST', 'disconnect', (request) => answer(async () => (await api.disconnect(text(request.body['name'])), {})));
  host.route('POST', 'mentions', (request) => answer(() => api.searchMentions(text(request.body['destination']) || undefined, text(request.body['query']))));
  host.route('GET', 'options', () => answer(() => api.options()));
  host.route('POST', 'options', (request) => answer(() => api.setOption(text(request.body['name']), request.body['value'])));
  host.route('POST', 'logout', () => answer(() => ({ signed_out: api.logout() })));
}
