/** What the desktop app sends when a graceful shutdown ran out of time. */
export interface ForceStopMessage {
  type: 'forceStop';
}

/** The receiving half of Electron's `process.parentPort` in a `utilityProcess`. */
export interface ParentPortReceiver {
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
}

/**
 * Lets the desktop app end the server immediately: kill every transfer process, then exit.
 * In browser mode there is no parent port and nothing is installed. Returns whether it listened.
 */
export function listenForForceStop(
  parentPort: ParentPortReceiver | undefined,
  actions: { forceStop: () => void; exit: (code: number) => void },
): boolean {
  if (!parentPort) return false;
  parentPort.on('message', (event) => {
    const data = event?.data as Partial<ForceStopMessage> | undefined;
    if (data?.type !== 'forceStop') return;
    actions.forceStop();
    actions.exit(1);
  });
  return true;
}
