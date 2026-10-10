import type { SessionSnapshot } from '../../shared/protocol.ts';
import { Icon } from './ui.tsx';

export type PillTone = 'ok' | 'warn' | 'bad' | 'busy' | 'idle';

export interface Pill {
  text: string;
  tone: PillTone;
  title: string;
}

export function pillFor(
  adbFound: boolean,
  session: SessionSnapshot,
  uiPhase: 'searching' | 'pairing' | null,
): Pill {
  const dev = session.device;
  const addr = dev ? (dev.address ?? dev.serial) : '';
  if (!adbFound) return { text: 'Setup required', tone: 'bad', title: 'adb not found' };
  switch (session.state) {
    case 'connected':
      return { text: 'Connected', tone: 'ok', title: dev ? `${dev.model} · ${addr}` : '' };
    case 'reconnecting':
      return { text: 'Reconnecting…', tone: 'warn', title: addr ? `Trying ${addr}` : '' };
    case 'lost':
      return { text: 'Connection lost', tone: 'bad', title: addr ? `Last seen at ${addr}` : '' };
    case 'connecting':
      return { text: 'Connecting…', tone: 'busy', title: '' };
    case 'ending':
      return { text: 'Ending session…', tone: 'busy', title: '' };
    default:
      if (uiPhase === 'searching') return { text: 'Searching…', tone: 'busy', title: '' };
      if (uiPhase === 'pairing') return { text: 'Pairing…', tone: 'busy', title: '' };
      return { text: 'No device', tone: 'idle', title: 'No Android device connected' };
  }
}

export function AppBar({
  pill,
  showEnd,
  startDisabled,
  menuOpen,
  onStart,
  onEnd,
  onToggleMenu,
}: {
  pill: Pill;
  showEnd: boolean;
  startDisabled: boolean;
  menuOpen: boolean;
  onStart: () => void;
  onEnd: () => void;
  onToggleMenu: () => void;
}) {
  return (
    <header className="appbar">
      <div className="brand">
        <div className="brand-mark">
          <Icon name="sync_alt" />
        </div>
        <div className="brand-name">PGMac Android Transfer</div>
      </div>
      <div className={`pill ${pill.tone}`} role="status" title={pill.title}>
        <span className="pill-dot" />
        {pill.text}
      </div>
      <div className="spacer" />
      {showEnd ? (
        <button className="btn" onClick={onEnd}>
          End Session
        </button>
      ) : (
        <button className="btn primary" onClick={onStart} disabled={startDisabled}>
          Start Session
        </button>
      )}
      <button
        className="icon-btn"
        style={{ width: 30, height: 30, borderRadius: 7 }}
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={onToggleMenu}
      >
        <span className="icon" aria-hidden="true" style={{ fontSize: 20 }}>
          more_horiz
        </span>
      </button>
    </header>
  );
}
