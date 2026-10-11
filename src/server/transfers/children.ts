import type { ChildProcess } from 'node:child_process';

// Plain pids, never ChildProcess objects: forceStop runs inside process.on('exit'), where
// only synchronous work happens and nothing about a child object can be trusted to be current.
const pids = new Set<number>();

/**
 * Records a transfer process the server just spawned so `forceStop()` can kill it. Call it
 * right after `spawn`, before the child can have exited; the pid leaves on the child's `exit`.
 */
export function trackChild(child: ChildProcess): void {
  const pid = child.pid;
  // A spawn that failed (missing binary) has no pid and reports through 'error'.
  if (pid === undefined) return;
  pids.add(pid);
  child.once('exit', () => pids.delete(pid));
}

/** The pids of tracked transfer processes that have not exited yet. */
export function trackedPids(): number[] {
  return [...pids];
}

/**
 * Synchronously SIGKILLs every tracked transfer process. The last resort when a graceful
 * shutdown didn't finish: it touches no files, so partials may be left behind (hidden, and
 * never in place of an original). Only pids this server spawned are signalled; the adb server
 * daemon is never one of them.
 */
export function forceStop(): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // ESRCH: it exited before its 'exit' event ran. The others still need killing.
    }
  }
  // Killed or already gone; dropping them now means a second forceStop (shutdown, then the
  // exit hook) can't signal a pid the OS has since handed to an unrelated process.
  pids.clear();
}
