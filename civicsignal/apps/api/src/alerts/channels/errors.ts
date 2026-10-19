/** Delivery outcome classification shared by every channel. */
export class DeliveryError extends Error {
  constructor(readonly retryable: boolean, message: string, readonly status?: number) { super(message); this.name = 'DeliveryError'; }
}
