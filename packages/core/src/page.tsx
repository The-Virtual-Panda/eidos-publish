// The page half every publishing plugin has in common (Publish REQ10), drawn with
// the kit the Eidos MD page hands a plugin (`eidosmd/page`): a Publish… command on
// an open blueprint or top-level doc, a view in the Auxiliary Sidebar listing the
// channels it is published to, and the settings page holding the channels, with a
// plugin's own sign-in above them. Nothing sends until the person has seen what the
// dry run would send.
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import {
  Badge,
  Button,
  Card,
  Input,
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
  Switch,
} from 'eidosmd/page';
import { PUBLISH_STRINGS } from './page-strings.ts';

interface Destination {
  name: string;
  channel_name: string;
}
export interface Account {
  name: string;
  detail: string;
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
  posted_by_other?: string;
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

export const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const fileOf = (open: OpenFile): string | null => (open.kind === 'blueprint' ? (open.id ?? open.path ?? null) : open.kind === 'doc' ? (open.path ?? null) : null);
const publishable = (open: { kind: string }): boolean => open.kind === 'blueprint' || open.kind === 'doc';

// The dialog is opened from a palette command and from the view, wherever the person is, so it lives in the page's layer.
let openDialog: ((file: string, destination?: string) => void) | null = null;

export function useHostRef(host: PluginHost): { current: PluginHost } {
  const ref = useRef(host);
  ref.current = host;
  return ref;
}

function PublishDialog({ service, MessagePreview }: { service: string; MessagePreview: (props: { message: string }) => JSX.Element }): JSX.Element | null {
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
      const done = await host.post<Done>('publish', { file: target.file, destination, ...(plan?.posted_by_other ? { take_over: true } : {}) });
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
            <Button variant="primary" disabled={sending} data-testid="publish-send" onClick={() => void send()}>
              {plan?.posted_by_other ? t('sendAnyway') : t('send', { service })}
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
                    {held.channel_name || held.name}
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
            {plan.posted_by_other ? (
              <Notice tone="warn">{plan.reason}</Notice>
            ) : (
              <Text size="sm" tone="muted" block>
                {plan.reason}
              </Text>
            )}
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
                  <MessagePreview message={plan.message} />
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
function PublishedView({ service }: { service: string }): JSX.Element {
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
              <Button size="sm" variant="primary" data-testid="publish-now" onClick={() => openDialog?.(standing.file, row.destination)}>
                {t('publishNow')}
              </Button>
            )}
            {row.url && (
              <Button size="sm" onClick={() => window.open(row.url!, '_blank', 'noopener')}>
                {t('openIn', { service })}
              </Button>
            )}
          </Row>
        </Stack>
      ))}
    </Stack>
  );
}

export type SignIn = (props: { account: Account | null; reload: () => void }) => JSX.Element;

function ReplySettings(): JSX.Element | null {
  const host = usePluginHost();
  const hostRef = useHostRef(host);
  const { t } = host;
  const [options, setOptions] = useState<{ reply: boolean; reply_min_chars: number } | null>(null);
  const [size, setSize] = useState('');
  const take = useCallback((next: { reply: boolean; reply_min_chars: number }) => {
    setOptions(next);
    setSize(String(next.reply_min_chars));
  }, []);
  useEffect(() => {
    hostRef.current.get<{ reply: boolean; reply_min_chars: number }>('options').then(take, (cause) => hostRef.current.toast(t('failed'), 'error', reason(cause)));
  }, [hostRef, take, t]);
  const save = (name: string, value: unknown): void => {
    host.post<{ reply: boolean; reply_min_chars: number }>('options', { name, value }).then(take, (cause) => {
      host.toast(t('failed'), 'error', reason(cause));
      if (options) setSize(String(options.reply_min_chars));
    });
  };
  if (!options) return <SkeletonBar height={80} />;
  return (
    <Card>
      <SettingsHead>{t('replies')}</SettingsHead>
      <SettingRow
        label={t('replyLabel')}
        hint={t('replyHint')}
        control={<Switch aria-label={t('replyLabel')} checked={options.reply} data-testid="publish-reply" onChange={(event: { target: HTMLInputElement }) => save('reply', event.target.checked)} />}
      />
      {options.reply && (
        <SettingRow
          label={t('replySizeLabel')}
          hint={t('replySizeHint')}
          control={
            <Input
              aria-label={t('replySizeLabel')}
              type="number"
              value={size}
              data-testid="publish-reply-size"
              onChange={(event: { target: HTMLInputElement }) => setSize(event.target.value)}
              onBlur={() => {
                if (size !== String(options.reply_min_chars)) save('reply_min_chars', size);
              }}
            />
          }
        />
      )}
    </Card>
  );
}

function PublishSettings({ SignIn, linkNamesChannel, Extra }: { SignIn: SignIn; linkNamesChannel: boolean; Extra?: (() => JSX.Element | null) | undefined }): JSX.Element {
  const host = usePluginHost();
  const hostRef = useHostRef(host);
  const { t } = host;
  const [state, setState] = useState<State | null>(null);
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    hostRef.current.get<State>('state').then(setState, (cause) => hostRef.current.toast(t('failed'), 'error', reason(cause)));
  }, [hostRef, t]);
  useEffect(load, [load]);
  usePluginEvent('changed', load);

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

  if (!state) return <SkeletonBar height={120} />;
  const { account, destinations } = state;
  return (
    <Stack gap="lg">
      <SignIn account={account} reload={load} />
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
            label={destination.channel_name || destination.name}
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
          label={t('link')}
          hint={t('linkHint')}
          control={<Input aria-label={t('link')} value={link} data-testid="publish-link" onChange={(event: { target: HTMLInputElement }) => setLink(event.target.value)} />}
        />
        {!linkNamesChannel && (
          <SettingRow
            label={t('name')}
            control={
              <Input aria-label={t('name')} placeholder={t('namePlaceholder')} value={name} data-testid="publish-name" onChange={(event: { target: HTMLInputElement }) => setName(event.target.value)} />
            }
          />
        )}
        <Row justify="end">
          <Button
            variant="primary"
            data-testid="publish-add"
            disabled={busy || link.trim() === ''}
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
      <ReplySettings />
      {Extra && <Extra />}
    </Stack>
  );
}

export interface PublishPage {
  name: string;
  service: string;
  strings: { en: Record<string, string>; es?: Record<string, string>; pt?: Record<string, string> };
  SignIn: SignIn;
  // the view's mark in the sidebar
  Icon: () => JSX.Element;
  // a channel's link says what it is called, so nobody is asked to name it
  linkNamesChannel?: boolean;
  // the plugin's own settings, under the shared ones, and the names of those it draws
  Extra?: () => JSX.Element | null;
  drawn?: string[];
  // what people will see, in the form the service shows it
  MessagePreview: (props: { message: string }) => JSX.Element;
}

// A plugin's page half: the core's words with its own over them, and its service throughout.
export function publishPage({ name, service, strings, SignIn, Icon, MessagePreview, linkNamesChannel = false, Extra, drawn = [] }: PublishPage): PagePlugin {
  return {
    name,
    strings: {
      en: { ...PUBLISH_STRINGS.en, ...strings.en },
      es: { ...PUBLISH_STRINGS.es, ...strings.es },
      pt: { ...PUBLISH_STRINGS.pt, ...strings.pt },
    },
    // the host keys a view by its name across every plugin, so this one carries the plugin's
    views: [{ sector: 'auxiliary', name: `${name}-published`, title: service, icon: Icon, render: () => <PublishedView service={service} />, when: publishable }],
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
    layer: () => <PublishDialog service={service} MessagePreview={MessagePreview} />,
    settings: () => <PublishSettings SignIn={SignIn} linkNamesChannel={linkNamesChannel} Extra={Extra} />,
    settingsDrawn: ['destinations', 'reply', 'reply_min_chars', ...drawn],
  };
}
