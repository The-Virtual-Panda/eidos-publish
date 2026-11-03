// The plugin's app entry, which only the Eidos MD app mounts: the routes its
// page half calls, under `/api/plugins/channels/`. Each answers through the CLI
// entry's API, so a sign-in, a destination, or a publish made from the page is the
// one a command makes. A device code stays in this process and a token in the
// credentials file; no answer carries either.
import { HostError, type AppEntry } from 'eidosmd/plugin';
import type { ChannelsApi } from './cli.ts';
import type { ConsentError } from './microsoft.ts';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const options = (body: Record<string, unknown>): { force?: boolean; noReply?: boolean } => ({
  ...(body['force'] === true ? { force: true } : {}),
  ...(body['no_reply'] === true ? { noReply: true } : {}),
});

async function answer<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof HostError) throw cause;
    throw new HostError(400, cause instanceof Error ? cause.message : String(cause));
  }
}

const entry: AppEntry<ChannelsApi> = {
  name: 'channels',
  mount(host, api) {
    host.route('GET', 'state', () => answer(() => ({ destinations: api.destinations(), account: api.account() })));
    host.route('GET', 'standing', (request) => answer(() => api.standing(request.query.get('file') ?? '')));
    host.route('POST', 'plan', (request) => answer(() => api.plan(text(request.body['file']), text(request.body['destination']), options(request.body))));
    host.route('POST', 'publish', (request) => answer(() => api.publish(text(request.body['file']), text(request.body['destination']), options(request.body))));
    host.route('POST', 'connect', (request) => answer(() => api.connect(text(request.body['name']), 'teams', text(request.body['link']))));
    host.route('POST', 'disconnect', (request) => answer(async () => (await api.disconnect(text(request.body['name'])), {})));
    host.route('POST', 'login/start', (request) => answer(() => api.loginStart(request.body['edit'] === true)));
    host.route('POST', 'login/poll', async () => {
      try {
        return await api.loginPoll();
      } catch (cause) {
        // the organization's refusal is an answer the page shows whole, with the address to hand on
        // (by its name: the API's error comes from the CLI entry's bundle, not this one's)
        if (cause instanceof Error && cause.name === 'ConsentError') {
          const refusal = cause as ConsentError;
          return { state: 'refused', message: refusal.message, address: refusal.address, permissions: refusal.permissions };
        }
        throw new HostError(400, cause instanceof Error ? cause.message : String(cause));
      }
    });
    host.route('POST', 'logout', () => answer(() => ({ signed_out: api.logout() })));
  },
};

export default entry;
