import type { ForceStopMessage, QuitReply, QuitRequest } from '../src/server/parentPort.ts';

/** How long main holds a quit waiting for the server to say how many jobs are active. */
export const COUNT_TIMEOUT_MS = 2000;
/** From confirmation: no `shutdownDone` by now and the server is told to force-stop. */
export const FORCE_STOP_AT_MS = 8500;
/** From confirmation: the server still hasn't exited, so it is killed and the app quits. */
export const KILL_AT_MS = 9500;

export const QUIT_BUTTON = 0;
export const CANCEL_BUTTON = 1;

/** The quit confirmation, as `dialog.showMessageBox` options minus the signal. */
export function quitPrompt(count: number) {
  return {
    type: 'warning' as const,
    message: 'Quit PGMac Android Transfer?',
    detail:
      count === 1
        ? '1 transfer in progress will be cancelled.'
        : `${count} transfers in progress will be cancelled.`,
    buttons: ['Quit', 'Cancel'],
    defaultId: QUIT_BUTTON,
    cancelId: CANCEL_BUTTON,
  };
}

/** The forked server process as the quit sequence uses it. */
export interface QuitServer {
  /** False once the process has exited (or if it never started). */
  running(): boolean;
  post(message: QuitRequest | ForceStopMessage): void;
  kill(): void;
}

export interface QuitControllerDeps {
  server(): QuitServer | null;
  /** Shows the confirmation; resolves true for Quit. Aborting `signal` must close it. */
  confirm(count: number, signal: AbortSignal): Promise<boolean>;
  /** Ends the app. Called once, after which `allowQuit()` returns true. */
  quit(): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

type State = 'idle' | 'counting' | 'confirming' | 'stopping' | 'done';

/**
 * The desktop app's quit sequence: ask the server how many jobs a quit would cancel, confirm
 * with the user if any, then let the server shut down on its own and wait for it to exit.
 * The server is only ever killed when it hasn't exited by `KILL_AT_MS`, because a killed
 * server can't run its exit hook, which is what stops transfer processes it lost track of.
 */
export class QuitController {
  private state: State = 'idle';
  private countTimer: unknown = null;
  private stopTimers: unknown[] = [];
  private dialog: AbortController | null = null;
  private shutdownDone = false;
  private readonly deps: QuitControllerDeps;

  constructor(deps: QuitControllerDeps) {
    this.deps = deps;
  }

  /** True once the server is being shut down; Cancel is no longer possible. */
  get shuttingDown(): boolean {
    return this.state === 'stopping' || this.state === 'done';
  }

  /**
   * For `before-quit`: whether this quit may go ahead now. False means prevent it; the
   * controller calls `quit()` again when the server is gone. A quit while the sequence is
   * already running (a second Cmd+Q at the dialog, say) starts nothing new.
   */
  allowQuit(): boolean {
    if (this.state === 'done') return true;
    if (this.state !== 'idle') return false;
    const server = this.deps.server();
    if (!server?.running()) {
      // Already quitting: calling quit() from inside before-quit would start it twice.
      this.state = 'done';
      return true;
    }
    this.state = 'counting';
    this.countTimer = this.deps.setTimeout(() => {
      this.countTimer = null;
      // A server too busy to answer is treated as having nothing to cancel; the shutdown
      // timeline below still bounds how long it gets.
      if (this.state === 'counting') this.stop();
    }, COUNT_TIMEOUT_MS);
    server.post({ type: 'countActive' });
    return false;
  }

  /** SIGINT or SIGTERM to main: a confirmed quit, closing the dialog if it is open. */
  signal(): void {
    if (this.shuttingDown) return;
    this.stop();
  }

  onServerMessage(message: unknown): void {
    const m = message as Partial<QuitReply> | null;
    if (typeof m !== 'object' || m === null) return;
    if (m.type === 'activeCount') {
      if (this.state !== 'counting') return;
      this.clearCountTimer();
      const count = typeof m.count === 'number' && m.count > 0 ? m.count : 0;
      if (count === 0) this.stop();
      else this.ask(count);
    } else if (m.type === 'shutdownDone') {
      // Only cancels the forced stop; the quit itself waits for the exit.
      this.shutdownDone = true;
    }
  }

  onServerExit(): void {
    if (this.state === 'stopping') this.finish();
    // While counting there is no one left to answer, and so nothing to cancel.
    else if (this.state === 'counting') this.stop();
  }

  private ask(count: number): void {
    this.state = 'confirming';
    const dialog = new AbortController();
    this.dialog = dialog;
    const answered = (quit: boolean) => {
      // Superseded: a signal aborted the dialog and the quit is already under way.
      if (this.dialog !== dialog || this.state !== 'confirming') return;
      this.dialog = null;
      if (quit) this.stop();
      else this.state = 'idle';
    };
    // A dialog that fails to show is a Cancel: quitting would cancel transfers unasked.
    this.deps.confirm(count, dialog.signal).then(answered, () => answered(false));
  }

  private stop(): void {
    this.clearCountTimer();
    this.state = 'stopping';
    if (this.dialog) {
      const dialog = this.dialog;
      this.dialog = null;
      dialog.abort();
    }
    const server = this.deps.server();
    if (!server?.running()) {
      this.finish();
      return;
    }
    // Both timers start now so neither depends on the other or on any reply arriving.
    this.stopTimers.push(
      this.deps.setTimeout(() => {
        if (this.state === 'stopping' && !this.shutdownDone) server.post({ type: 'forceStop' });
      }, FORCE_STOP_AT_MS),
      this.deps.setTimeout(() => {
        if (this.state !== 'stopping') return;
        server.kill();
        this.finish();
      }, KILL_AT_MS),
    );
    server.post({ type: 'shutdown' });
  }

  private finish(): void {
    this.clearCountTimer();
    for (const t of this.stopTimers.splice(0)) this.deps.clearTimeout(t);
    this.state = 'done';
    this.deps.quit();
  }

  private clearCountTimer(): void {
    if (this.countTimer === null) return;
    this.deps.clearTimeout(this.countTimer);
    this.countTimer = null;
  }
}
