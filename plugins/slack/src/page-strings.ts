// The Slack plugin's own words, in the languages the Eidos MD page draws in;
// `manifestTitle` and `manifestDescription` name it on the host's pages.
const en = {
  manifestTitle: 'Publish to Slack',
  manifestDescription: 'Publish a blueprint or a top-level doc to a Slack channel as one message, edited in place when the file changes',
  account: 'Slack app',
  notSignedIn: 'No Slack app is connected.',
  signedInTo: 'Connected to {name}',
  createApp: 'Create the app',
  createAppHint: 'Slack opens with everything filled in. Install it to your workspace, then copy its Bot User OAuth Token from OAuth & Permissions.',
  token: 'Bot token',
  tokenHint: 'Starts with xoxb-. It stays on this machine.',
  connect: 'Connect',
  signOut: 'Disconnect',
  inviteHint: 'For a private channel, invite the app with /invite in the channel.',
  linkHint: 'In Slack, choose Copy link on the channel, then paste it here. Its id works too.',
};

const es: Partial<typeof en> = {
  manifestTitle: 'Publicar en Slack',
  manifestDescription: 'Publica un blueprint o un documento de nivel superior en un canal de Slack como un mensaje, que se edita cuando cambia el archivo',
  account: 'Aplicación de Slack',
  notSignedIn: 'No hay ninguna aplicación de Slack conectada.',
  signedInTo: 'Conectado a {name}',
  createApp: 'Crear la aplicación',
  createAppHint: 'Slack se abre con todo rellenado. Instálala en tu espacio de trabajo y copia su Bot User OAuth Token desde OAuth & Permissions.',
  token: 'Token del bot',
  tokenHint: 'Empieza por xoxb-. Se queda en este equipo.',
  connect: 'Conectar',
  signOut: 'Desconectar',
  inviteHint: 'Para un canal privado, invita a la aplicación con /invite en el canal.',
  linkHint: 'En Slack, elige Copiar enlace en el canal y pégalo aquí. También sirve su id.',
};

const pt: Partial<typeof en> = {
  manifestTitle: 'Publicar no Slack',
  manifestDescription: 'Publique um blueprint ou um documento de nível superior em um canal do Slack como uma mensagem, editada quando o arquivo muda',
  account: 'Aplicativo do Slack',
  notSignedIn: 'Nenhum aplicativo do Slack está conectado.',
  signedInTo: 'Conectado a {name}',
  createApp: 'Criar o aplicativo',
  createAppHint: 'O Slack abre com tudo preenchido. Instale no seu workspace e copie o Bot User OAuth Token em OAuth & Permissions.',
  token: 'Token do bot',
  tokenHint: 'Começa com xoxb-. Fica neste computador.',
  connect: 'Conectar',
  signOut: 'Desconectar',
  inviteHint: 'Para um canal privado, convide o aplicativo com /invite no canal.',
  linkHint: 'No Slack, escolha Copiar link no canal e cole aqui. O id também funciona.',
};

export const SLACK_STRINGS = { en, es, pt };
