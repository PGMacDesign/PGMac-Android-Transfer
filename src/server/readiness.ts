/** What the server posts to the desktop app once it is accepting connections. */
export interface ListeningMessage {
  type: 'listening';
  port: number;
}

export interface ParentPortLike {
  postMessage(message: ListeningMessage): void;
}

/**
 * Tells the Electron main process the server is up. `parentPort` only exists when the server
 * runs in a `utilityProcess`; in browser mode there is no one to tell. Returns whether it posted.
 */
export function announceListening(port: number, parentPort: ParentPortLike | undefined): boolean {
  if (!parentPort) return false;
  parentPort.postMessage({ type: 'listening', port });
  return true;
}

export interface StartupSteps {
  listen(): Promise<void>;
  clearStaleStaging(): Promise<void>;
  announce(): void;
}

/**
 * Announces only once the port is open and stale staging is gone: a page opened sooner could
 * start an upload whose staging files the cleanup then deletes. A failure in either step
 * rejects without announcing.
 */
export async function startUp(steps: StartupSteps): Promise<void> {
  await steps.listen();
  await steps.clearStaleStaging();
  steps.announce();
}
