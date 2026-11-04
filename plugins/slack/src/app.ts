// The Slack plugin's app entry, which only the Eidos MD app mounts: the core's
// routes, and signing in. A token reaches the login route and goes straight to the
// credentials file; no answer carries it back.
import type { AppEntry } from 'eidosmd/plugin';
import { answer, mountPublish, text } from '../../../packages/core/src/routes.ts';
import type { SlackApi } from './cli.ts';

const entry: AppEntry<SlackApi> = {
  name: 'slack',
  mount(host, api) {
    mountPublish(host, api);
    host.route('POST', 'login', (request) => answer(() => api.login(text(request.body['token']))));
    host.route('GET', 'create-app', () => answer(() => ({ address: api.createAppAddress() })));
  },
};

export default entry;
