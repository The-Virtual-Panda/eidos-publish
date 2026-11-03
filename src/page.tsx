// The plugin's page half (Publish REQ10), drawn with the kit the Eidos MD page
// hands a plugin (`eidosmd/page`): a Publish… command on an open blueprint or
// top-level doc, a view in the Auxiliary Sidebar listing the channels it is
// published to, and the settings page holding the channels and the person's
// sign-in. Nothing sends until the person has seen what the dry run would send.
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  Badge,
  Button,
  Card,
  Input,
  Markdown,
  Modal,
  Notice,
  Row,
  Select,
  SettingRow,
  SettingsHead,
  SkeletonBar,
  Stack,
  Text,
  useFileChanges,
  useOpen,
  usePluginEvent,
  usePluginHost,
  type PagePlugin,
  type PluginHost,
} from 'eidosmd/page';
import { CHANNELS_STRINGS } from './page-strings.ts';

interface Destination {
  name: string;
  channel_name: string;
}
interface Account {
  name: string;
  username: string;
  can_edit: boolean;
}
interface State {
  destinations: Destination[];
  account: Account | null;
}
interface StandingRow {
  destination: string;
  state: 'current' | 'changed' | 'unpublished';
  url: string | null;
}
interface Standing {
  file: string;
  title: string;
  rows: StandingRow[];
}
interface Plan {
  title: string;
  action: 'post' | 'edit' | 'repost' | 'none' | 'refused';
  reason: string;
  message: string;
  reply: string[] | null;
}
interface Done {
  url: string | null;
  reply_error?: string;
}
interface OpenFile {
  kind: string;
  id?: string;
  path?: string;
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const fileOf = (open: OpenFile): string | null => (open.kind === 'blueprint' ? (open.id ?? open.path ?? null) : open.kind === 'doc' ? (open.path ?? null) : null);
const publishable = (open: { kind: string }): boolean => open.kind === 'blueprint' || open.kind === 'doc';

// The dialog is opened from a palette command and from the view, wherever the person is, so it lives in the page's layer.
let openDialog: ((file: string, destination?: string) => void) | null = null;

function useHostRef(host: PluginHost): { current: PluginHost } {
  const ref = useRef(host);
  ref.current = host;
  return ref;
}

function PublishDialog(): JSX.Element | null {
  const host = usePluginHost();
  const hostRef = useHostRef(host);
  const { t } = host;
  const [target, setTarget] = useState<{ file: string; destination?: string } | null>(null);
  const [destinations, setDestinations] = useState<Destination[] | null>(null);
  const [destination, setDestination] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    openDialog = (file, chosen) => {
      setTarget({ file, ...(chosen ? { destination: chosen } : {}) });
      setDestinations(null);
      setPlan(null);
      setProblem(null);
    };
    return () => {
      openDialog = null;
    };
  }, []);

  useEffect(() => {
    if (!target) return;
    hostRef.current.get<State>('state').then(
      (state) => {
        setDestinations(state.destinations);
        setDestination(target.destination ?? state.destinations[0]?.name ?? '');
      },
      (cause) => setProblem(reason(cause)),
    );
  }, [hostRef, target]);

  useEffect(() => {
    if (!target || !destination) return;
    let live = true;
    setPlan(null);
    setProblem(null);
    hostRef.current.post<Plan>('plan', { file: target.file, destination }).then(
      (next) => {
        if (live) setPlan(next);
      },
      (cause) => {
        if (live) setProblem(reason(cause));
      },
    );
    return () => {
      live = false;
    };
  }, [hostRef, target, destination]);

  if (!target) return null;
  const close = (): void => setTarget(null);
  const send = async (): Promise<void> => {
    setSending(true);
    setProblem(null);
    try {
      const done = await host.post<Done>('publish', { file: target.file, destination });
      if (done.reply_error) host.toast(t('replyFailed'), 'error', done.reply_error);
      else host.toast(t('sent', { destination }), 'success');
      close();
    } catch (cause) {
      setProblem(reason(cause));
    } finally {
      setSending(false);
    }
  };
  const said = plan && { post: t('actionPost'), edit: t('actionEdit'), repost: t('actionRepost'), none: t('actionNone'), refused: t('actionRefused') }[plan.action];
  const sendable = plan !== null && plan.action !== 'none' && plan.action !== 'refused';
  return (
    <Modal
      title={t('dialogTitle', { title: plan?.title ?? '' })}
      size="lg"
      onClose={close}
      foot={
        <Row justify="end" gap="sm">
          <Button onClick={close}>{sendable ? t('cancel') : t('close')}</Button>
          {sendable && (
            <Button variant="primary" disabled={sending} data-testid="channels-send" onClick={() => void send()}>
              {t('send')}
            </Button>
          )}
        </Row>
      }
    >
      <Stack gap="md" pad="md">
        {destinations?.length === 0 ? (
          <Notice>
            <Stack gap="sm">
              <Text size="sm">{t('noDestinations')}</Text>
              <Row>
                <Button
                  size="sm"
                  onClick={() => {
                    close();
                    host.navigate(`/plugins/${host.name}`);
                  }}
                >
                  {t('openSettings')}
                </Button>
              </Row>
            </Stack>
          </Notice>
        ) : (
          <SettingRow
            label={t('destination')}
            control={
              <Select aria-label={t('destination')} value={destination} onChange={(event: { target: HTMLSelectElement }) => setDestination(event.target.value)}>
                {(destinations ?? []).map((held) => (
                  <option key={held.name} value={held.name}>
                    {held.channel_name ? `${held.name} (${held.channel_name})` : held.name}
                  </option>
                ))}
              </Select>
            }
          />
        )}
        {problem && <Notice tone="error">{problem}</Notice>}
        {!plan && !problem && destinations?.length !== 0 && <SkeletonBar height={120} />}
        {plan && (
          <Stack gap="sm">
            <Text size="sm" weight="strong" block>
              {said}
            </Text>
            <Text size="sm" tone="muted" block>
              {plan.reason}
            </Text>
            {plan.reply && (
              <Stack gap="xs">
                <Text size="sm" block>
                  {t('replyWillSay')}
                </Text>
                {plan.reply.map((line) => (
                  <Text key={line} size="sm" tone="muted" block>
                    {line}
                  </Text>
                ))}
              </Stack>
            )}
            {plan.action !== 'none' && plan.action !== 'refused' && (
              <Stack gap="xs">
                <Text size="sm" tone="faint" block>
                  {t('preview')}
                </Text>
                <Card>
                  <Markdown html={plan.message} />
                </Card>
              </Stack>
            )}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}

// The open file against each channel, beside it in the Auxiliary Sidebar.
function PublishedView(): JSX.Element {
  const host = usePluginHost();
  const hostRef = useHostRef(host);
  const { t } = host;
  const file = fileOf(useOpen() as OpenFile);
  const [standing, setStanding] = useState<Standing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!file) return;
    hostRef.current.get<Standing>(`standing?file=${encodeURIComponent(file)}`).then(
      (next) => {
        setStanding(next);
        setProblem(null);
      },
      (cause) => setProblem(reason(cause)),
    );
  }, [hostRef, file]);
  useEffect(load, [load]);
  usePluginEvent('changed', load);
  useFileChanges(load);
  if (problem) return <Notice tone="error">{problem}</Notice>;
  if (!standing)
    return (
      <Stack pad="sm" gap="sm">
        <SkeletonBar height={16} />
        <SkeletonBar height={16} />
      </Stack>
    );
  if (standing.rows.length === 0)
    return (
      <Stack pad="sm" gap="sm">
        <Text size="sm" tone="faint" block>
          {t('noDestinations')}
        </Text>
        <Row>
          <Button size="sm" onClick={() => host.navigate(`/plugins/${host.name}`)}>
            {t('openSettings')}
          </Button>
        </Row>
      </Stack>
    );
  const label = { current: t('stateCurrent'), changed: t('stateChanged'), unpublished: t('stateUnpublished') };
  return (
    <Stack pad="sm" gap="md">
      {standing.rows.map((row) => (
        <Stack key={row.destination} gap="xs">
          <Row justify="between">
            <Text size="sm" weight="strong">
              {row.destination}
            </Text>
            <Badge tone={row.state === 'current' ? 'ok' : row.state === 'changed' ? 'warn' : 'default'}>{label[row.state]}</Badge>
          </Row>
          <Row gap="sm">
            {row.state !== 'current' && (
              <Button size="sm" variant="primary" data-testid="channels-publish-now" onClick={() => openDialog?.(standing.file, row.destination)}>
                {t('publishNow')}
              </Button>
            )}
            {row.url && (
              <Button size="sm" onClick={() => window.open(row.url!, '_blank', 'noopener')}>
                {t('openInTeams')}
              </Button>
            )}
          </Row>
        </Stack>
      ))}
    </Stack>
  );
}

type Signing = { user_code: string; verification_uri: string; interval: number };
type Refused = { message: string; address: string; permissions: string[] };

function ChannelsSettings(): JSX.Element {
  const host = usePluginHost();
  const hostRef = useHostRef(host);
  const { t } = host;
  const [state, setState] = useState<State | null>(null);
  const [signing, setSigning] = useState<Signing | null>(null);
  const [refusal, setRefusal] = useState<Refused | null>(null);
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    hostRef.current.get<State>('state').then(setState, (cause) => hostRef.current.toast(t('failed'), 'error', reason(cause)));
  }, [hostRef, t]);
  useEffect(load, [load]);
  usePluginEvent('changed', load);

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
            load();
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
  }, [hostRef, signing, load, t]);

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

  if (!state) return <SkeletonBar height={120} />;
  const { account, destinations } = state;
  return (
    <Stack gap="lg">
      <Card>
        <SettingsHead>{t('account')}</SettingsHead>
        <SettingRow
          label={account ? t('signedInAs', { name: account.name || account.username }) : t('notSignedIn')}
          {...(account ? { hint: account.can_edit ? t('canEdit') : t('cannotEdit') } : {})}
          control={
            account ? (
              <Button disabled={busy} onClick={() => void act(() => host.post('logout').then(load))}>
                {t('signOut')}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy || signing !== null} data-testid="channels-sign-in" onClick={() => void signIn(false)}>
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
                {t('signingIn', { address: signing.verification_uri })}
              </Text>
              <Text size="lg" weight="strong" block data-testid="channels-user-code">
                {signing.user_code}
              </Text>
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
      <Card>
        <SettingsHead>{t('channels')}</SettingsHead>
        <Text size="sm" tone="muted" block>
          {t('channelsHint')}
        </Text>
        {destinations.length === 0 && (
          <Text size="sm" tone="faint" block>
            {t('noChannelsYet')}
          </Text>
        )}
        {destinations.map((destination) => (
          <SettingRow
            key={destination.name}
            label={destination.name}
            {...(destination.channel_name ? { hint: destination.channel_name } : {})}
            control={
              <Button
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    if (await host.dialog.confirm(t('removeConfirm', { name: destination.name }), { danger: true, ok: t('remove') })) await host.post('disconnect', { name: destination.name });
                    load();
                  })
                }
              >
                {t('remove')}
              </Button>
            }
          />
        ))}
        <SettingRow
          label={t('name')}
          control={
            <Input aria-label={t('name')} placeholder={t('namePlaceholder')} value={name} data-testid="channels-name" onChange={(event: { target: HTMLInputElement }) => setName(event.target.value)} />
          }
        />
        <SettingRow
          label={t('link')}
          hint={t('linkHint')}
          control={<Input aria-label={t('link')} value={link} data-testid="channels-link" onChange={(event: { target: HTMLInputElement }) => setLink(event.target.value)} />}
        />
        <Row justify="end">
          <Button
            variant="primary"
            data-testid="channels-add"
            disabled={busy || name.trim() === '' || link.trim() === ''}
            onClick={() =>
              void act(async () => {
                await host.post('connect', { name, link });
                setName('');
                setLink('');
                load();
              })
            }
          >
            {t('add')}
          </Button>
        </Row>
      </Card>
    </Stack>
  );
}

export const page: PagePlugin = {
  name: 'channels',
  strings: CHANNELS_STRINGS,
  views: [{ sector: 'auxiliary', name: 'published', title: 'Channels', icon: 'megaphone', render: () => <PublishedView />, when: publishable }],
  commands: [
    {
      id: 'publish',
      title: 'Publish…',
      when: publishable,
      run: (open: OpenFile) => {
        const file = fileOf(open);
        if (file) openDialog?.(file);
      },
    },
  ],
  layer: () => <PublishDialog />,
  settings: () => <ChannelsSettings />,
  settingsDrawn: ['destinations'],
};
