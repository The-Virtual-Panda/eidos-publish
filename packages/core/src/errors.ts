// A failure a person can act on, with the provider's status when it gave one,
// which decides what a publish does next (Publish REQ8). Its words never carry a token.
export class ProviderError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
  }
}
