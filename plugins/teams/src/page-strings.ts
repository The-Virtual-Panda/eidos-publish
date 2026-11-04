// The Teams plugin's own words, in the languages the Eidos MD page draws in;
// `manifestTitle` and `manifestDescription` name it on the host's pages.
const en = {
  manifestTitle: 'Publish to Microsoft Teams',
  manifestDescription: 'Publish a blueprint or a top-level doc to a Microsoft Teams channel as one message, edited in place when the file changes',
  account: 'Sign-in',
  notSignedIn: 'You are not signed in to Teams.',
  signedInAs: 'Signed in as {name}',
  canEdit: 'A change to a published file edits its message in place.',
  cannotEdit: 'A change to a published file posts a new message.',
  signIn: 'Sign in to Teams',
  enableEdit: 'Allow editing in place',
  enableEditHint: 'Your administrator must approve this. Until they do, a change posts a new message.',
  signOut: 'Sign out',
  signingIn: 'Continue in your browser to sign in with Microsoft.',
  openSignIn: 'Open Microsoft sign-in',
  waiting: 'Waiting for you to finish in your browser…',
  refusedTitle: 'Your organization has to approve this app',
  refusedHint: 'Send your administrator this address. It asks for {permissions}.',
  linkHint: 'In Teams, choose Get link to channel on the channel, then paste it here.',
};

const es: Partial<typeof en> = {
  manifestTitle: 'Publicar en Microsoft Teams',
  manifestDescription: 'Publica un blueprint o un documento de nivel superior en un canal de Microsoft Teams como un mensaje, que se edita cuando cambia el archivo',
  account: 'Inicio de sesión',
  notSignedIn: 'No has iniciado sesión en Teams.',
  signedInAs: 'Sesión iniciada como {name}',
  canEdit: 'Un cambio en un archivo publicado edita su mensaje.',
  cannotEdit: 'Un cambio en un archivo publicado publica un mensaje nuevo.',
  signIn: 'Iniciar sesión en Teams',
  enableEdit: 'Permitir la edición',
  enableEditHint: 'Tu administrador debe aprobarlo. Hasta entonces, un cambio publica un mensaje nuevo.',
  signOut: 'Cerrar sesión',
  signingIn: 'Continúa en tu navegador para iniciar sesión con Microsoft.',
  openSignIn: 'Abrir el inicio de sesión de Microsoft',
  waiting: 'Esperando a que termines en tu navegador…',
  refusedTitle: 'Tu organización tiene que aprobar esta aplicación',
  refusedHint: 'Envía esta dirección a tu administrador. Solicita {permissions}.',
  linkHint: 'En Teams, elige Obtener vínculo al canal en el canal y pégalo aquí.',
};

const pt: Partial<typeof en> = {
  manifestTitle: 'Publicar no Microsoft Teams',
  manifestDescription: 'Publique um blueprint ou um documento de nível superior em um canal do Microsoft Teams como uma mensagem, editada quando o arquivo muda',
  account: 'Login',
  notSignedIn: 'Você não entrou no Teams.',
  signedInAs: 'Conectado como {name}',
  canEdit: 'Uma alteração em um arquivo publicado edita a mensagem dele.',
  cannotEdit: 'Uma alteração em um arquivo publicado publica uma nova mensagem.',
  signIn: 'Entrar no Teams',
  enableEdit: 'Permitir a edição',
  enableEditHint: 'Seu administrador precisa aprovar. Até lá, uma alteração publica uma nova mensagem.',
  signOut: 'Sair',
  signingIn: 'Continue no navegador para entrar com a Microsoft.',
  openSignIn: 'Abrir o login da Microsoft',
  waiting: 'Aguardando você concluir no navegador…',
  refusedTitle: 'Sua organização precisa aprovar este aplicativo',
  refusedHint: 'Envie este endereço ao seu administrador. Ele solicita {permissions}.',
  linkHint: 'No Teams, escolha Obter link para o canal no canal e cole aqui.',
};

export const TEAMS_STRINGS = { en, es, pt };
