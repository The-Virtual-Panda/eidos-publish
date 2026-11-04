// The Slack plugin's page half: the core's, with connecting the workspace's app by
// its bot token, and the message previewed as the markdown Slack will show.
import { useEffect, useState, type JSX } from 'react';
import { Button, Card, Input, Markdown, Row, SettingRow, SettingsHead, Stack, Text, usePluginHost } from 'eidosmd/page';
import { marked } from 'marked';
import { publishPage, reason, useHostRef, type Account } from '../../../packages/core/src/page.tsx';
import { SLACK_STRINGS } from './page-strings.ts';

function SignIn({ account, reload }: { account: Account | null; reload: () => void }): JSX.Element {
  const host = usePluginHost();
  const hostRef = useHostRef(host);
  const { t } = host;
  const [token, setToken] = useState('');
  const [address, setAddress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    hostRef.current.get<{ address: string }>('create-app').then(
      (held) => setAddress(held.address),
      () => setAddress(null),
    );
  }, [hostRef]);
  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await work();
      reload();
    } catch (cause) {
      host.toast(t('failed'), 'error', reason(cause));
    } finally {
      setBusy(false);
    }
  };
  if (account)
    return (
      <Card>
        <SettingsHead>{t('account')}</SettingsHead>
        <SettingRow
          label={t('signedInTo', { name: account.name })}
          hint={`${account.detail}. ${t('inviteHint')}`}
          control={
            <Button disabled={busy} onClick={() => void act(() => host.post('logout'))}>
              {t('signOut')}
            </Button>
          }
        />
      </Card>
    );
  return (
    <Card>
      <SettingsHead>{t('account')}</SettingsHead>
      <Stack gap="sm">
        <Text size="sm" block>
          {t('notSignedIn')}
        </Text>
        <SettingRow
          label={t('createApp')}
          hint={t('createAppHint')}
          control={
            <Button disabled={!address} data-testid="slack-create-app" onClick={() => address && window.open(address, '_blank', 'noopener')}>
              {t('createApp')}
            </Button>
          }
        />
        <SettingRow
          label={t('token')}
          hint={t('tokenHint')}
          control={
            <Input
              type="password"
              autoComplete="off"
              aria-label={t('token')}
              value={token}
              data-testid="slack-token"
              onChange={(event: { target: HTMLInputElement }) => setToken(event.target.value)}
            />
          }
        />
        <Row justify="end">
          <Button
            variant="primary"
            disabled={busy || token.trim() === ''}
            data-testid="slack-connect"
            onClick={() =>
              void act(async () => {
                await host.post('login', { token });
                setToken('');
              })
            }
          >
            {t('connect')}
          </Button>
        </Row>
      </Stack>
    </Card>
  );
}

// a channel's hash
function Icon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 2.5 4.5 13.5" />
      <path d="M11.5 2.5 10 13.5" />
      <path d="M2.75 6h11" />
      <path d="M2.25 10h11" />
    </svg>
  );
}

export const page = publishPage({
  name: 'slack',
  service: 'Slack',
  strings: SLACK_STRINGS,
  SignIn,
  Icon,
  // the message holds no raw HTML of its own: the renderer turned every `<` into an entity
  MessagePreview: ({ message }) => <Markdown html={marked.parse(message, { async: false, gfm: true })} />,
});
