import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANCEL_BUTTON,
  COUNT_TIMEOUT_MS,
  FORCE_STOP_AT_MS,
  KILL_AT_MS,
  QUIT_BUTTON,
  QuitController,
  quitPrompt,
} from '../../electron/quit.ts';

/** A server that records what main sends and answers only when the test says so. */
function harness(opts: { running?: boolean; noServer?: boolean } = {}) {
  let running = opts.running ?? true;
  const posted: string[] = [];
  const kill = vi.fn(() => {
    running = false;
  });
  const quit = vi.fn();
  let answer: ((quit: boolean) => void) | null = null;
  let dialogSignal: AbortSignal | null = null;
  const confirm = vi.fn((_count: number, signal: AbortSignal) => {
    dialogSignal = signal;
    return new Promise<boolean>((resolve, reject) => {
      answer = resolve;
      // Electron closes an aborted dialog; the answer is then ignored either way.
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  });
  const controller = new QuitController({
    server: () =>
      opts.noServer
        ? null
        : {
            running: () => running,
            post: (m) => void posted.push(m.type),
            kill,
          },
    confirm,
    quit,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout),
  });
  return {
    controller,
    posted,
    kill,
    quit,
    confirm,
    answer: (q: boolean) => answer!(q),
    dialogSignal: () => dialogSignal,
    /** The server process exits: the controller hears about it as main would. */
    exit: () => {
      running = false;
      controller.onServerExit();
    },
    reply: (m: unknown) => controller.onServerMessage(m),
  };
}

/** Lets promise callbacks (the dialog's answer) run without moving the clock. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('quitPrompt', () => {
  it('names one transfer, or several, and makes Quit the default', () => {
    expect(quitPrompt(1)).toMatchObject({
      message: 'Quit PGMac Android Transfer?',
      detail: '1 transfer in progress will be cancelled.',
      buttons: ['Quit', 'Cancel'],
      defaultId: QUIT_BUTTON,
      cancelId: CANCEL_BUTTON,
    });
    expect(quitPrompt(3).detail).toBe('3 transfers in progress will be cancelled.');
    expect(quitPrompt(1).buttons[QUIT_BUTTON]).toBe('Quit');
    expect(quitPrompt(1).buttons[CANCEL_BUTTON]).toBe('Cancel');
  });
});

describe('QuitController', () => {
  it('holds the quit and asks the server, not the user, how many jobs are active', () => {
    const h = harness();
    expect(h.controller.allowQuit()).toBe(false);
    expect(h.posted).toEqual(['countActive']);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.controller.shuttingDown).toBe(false);
  });

  it('with nothing active, shuts the server down with no prompt and quits on its exit', async () => {
    const h = harness();
    h.controller.allowQuit();
    h.reply({ type: 'activeCount', count: 0 });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.posted).toEqual(['countActive', 'shutdown']);
    expect(h.controller.shuttingDown).toBe(true);
    await vi.advanceTimersByTimeAsync(300);
    h.reply({ type: 'shutdownDone' });
    expect(h.quit).not.toHaveBeenCalled();
    h.exit();
    expect(h.quit).toHaveBeenCalledOnce();
    // The quit() call re-enters before-quit, which must now let it through.
    expect(h.controller.allowQuit()).toBe(true);
    await vi.advanceTimersByTimeAsync(KILL_AT_MS);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.posted).toEqual(['countActive', 'shutdown']);
  });

  it('with jobs active, asks first and shuts down on Quit', async () => {
    const h = harness();
    h.controller.allowQuit();
    h.reply({ type: 'activeCount', count: 2 });
    expect(h.confirm).toHaveBeenCalledExactlyOnceWith(2, expect.any(AbortSignal));
    expect(h.posted).toEqual(['countActive']);
    h.answer(true);
    await settle();
    expect(h.posted).toEqual(['countActive', 'shutdown']);
    h.exit();
    expect(h.quit).toHaveBeenCalledOnce();
    expect(h.kill).not.toHaveBeenCalled();
  });

  it('on Cancel changes nothing: no message, no kill, no quit, and the app can quit later', async () => {
    const h = harness();
    h.controller.allowQuit();
    h.reply({ type: 'activeCount', count: 1 });
    h.answer(false);
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.posted).toEqual(['countActive']);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
    expect(h.controller.shuttingDown).toBe(false);
    // A later quit starts afresh.
    expect(h.controller.allowQuit()).toBe(false);
    expect(h.posted).toEqual(['countActive', 'countActive']);
  });

  it('ignores a second Cmd+Q while the dialog is open', async () => {
    const h = harness();
    h.controller.allowQuit();
    h.reply({ type: 'activeCount', count: 1 });
    expect(h.controller.allowQuit()).toBe(false);
    expect(h.controller.allowQuit()).toBe(false);
    expect(h.confirm).toHaveBeenCalledOnce();
    expect(h.posted).toEqual(['countActive']);
    expect(h.dialogSignal()!.aborted).toBe(false);
    h.answer(false);
    await settle();
    expect(h.posted).toEqual(['countActive']);
    expect(h.quit).not.toHaveBeenCalled();
  });

  it('treats no answer within 2 seconds as nothing active', async () => {
    const h = harness();
    h.controller.allowQuit();
    await vi.advanceTimersByTimeAsync(COUNT_TIMEOUT_MS - 1);
    expect(h.posted).toEqual(['countActive']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.posted).toEqual(['countActive', 'shutdown']);
    // A late answer doesn't bring up the dialog.
    h.reply({ type: 'activeCount', count: 4 });
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('quits within 10 seconds when the server ignores every message', async () => {
    const h = harness();
    h.controller.allowQuit();
    await vi.advanceTimersByTimeAsync(COUNT_TIMEOUT_MS);
    // Confirmation (here, the count timeout) is t = 0 for the shutdown timeline.
    await vi.advanceTimersByTimeAsync(FORCE_STOP_AT_MS - 1);
    expect(h.posted).toEqual(['countActive', 'shutdown']);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.posted).toEqual(['countActive', 'shutdown', 'forceStop']);
    expect(h.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(KILL_AT_MS - FORCE_STOP_AT_MS - 1);
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.kill).toHaveBeenCalledOnce();
    expect(h.quit).toHaveBeenCalledOnce();
    expect(h.kill.mock.invocationCallOrder[0]).toBeLessThan(h.quit.mock.invocationCallOrder[0]!);
  });

  it('quits on the exit that follows forceStop, without killing', async () => {
    const h = harness();
    h.controller.allowQuit();
    h.reply({ type: 'activeCount', count: 0 });
    await vi.advanceTimersByTimeAsync(FORCE_STOP_AT_MS);
    expect(h.posted).toContain('forceStop');
    await vi.advanceTimersByTimeAsync(200);
    h.exit();
    expect(h.quit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(KILL_AT_MS);
    expect(h.kill).not.toHaveBeenCalled();
  });

  it('kills a server that never exits after forceStop at 9.5 seconds', async () => {
    const h = harness();
    h.controller.allowQuit();
    h.reply({ type: 'activeCount', count: 3 });
    h.answer(true);
    await settle();
    await vi.advanceTimersByTimeAsync(KILL_AT_MS - 1);
    expect(h.posted).toEqual(['countActive', 'shutdown', 'forceStop']);
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.kill).toHaveBeenCalledOnce();
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it('never forces a graceful reply: shutdownDone at 1 s and exit at 1.2 s quits at 1.2 s', async () => {
    const h = harness();
    h.controller.allowQuit();
    h.reply({ type: 'activeCount', count: 1 });
    h.answer(true);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    h.reply({ type: 'shutdownDone' });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.quit).not.toHaveBeenCalled();
    h.exit();
    expect(h.quit).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(KILL_AT_MS);
    expect(h.posted).not.toContain('forceStop');
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it('never forces a graceful reply: shutdownDone at 1 s and no exit kills at 9.5 s only', async () => {
    const h = harness();
    h.controller.allowQuit();
    h.reply({ type: 'activeCount', count: 1 });
    h.answer(true);
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    h.reply({ type: 'shutdownDone' });
    await vi.advanceTimersByTimeAsync(KILL_AT_MS - 1000 - 1);
    expect(h.posted).not.toContain('forceStop');
    expect(h.kill).not.toHaveBeenCalled();
    expect(h.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.kill).toHaveBeenCalledOnce();
    expect(h.quit).toHaveBeenCalledOnce();
    expect(h.posted).not.toContain('forceStop');
  });

  it('a signal while the dialog is open aborts it and quits within the same cap', async () => {
    const h = harness();
    h.controller.allowQuit();
    h.reply({ type: 'activeCount', count: 2 });
    await vi.advanceTimersByTimeAsync(5000);
    h.controller.signal();
    expect(h.dialogSignal()!.aborted).toBe(true);
    expect(h.posted).toEqual(['countActive', 'shutdown']);
    await settle();
    // The aborted dialog's late answer, whatever it is, changes nothing.
    h.answer(false);
    await settle();
    expect(h.controller.shuttingDown).toBe(true);
    await vi.advanceTimersByTimeAsync(KILL_AT_MS);
    expect(h.posted).toEqual(['countActive', 'shutdown', 'forceStop']);
    expect(h.kill).toHaveBeenCalledOnce();
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it('a signal with no quit under way shuts down without asking', () => {
    const h = harness();
    h.controller.signal();
    expect(h.posted).toEqual(['shutdown']);
    expect(h.confirm).not.toHaveBeenCalled();
    h.controller.signal();
    expect(h.posted).toEqual(['shutdown']);
    h.exit();
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it('a signal while counting skips the dialog', () => {
    const h = harness();
    h.controller.allowQuit();
    h.controller.signal();
    h.reply({ type: 'activeCount', count: 5 });
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.posted).toEqual(['countActive', 'shutdown']);
  });

  it('lets the quit through at once when there is no server', () => {
    for (const h of [harness({ noServer: true }), harness({ running: false })]) {
      expect(h.controller.allowQuit()).toBe(true);
      expect(h.posted).toEqual([]);
      // before-quit is already quitting; calling quit() again from inside it would recurse.
      expect(h.quit).not.toHaveBeenCalled();
    }
  });

  it('a signal with no server quits straight away', () => {
    const h = harness({ noServer: true });
    h.controller.signal();
    expect(h.quit).toHaveBeenCalledOnce();
  });

  it('quits when the server exits before answering the count', () => {
    const h = harness();
    h.controller.allowQuit();
    h.exit();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.quit).toHaveBeenCalledOnce();
    expect(h.posted).toEqual(['countActive']);
  });

  it('treats a dialog that fails to show as Cancel', async () => {
    const h = harness();
    h.confirm.mockRejectedValueOnce(new Error('no dialog'));
    h.controller.allowQuit();
    h.reply({ type: 'activeCount', count: 1 });
    await settle();
    expect(h.controller.shuttingDown).toBe(false);
    expect(h.posted).toEqual(['countActive']);
    expect(h.quit).not.toHaveBeenCalled();
  });

  it('ignores messages that are not quit replies', () => {
    const h = harness();
    h.controller.allowQuit();
    for (const m of [null, 'activeCount', { type: 'listening', port: 1 }, { type: 'other' }]) {
      h.reply(m);
    }
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.posted).toEqual(['countActive']);
  });
});
