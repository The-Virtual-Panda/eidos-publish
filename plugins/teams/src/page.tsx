// The Teams plugin's page half: the core's, with Microsoft's sign-in in the browser,
// and the message previewed as the HTML Teams will show.
import { useEffect, useState, type JSX } from 'react';
import { Button, Card, Input, Markdown, Notice, Row, SettingRow, SettingsHead, Stack, Text, usePluginHost } from 'eidosmd/page';
import { publishPage, reason, useHostRef, type Account } from '../../../packages/core/src/page.tsx';
import { TEAMS_STRINGS } from './page-strings.ts';

type Signing = { address: string; interval: number };
type Refused = { message: string; address: string; permissions: string[] };

function SignIn({ account, reload }: { account: Account | null; reload: () => void }): JSX.Element {
  const host = usePluginHost();
  const hostRef = useHostRef(host);
  const { t } = host;
  const [signing, setSigning] = useState<Signing | null>(null);
  const [refusal, setRefusal] = useState<Refused | null>(null);
  const [busy, setBusy] = useState(false);

  // the sign-in is finished in the browser, so this asks until Microsoft answers
  useEffect(() => {
    if (!signing) return;
    let live = true;
    let interval = signing.interval;
    let timer: ReturnType<typeof setTimeout>;
    const ask = (): void => {
      hostRef.current.post<{ state: string } & Partial<Refused>>('login/poll').then(
        (poll) => {
          if (!live) return;
          if (poll.state === 'done') {
            setSigning(null);
            reload();
            return;
          }
          if (poll.state === 'refused') {
            setSigning(null);
            setRefusal({ message: poll.message ?? '', address: poll.address ?? '', permissions: poll.permissions ?? [] });
            return;
          }
          if (poll.state === 'slower') interval += 5;
          timer = setTimeout(ask, interval * 1000);
        },
        (cause) => {
          if (!live) return;
          setSigning(null);
          hostRef.current.toast(t('failed'), 'error', reason(cause));
        },
      );
    };
    timer = setTimeout(ask, interval * 1000);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [hostRef, signing, reload, t]);

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await work();
    } catch (cause) {
      host.toast(t('failed'), 'error', reason(cause));
    } finally {
      setBusy(false);
    }
  };
  const signIn = (edit: boolean): Promise<void> =>
    act(async () => {
      setRefusal(null);
      setSigning(await host.post<Signing>('login/start', { edit }));
    });

  return (
    <Card>
      <SettingsHead>{t('account')}</SettingsHead>
      <SettingRow
        label={account ? t('signedInAs', { name: account.name }) : t('notSignedIn')}
        {...(account ? { hint: account.can_edit ? t('canEdit') : t('cannotEdit') } : {})}
        control={
          account ? (
            <Button disabled={busy} onClick={() => void act(() => host.post('logout').then(reload))}>
              {t('signOut')}
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || signing !== null} data-testid="teams-sign-in" onClick={() => void signIn(false)}>
              {t('signIn')}
            </Button>
          )
        }
      />
      {account && !account.can_edit && (
        <SettingRow
          label={t('enableEdit')}
          hint={t('enableEditHint')}
          control={
            <Button disabled={busy || signing !== null} onClick={() => void signIn(true)}>
              {t('enableEdit')}
            </Button>
          }
        />
      )}
      {signing && (
        <Notice>
          <Stack gap="xs">
            <Text size="sm" block>
              {t('signingIn')}
            </Text>
            <Row>
              <Button variant="primary" data-testid="teams-open-sign-in" onClick={() => window.open(signing.address, '_blank', 'noopener')}>
                {t('openSignIn')}
              </Button>
            </Row>
            <Text size="sm" tone="muted" block>
              {t('waiting')}
            </Text>
          </Stack>
        </Notice>
      )}
      {refusal && (
        <Notice tone="error">
          <Stack gap="xs">
            <Text size="sm" weight="strong" block>
              {t('refusedTitle')}
            </Text>
            <Text size="sm" block>
              {t('refusedHint', { permissions: refusal.permissions.join(', ') })}
            </Text>
            <Input readOnly value={refusal.address} aria-label={t('refusedTitle')} />
          </Stack>
        </Notice>
      )}
    </Card>
  );
}

// a speech bubble holding a T
function Icon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 3h11v8H7l-3 2.5V11H2.5z" />
      <path d="M5.5 5.5h5" />
      <path d="M8 5.5v3.25" />
    </svg>
  );
}

export const page = publishPage({
  name: 'teams',
  service: 'Teams',
  strings: TEAMS_STRINGS,
  SignIn,
  Icon,
  MessagePreview: ({ message }) => <Markdown html={message} />,
});
