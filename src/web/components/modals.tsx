import { useState, type ReactNode } from 'react';
import type {
  Candidate,
  Conflict,
  ConflictDecision,
  PairCodeRequest,
  PairingSnapshot,
} from '../../shared/protocol.ts';
import { fmtBytes, fmtCountdown, fmtDate, iconFor } from '../format.ts';
import { Icon, Modal, Spinner, useNow } from './ui.tsx';

// ------------------------------------------------------------ searching

export function SearchingModal({ onCancel }: { onCancel: () => void }) {
  return (
    <Modal onDismiss={onCancel}>
      <div
        className="dialog padded searching"
        role="dialog"
        aria-modal="true"
        aria-label="Searching for devices"
      >
        <div className="lead">
          <Spinner size={18} />
          <h2>Looking for devices on your network…</h2>
        </div>
        <div className="muted" style={{ lineHeight: 1.5 }}>
          Checking paired devices over Wireless debugging and USB. This usually takes a few seconds.
        </div>
        <div className="row-end">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ device picker

const TYPE = {
  wifi: { label: 'WiFi', icon: 'wifi' },
  usb: { label: 'USB', icon: 'usb' },
  emulator: { label: 'Emulator', icon: 'memory' },
} as const;

export function DevicePickerModal({
  candidates,
  connectingId,
  onConnect,
  onPair,
  onCancel,
}: {
  candidates: Candidate[];
  connectingId: string | null;
  onConnect: (id: string) => void;
  onPair: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal onDismiss={onCancel}>
      <div className="dialog picker" role="dialog" aria-modal="true" aria-label="Choose a device">
        <div className="picker-head">
          <h2>Choose a device</h2>
          <div className="dlg-sub">
            {candidates.length === 1 ? '1 device found' : `${candidates.length} devices found`} on
            your network and USB.
          </div>
        </div>
        <div className="picker-list">
          {candidates.map((c) => {
            const t = TYPE[c.transport];
            const connecting = connectingId === c.id;
            return (
              <div className="device" key={c.id}>
                <div className="glyph">
                  <Icon name={c.transport === 'emulator' ? 'developer_board' : 'smartphone'} />
                </div>
                <div className="info">
                  <div className="model">
                    <span>{c.model ?? 'Android device'}</span>
                    {c.lastUsed ? <span className="last">Last used</span> : null}
                  </div>
                  <div className="addr">{c.address}</div>
                </div>
                <span className="chip">
                  <Icon name={t.icon} />
                  {t.label}
                </span>
                <button
                  className="btn primary"
                  disabled={connectingId !== null}
                  onClick={() => onConnect(c.id)}
                >
                  {connecting ? <Spinner /> : null}
                  {connecting ? 'Connecting' : 'Connect'}
                </button>
              </div>
            );
          })}
        </div>
        <div className="picker-foot">
          <button className="btn link" onClick={onPair}>
            <Icon name="add" />
            Pair a new device
          </button>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ pairing

export function PairModal({
  pairing,
  tab,
  onTab,
  onRetryQr,
  onSubmitCode,
  onClose,
}: {
  pairing: PairingSnapshot | null;
  tab: 'qr' | 'code';
  onTab: (t: 'qr' | 'code') => void;
  onRetryQr: () => void;
  onSubmitCode: (req: PairCodeRequest) => Promise<void>;
  onClose: () => void;
}) {
  const success = pairing?.status === 'success';
  return (
    <Modal onDismiss={onClose}>
      <div className="dialog pair" role="dialog" aria-modal="true" aria-label="Pair a new device">
        <div className="pair-head">
          <h2>Pair a new device</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        {success ? (
          <div className="pair-success">
            <div className="ok">
              <Icon name="check" />
            </div>
            <h2>{pairing.deviceName ? `Paired with ${pairing.deviceName}.` : 'Paired.'}</h2>
            <div className="connecting">
              <Spinner />
              Connecting…
            </div>
          </div>
        ) : (
          <>
            <div className="tabs" role="tablist">
              <button
                role="tab"
                aria-selected={tab === 'qr'}
                className={`tab${tab === 'qr' ? ' on' : ''}`}
                onClick={() => onTab('qr')}
              >
                <Icon name="qr_code_2" />
                QR code
              </button>
              <button
                role="tab"
                aria-selected={tab === 'code'}
                className={`tab${tab === 'code' ? ' on' : ''}`}
                onClick={() => onTab('code')}
              >
                <Icon name="pin" />
                Pairing code
              </button>
            </div>
            {tab === 'qr' ? (
              <QrPane pairing={pairing?.mode === 'qr' ? pairing : null} onRetry={onRetryQr} />
            ) : (
              <CodePane
                pairing={pairing?.mode === 'code' ? pairing : null}
                onSubmit={onSubmitCode}
              />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function QrPane({ pairing, onRetry }: { pairing: PairingSnapshot | null; onRetry: () => void }) {
  const waiting = pairing?.status === 'waiting' || pairing?.status === 'pairing';
  const now = useNow(500, waiting);
  const timedOut = pairing?.status === 'timeout';
  const failed = pairing?.status === 'error';
  return (
    <div className="pair-qr">
      <div className={`qr-box${timedOut || failed ? ' expired' : ''}`}>
        {pairing?.qrSvg ? (
          // Server-generated SVG from the qrcode library; contains no user input.
          <div
            className="qr"
            aria-label="Pairing QR code"
            role="img"
            dangerouslySetInnerHTML={{ __html: pairing.qrSvg }}
          />
        ) : (
          <div className="placeholder">
            <Spinner size={18} />
          </div>
        )}
        {timedOut || failed ? (
          <div className="overlay">
            <div>{timedOut ? 'Code expired' : 'Pairing failed'}</div>
            <button className="btn primary" onClick={onRetry}>
              <Icon name="replay" />
              Try again
            </button>
          </div>
        ) : null}
      </div>
      <div className="steps">
        <Step n={1}>On your phone, open Settings › Developer options › Wireless debugging.</Step>
        <Step n={2}>Tap Pair device with QR code.</Step>
        <Step n={3}>Scan this code with the scanner that opens (not the Camera app).</Step>
        <div className="spacer" />
        {waiting && pairing ? (
          <div className="pair-status">
            <span style={{ color: 'var(--accent-ink)', display: 'flex' }}>
              <Spinner size={14} />
            </span>
            <span className="grow">
              {pairing.status === 'pairing' ? 'Pairing…' : 'Waiting for your phone…'}
            </span>
            <span className="num">{fmtCountdown(pairing.expiresAt - now)}</span>
          </div>
        ) : null}
        {timedOut ? (
          <div className="pair-status bad">
            <Icon name="timer_off" />
            Timed out. Nothing scanned the code.
          </div>
        ) : null}
        {failed ? (
          <div className="pair-status bad">
            <Icon name="error" />
            {pairing.error ?? 'Pairing failed.'}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="step">
      <span className="step-n">{n}</span>
      <span style={{ textWrap: 'pretty' }}>{children}</span>
    </div>
  );
}

function CodePane({
  pairing,
  onSubmit,
}: {
  pairing: PairingSnapshot | null;
  onSubmit: (req: PairCodeRequest) => Promise<void>;
}) {
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('');
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const busy = submitting || pairing?.status === 'pairing';
  const serverError =
    pairing?.status === 'error' || pairing?.status === 'timeout'
      ? (pairing.error ?? 'Pairing failed.')
      : null;
  const error = localError ?? serverError;

  const submit = async () => {
    const host = ip.trim();
    const p = Number(port.trim());
    if (!/^\d{6}$/.test(code)) return setLocalError('Enter the 6-digit code shown on your phone.');
    if (!host || !Number.isInteger(p) || p <= 0 || p > 65535)
      return setLocalError(
        'Enter the IP address and port shown under “Pair device with pairing code”.',
      );
    setLocalError(null);
    setSubmitting(true);
    try {
      await onSubmit({ host, port: p, code });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="pair-code">
      <Step n={1}>
        On your phone, open Wireless debugging and tap Pair device with pairing code.
      </Step>
      <Step n={2}>Enter the IP address, port and 6-digit code it shows.</Step>
      <div className="field-grid">
        <label className="field">
          IP address
          <input
            value={ip}
            onChange={(e) => setIp(e.target.value)}
            placeholder="192.168.1.42"
            inputMode="decimal"
          />
        </label>
        <label className="field">
          Port
          <input
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
            placeholder="41827"
            inputMode="numeric"
          />
        </label>
      </div>
      <label className="field">
        Pairing code
        <input
          className={`code${error ? ' invalid' : ''}`}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder="••••••"
          maxLength={6}
          inputMode="numeric"
          autoComplete="one-time-code"
        />
      </label>
      {error ? (
        <div className="alert" role="alert">
          <Icon name="error" fill />
          <span>{error}</span>
        </div>
      ) : null}
      <div className="pair-actions">
        <button className="btn primary" onClick={() => void submit()} disabled={busy}>
          {busy ? <Spinner /> : null}
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ conflicts

export interface ConflictState {
  batchId: string;
  destLabel: string;
  itemCount: number;
  conflicts: Conflict[];
  /** "On Pixel 8 Pro" / "On This Mac". */
  existingLabel: string;
  incomingLabel: string;
}

function metaText(isDir: boolean, size: number): string {
  if (isDir) return size > 0 ? `Folder · ${fmtBytes(size)}` : 'Folder';
  return fmtBytes(size);
}

export function ConflictModal({
  state,
  now,
  onResolve,
  onCancel,
}: {
  state: ConflictState;
  now: number;
  onResolve: (decisions: Record<string, ConflictDecision>) => void;
  onCancel: () => void;
}) {
  const [applyAll, setApplyAll] = useState(true);
  const [idx, setIdx] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, ConflictDecision>>({});
  const { conflicts, itemCount } = state;
  const n = conflicts.length;
  const cur = conflicts[Math.min(idx, n - 1)]!;

  const choose = (choice: ConflictDecision) => {
    const next = { ...decisions };
    if (applyAll) {
      for (const c of conflicts.slice(idx)) next[c.name] = choice;
      return onResolve(next);
    }
    next[cur.name] = choice;
    if (idx + 1 < n) {
      setDecisions(next);
      setIdx(idx + 1);
      return;
    }
    onResolve(next);
  };

  const title =
    itemCount === 1
      ? `“${cur.name}” already exists in ${state.destLabel}.`
      : `${n} of ${itemCount} items already exist in ${state.destLabel}.`;
  const sub = applyAll
    ? itemCount > n
      ? `The other ${itemCount - n} will be copied as usual.`
      : 'Choose what to do with them.'
    : 'Choose what to do with each one.';
  const keepHint = `Keep both saves the incoming copy as “${(applyAll ? conflicts[idx] : cur)?.keepBothName}”${applyAll && n - idx > 1 ? ', and so on' : ''}.`;

  return (
    <Modal onDismiss={onCancel}>
      <div
        className="dialog padded conflict"
        role="dialog"
        aria-modal="true"
        aria-label="File conflicts"
      >
        <div className="dlg-head">
          <div className="tile amber">
            <Icon name="difference" />
          </div>
          <div>
            <h2>{title}</h2>
            <div className="dlg-sub">{sub}</div>
          </div>
        </div>
        {applyAll ? (
          <div className="conflict-list">
            {conflicts.slice(idx).map((c) => (
              <div className="conflict-item" key={c.name}>
                <Icon
                  name={iconFor(c.name, c.incoming.isDir)}
                  fill={c.incoming.isDir}
                  className={c.incoming.isDir ? 'folder-icon' : ''}
                />
                <span className="name">{c.name}</span>
                <span className="meta">{metaText(c.incoming.isDir, c.incoming.size)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="stepper">
            <div className="count">
              Conflict {idx + 1} of {n}
            </div>
            <div className="cur">
              <Icon
                name={iconFor(cur.name, cur.incoming.isDir)}
                fill={cur.incoming.isDir}
                className={cur.incoming.isDir ? 'folder-icon' : ''}
              />
              <span className="name">{cur.name}</span>
            </div>
            <div className="sides">
              <SideCard
                label={state.existingLabel}
                size={metaText(cur.existing.isDir, cur.existing.size)}
                date={fmtDate(cur.existing.mtimeMs, now)}
                newer={cur.existing.mtimeMs > cur.incoming.mtimeMs}
              />
              <SideCard
                label={state.incomingLabel}
                size={metaText(cur.incoming.isDir, cur.incoming.size)}
                date={fmtDate(cur.incoming.mtimeMs, now)}
                newer={cur.incoming.mtimeMs > cur.existing.mtimeMs}
              />
            </div>
          </div>
        )}
        <div className="hint">{keepHint}</div>
        <label className="check">
          <input type="checkbox" checked={applyAll} onChange={() => setApplyAll(!applyAll)} />
          Apply to all conflicts in this batch
        </label>
        <div className="conflict-actions">
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <div className="spacer" />
          <button className="btn" onClick={() => choose('skip')}>
            Skip
          </button>
          <button className="btn" onClick={() => choose('keep')}>
            Keep both
          </button>
          <button className="btn primary" onClick={() => choose('replace')}>
            Replace
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SideCard({
  label,
  size,
  date,
  newer,
}: {
  label: string;
  size: string;
  date: string;
  newer: boolean;
}) {
  return (
    <div className="side-card">
      <div className="lbl">
        <span>{label}</span>
        {newer ? <span className="newer">Newer</span> : null}
      </div>
      <div className="size">{size}</div>
      <div className="date">{date}</div>
    </div>
  );
}

// ------------------------------------------------------------ confirm

export interface ConfirmSpec {
  title: string;
  body: string;
  danger: boolean;
  icon: string;
  tone: 'red' | 'amber' | 'neutral';
  confirm: string;
  cancel: string;
  destructiveButton: boolean;
}

export function ConfirmModal({
  spec,
  busy,
  onConfirm,
  onCancel,
}: {
  spec: ConfirmSpec;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal onDismiss={onCancel} dismissable={false}>
      <div
        className="dialog padded confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label={spec.title}
      >
        <div className="dlg-head">
          <div className={`tile ${spec.tone}`}>
            <Icon name={spec.icon} />
          </div>
          <div>
            <h2>{spec.title}</h2>
            <div className={`body${spec.danger ? ' danger' : ''}`}>{spec.body}</div>
          </div>
        </div>
        <div className="row-end">
          {/* Destructive dialogs focus Cancel so a stray Enter can't delete or disconnect. */}
          <button className="btn" onClick={onCancel} autoFocus={spec.destructiveButton}>
            {spec.cancel}
          </button>
          <button
            className={`btn ${spec.destructiveButton ? 'danger' : 'primary'}`}
            onClick={onConfirm}
            disabled={busy}
            autoFocus={!spec.destructiveButton}
          >
            {busy ? <Spinner /> : null}
            {spec.confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ downloads folder

export function DownloadsModal({
  current,
  revealLabel,
  onSave,
  onCancel,
}: {
  current: string;
  revealLabel: string;
  onSave: (dir: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [dir, setDir] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const value = dir.trim();
    if (!value.startsWith('/')) return setError('Enter a full path, starting with “/”.');
    setError(null);
    setSaving(true);
    try {
      await onSave(value);
    } catch (e) {
      // The server checks the folder exists; its message says what's wrong.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal onDismiss={onCancel}>
      <div
        className="dialog padded downloads"
        role="dialog"
        aria-modal="true"
        aria-label="Downloads folder"
      >
        <h2>Downloads folder</h2>
        <div className="dlg-sub">
          {revealLabel} copies items from the phone into this folder on this computer, then shows
          them there.
        </div>
        <label className="field">
          Folder
          <input
            className={error ? 'invalid' : ''}
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
            spellCheck={false}
            autoFocus
          />
        </label>
        {error ? (
          <div className="alert" role="alert">
            <Icon name="error" fill />
            <span>{error}</span>
          </div>
        ) : null}
        <div className="row-end">
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={() => void save()}
            disabled={saving || !dir.trim()}
          >
            {saving ? <Spinner /> : null}
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
