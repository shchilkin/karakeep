/** Transport outcomes contain no service response text or prepared media. */
export class LocalResourceWait extends Error {
  readonly delayMs = 30_000;
  constructor() {
    super("waiting_resource");
  }
}

/** An unavailable executor must not trigger another model in the same run. */
export class LocalExecutorUnavailable extends Error {
  readonly kind = "local_failed";
  constructor() {
    super("local_failed");
  }
}

export function checkLocalStatus(status: number) {
  if (status === 429) throw new LocalResourceWait();
  if (status >= 500) throw new LocalExecutorUnavailable();
}
