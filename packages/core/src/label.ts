// How a channel is named to a person: many are called General, so its team comes first where it is known.
export function channelLabel(destination: { name: string; channel_name: string; team_name?: string | undefined }): string {
  const channel = destination.channel_name || destination.name;
  return destination.team_name ? `${destination.team_name} / ${channel}` : channel;
}
