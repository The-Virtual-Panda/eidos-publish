// The Teams plugin's app entry, which only the Eidos MD app mounts: the core's
// routes, and the sign-in's. What proves a sign-in stays in this process and a token
// in the credentials file; no answer carries either.
import { HostError, type AppEntry } from 'eidosmd/plugin';
import { answer, mountPublish } from '../../../packages/core/src/routes.ts';
import type { TeamsApi } from './cli.ts';
import type { ConsentError } from './microsoft.ts';

const entry: AppEntry<TeamsApi> = {
  name: 'teams',
  mount(host, api) {
    mountPublish(host, api);
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
  },
};

export default entry;
