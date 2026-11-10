// Slack from this machine, with nothing in between (Publish REQ14, REQ17, REQ18,
// REQ21): its Web API with a bot token. Slack answers most failures as a 200 with
// `ok: false`, so each one it can give is turned here into what it means for a
// publish: a message gone is a 404, a refusal a 403 (REQ8). A 429 waits as long as
// `Retry-After` says and tries again, a few times. A failure never names the token.
import { ProviderError } from '../../../packages/core/src/errors.ts';

const TIMEOUT_MS = 30_000;
const RETRIES = 4;

// What Slack allows in `markdown_text`, its field for a whole message.
export const SLACK_LIMIT_CHARACTERS = 12_000;

// The app a workspace makes for itself: what it may do, and nothing else. `chat:write`
// posts, edits, and replies; `chat:write.public` reaches a public channel with no invite;
// `channels:read` and `groups:read` read a public or private channel's name, so one added by its id shows what it is called.
export const APP_MANIFEST = {
  display_information: { name: 'Eidos Publish', description: 'Publishes Eidos blueprints to channels, when someone asks.' },
  features: { bot_user: { display_name: 'Eidos Publish', always_online: false } },
  oauth_config: { scopes: { bot: ['chat:write', 'chat:write.public', 'channels:read', 'groups:read'] } },
  settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
};

// Opens Slack's Create App with the manifest filled in.
export const createAppAddress = (): string => `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(APP_MANIFEST))}`;

// Slack's own address, or a `localhost` one a test names, and nothing else, so no token leaves for anywhere else.
function base(): string {
  const given = process.env['EIDOS_SLACK_BASE']?.replace(/\/+$/, '');
  if (!given) return 'https://slack.com';
  if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(given)) throw new ProviderError('EIDOS_SLACK_BASE may only name a local address', null);
  return given;
}

const REFUSALS: Record<string, string> = {
  not_in_channel: 'The app is not in this channel. Invite it with /invite in the channel.',
  channel_not_found: 'The app cannot see this channel. A private channel needs it invited, and the channel must be in the workspace you signed in to.',
  is_archived: 'The channel is archived.',
  is_inactive: 'The channel is archived or frozen.',
  cant_update_message: 'Slack will not let the app edit this message.',
  edit_window_closed: "This workspace's settings no longer allow the message to be edited.",
  missing_scope: 'The app lacks a permission it needs. Make it again from the plugin’s manifest.',
  invalid_auth: 'Slack does not accept the token. Run `eidos slack login` again.',
  not_authed: 'Slack does not accept the token. Run `eidos slack login` again.',
  token_revoked: 'The token was revoked. Run `eidos slack login` again.',
  token_expired: 'The token ran out. Run `eidos slack login` again.',
  account_inactive: 'The app was removed from the workspace. Install it and run `eidos slack login` again.',
};

function failureOf(code: string): ProviderError {
  if (code === 'message_not_found' || code === 'thread_not_found') return new ProviderError(`Slack answered ${code}`, 404);
  if (code === 'ratelimited' || code === 'rate_limited') return new ProviderError('Slack is throttling requests. Try again shortly.', 429);
  const said = REFUSALS[code];
  if (said) return new ProviderError(`${said} (${code})`, 403);
  return new ProviderError(`Slack answered ${code}`, 400);
}

type Answer = Record<string, unknown>;

// Slack's read methods take their arguments form-encoded and answer a JSON body with invalid_arguments
const READ_METHODS = new Set(['conversations.info', 'chat.getPermalink']);

export function slackClient(token: string, wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
  const call = async (method: string, body: Answer): Promise<Answer> => {
    const form = READ_METHODS.has(method);
    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(`${base()}/api/${method}`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8',
            accept: 'application/json',
          },
          body: form ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])) : JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (cause) {
        throw new ProviderError(`Slack could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`, null);
      }
      if (response.status === 429 && attempt < RETRIES) {
        const seconds = Number(response.headers.get('retry-after'));
        await wait((Number.isFinite(seconds) && seconds > 0 ? seconds : 2 ** attempt) * 1000);
        continue;
      }
      if (response.status === 429) throw failureOf('ratelimited');
      if (!response.ok) throw new ProviderError(`Slack answered ${response.status}: ${response.statusText || 'no message'}`, response.status);
      const answer = (await response.json().catch(() => ({}))) as Answer;
      if (answer['ok'] !== true) throw failureOf(String(answer['error'] ?? 'unknown_error'));
      return answer;
    }
  };
  return {
    whoAmI: async (): Promise<{ team: string; bot: string }> => {
      const answer = await call('auth.test', {});
      return { team: String(answer['team'] ?? ''), bot: String(answer['user'] ?? '') };
    },
    // '' when Slack will not say: an app made before it could read names, or a private channel it is not in
    channelName: async (channel: string): Promise<string> => {
      const answer = await call('conversations.info', { channel }).catch(() => null);
      const found = (answer?.['channel'] as Answer | undefined)?.['name'];
      return typeof found === 'string' ? found : '';
    },
    post: async (channel: string, message: string): Promise<{ id: string; url: string | null }> => {
      const answer = await call('chat.postMessage', { channel, markdown_text: message, unfurl_links: false, unfurl_media: false });
      const id = String(answer['ts']);
      // the address is a nicety: a message that was sent is never failed for want of one
      const url = await call('chat.getPermalink', { channel, message_ts: id }).then(
        (link) => (typeof link['permalink'] === 'string' ? link['permalink'] : null),
        () => null,
      );
      return { id, url };
    },
    edit: async (channel: string, id: string, message: string): Promise<void> => {
      await call('chat.update', { channel, ts: id, markdown_text: message, as_user: true });
    },
    reply: async (channel: string, id: string, message: string): Promise<void> => {
      await call('chat.postMessage', { channel, thread_ts: id, text: message, unfurl_links: false, unfurl_media: false });
    },
  };
}

// A channel by its link (Copy link) or its id.
export function readChannel(given: string): string {
  const text = given.trim();
  const help = 'Use Copy link on the channel in Slack, or its id, which starts with C or G.';
  if (/^[CG][A-Z0-9]{6,}$/.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ProviderError(`That is not a Slack channel. ${help}`, null);
  }
  const found = /\/(?:archives|client\/[A-Z0-9]+)\/([CG][A-Z0-9]{6,})(?:\/|$)/.exec(url.pathname)?.[1];
  if (!/(^|\.)slack\.com$/i.test(url.hostname) || !found) throw new ProviderError(`That is not a link to a Slack channel. ${help}`, null);
  return found;
}
