import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import type {
  ApiError,
  FileEntry,
  OfflineVolume,
  SessionSnapshot,
  Side,
  StorageInfo,
} from '../../shared/protocol.ts';
import { ANDROID_ROOT, ANDROID_SHORTCUTS, MAC_SHORTCUTS } from '../../shared/protocol.ts';
import { api, errorMessage, isAbort, RequestError } from '../api.ts';
import { captureDrop, isFinderDrag, type CapturedDrop } from '../finder.ts';
import { beginPaneDrag, filePathReader, isDropInPlace, type DragInfo } from '../desktop.ts';
import { batteryIcon, fmtBytes, fmtDate, iconFor, LOW_BATTERY } from '../format.ts';
import {
  activeShortcut,
  crumbsFor,
  folderLabel,
  isAtRoot,
  joinPath,
  parentOf,
  sortEntries,
  validateName,
  type SortSpec,
} from '../paths.ts';
import { Icon, MenuList, Spinner, useNow, type MenuEntry } from './ui.tsx';
import { useNarrow } from '../layout.ts';
import { offlineBannerText, offlineVolumeFor, remapPath, volumeNameFromPath } from '../volumes.ts';

export interface OverInfo {
  side: Side;
  folder: string | null;
  ok: boolean;
  /** The drag comes from Finder, not from the other pane. */
  finder: boolean;
}

export interface PaneProps {
  side: Side;
  active: boolean;
  onActivate: () => void;
  session: SessionSnapshot;
  home: string;
  macStorage: StorageInfo | null;
  /** Bumped by the server's fsChanged events, keyed by folder. */
  fsVersions: Record<string, number>;
  listEpoch: number;
  /** Network volumes that stopped answering; a Mac pane inside one shows a banner. */
  offlineVolumes: OfflineVolume[];
  /** Latest remount; a Mac pane under `from` follows the volume to `to`. */
  volumeMove: { from: string; to: string; n: number } | null;
  drag: DragInfo | null;
  over: OverInfo | null;
  setDrag: (d: DragInfo | null) => void;
  setOver: (o: OverInfo | null) => void;
  /** The other pane's current folder, or null if it has none (no device). */
  otherDir: string | null;
  onPathChange: (side: Side, path: string) => void;
  onTransfer: (from: Side, srcPaths: string[], destDir: string) => void;
  onFinderDrop: (side: Side, destDir: string, drop: CapturedDrop) => void;
  /** Mac: reveal in place. Android: copy to the downloads folder, then reveal. */
  onReveal: (side: Side, paths: string[]) => void;
  /** "Show in Finder" or "Show in Files" for the Mac pane. */
  revealLabel: string;
  /** The phone pane's reveal, which downloads first: "Download & Show in Finder". */
  downloadRevealLabel: string;
  onDeleteRequest: (side: Side, dir: string, names: string[]) => void;
  onToast: (text: string, kind?: 'ok' | 'error') => void;
  onStartSession: () => void;
  onOpenPair: () => void;
  onReconnect: () => void;
  onStartNewSession: () => void;
  startDisabled: boolean;
}

type Edit = { isNew: true } | { isNew: false; name: string } | null;

interface Listing {
  key: string;
  entries: FileEntry[] | null;
  error: string | null;
  errorCode: ApiError['code'] | null;
}

function useListing(
  side: Side,
  path: string,
  enabled: boolean,
  /** Identifies whose files `path` refers to (the device serial on Android). */
  scope: string,
  version: string,
  tick: number,
): Listing {
  const [listing, setListing] = useState<Listing>({
    key: '',
    entries: null,
    error: null,
    errorCode: null,
  });
  useEffect(() => {
    if (!enabled) return;
    const ac = new AbortController();
    api.list(side, path, ac.signal).then(
      (r) =>
        setListing({ key: `${scope}:${path}`, entries: r.entries, error: null, errorCode: null }),
      (err: unknown) => {
        if (!isAbort(err)) {
          setListing({
            key: `${scope}:${path}`,
            entries: null,
            error: errorMessage(err),
            errorCode: err instanceof RequestError ? (err.code ?? null) : null,
          });
        }
      },
    );
    return () => ac.abort();
  }, [side, path, enabled, scope, version, tick]);
  return listing;
}

const TRANSPORT_LABEL = { wifi: 'WiFi', usb: 'USB', emulator: 'Emulator' } as const;

export function Pane(props: PaneProps) {
  const { side, session, home, drag, over } = props;
  const isA = side === 'android';
  const st = session.state;
  const live = !isA || st === 'connected' || st === 'reconnecting' || st === 'lost';
  const connected = st === 'connected';
  const trouble = isA && (st === 'reconnecting' || st === 'lost');
  const device = session.device;

  const [path, setPath] = useState(isA ? ANDROID_ROOT : home);
  const [back, setBack] = useState<string[]>([]);
  const [sel, setSel] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sort, setSort] = useState<SortSpec>(
    isA ? { key: 'mtime', asc: false } : { key: 'name', asc: true },
  );
  const [hidden, setHidden] = useState(false);
  const [edit, setEdit] = useState<Edit>(null);
  const [spin, setSpin] = useState(0);
  const [tick, setTick] = useState(0);
  const [ctx, setCtx] = useState<{ x: number; y: number; onRow: boolean } | null>(null);

  const listRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<string | null>(null);
  const committingRef = useRef(false);

  const narrow = useNarrow();
  const now = useNow(60_000);

  // A listing belongs to one device: after switching phones, the old phone's files at the
  // same path must not be shown while the new listing loads.
  const scope = isA ? (device?.serial ?? '') : 'mac';
  const version = `${props.fsVersions[`${side}:${path}`] ?? 0}:${props.listEpoch}`;
  const listing = useListing(side, path, live, scope, version, tick);
  const listingKey = `${scope}:${path}`;
  const entries = listing.key === listingKey ? listing.entries : null;
  const loadError = listing.key === listingKey ? listing.error : null;
  const loadErrorCode = listing.key === listingKey ? listing.errorCode : null;
  // The OFFLINE error can arrive before the `volumes` event that names the share.
  const offlineVolume = isA ? null : offlineVolumeFor(path, props.offlineVolumes);
  const offlineName =
    offlineVolume?.name ?? (loadErrorCode === 'OFFLINE' ? volumeNameFromPath(path) : null);

  // A share that reconnects at a new mount point (Share to Share-1) keeps this pane, and
  // its back history, on the same folder instead of a dead path. Applied during render, keyed
  // by the move's counter, so each move is applied exactly once.
  const move = props.volumeMove;
  const [appliedMove, setAppliedMove] = useState(move?.n ?? 0);
  if (!isA && move && move.n !== appliedMove) {
    setAppliedMove(move.n);
    setPath(remapPath(path, move.from, move.to));
    setBack(back.map((p) => remapPath(p, move.from, move.to)));
  }

  const { onPathChange } = props;
  useEffect(() => {
    onPathChange(side, path);
  }, [onPathChange, side, path]);

  const rows = useMemo(
    () => (entries ? sortEntries(entries, sort, hidden) : []),
    [entries, sort, hidden],
  );
  const names = useMemo(() => rows.map((r) => r.name), [rows]);
  const byName = useMemo(() => new Map(rows.map((r) => [r.name, r])), [rows]);
  // Selection survives refreshes only for names that still exist.
  const selected = useMemo(() => sel.filter((n) => byName.has(n)), [sel, byName]);

  // ------------------------------------------------------------ navigation

  const navigate = (to: string, pushHistory = true) => {
    if (to === path) return;
    if (pushHistory) setBack((b) => [...b, path]);
    setPath(to);
    setSel([]);
    setAnchor(null);
    setCursor(null);
    setEdit(null);
    if (listRef.current) listRef.current.scrollTop = 0;
  };
  const goUp = () => {
    if (!isAtRoot(side, path)) navigate(parentOf(path));
  };
  const goBack = () => {
    const prev = back[back.length - 1];
    if (prev === undefined) return;
    setBack(back.slice(0, -1));
    navigate(prev, false);
  };
  const openSelected = () => {
    if (selected.length !== 1) return;
    const e = byName.get(selected[0]!);
    if (e?.isDir) navigate(joinPath(path, e.name));
  };
  const refresh = () => {
    setSpin((s) => s + 1);
    setTick((t) => t + 1);
  };

  const select = (list: string[], anc: string | null, cur: string | null) => {
    setSel(list);
    setAnchor(anc);
    setCursor(cur);
  };

  // ------------------------------------------------------------ actions

  const canModify = !isA || connected;

  const send = () => {
    if (!selected.length) return;
    if (!connected) return props.onToast('Connect a device first.');
    if (props.otherDir === null) return props.onToast('Connect a device first.');
    props.onTransfer(
      side,
      selected.map((n) => joinPath(path, n)),
      props.otherDir,
    );
  };
  const revealText = isA ? props.downloadRevealLabel : props.revealLabel;
  const reveal = () => {
    if (!selected.length) return;
    if (isA && !connected) return props.onToast('Connect a device first.');
    props.onReveal(
      side,
      selected.map((n) => joinPath(path, n)),
    );
  };
  const requestDelete = () => {
    if (!selected.length || !canModify) return;
    props.onDeleteRequest(side, path, selected);
  };
  const startNewFolder = () => {
    if (!canModify) return;
    setEdit({ isNew: true });
    setSel([]);
    if (listRef.current) listRef.current.scrollTop = 0;
  };
  const startRename = (name?: string) => {
    if (!canModify) return;
    const target = name ?? (selected.length === 1 ? selected[0] : undefined);
    if (!target) return;
    setEdit({ isNew: false, name: target });
    select([target], target, target);
  };
  const focusList = () => setTimeout(() => listRef.current?.focus(), 0);
  const cancelEdit = () => {
    setEdit(null);
    focusList();
  };
  const commitEdit = async (raw: string) => {
    if (!edit || committingRef.current) return;
    const name = raw.trim();
    if (!name || (!edit.isNew && name === edit.name)) return cancelEdit();
    const err = validateName(
      name,
      names.filter((n) => edit.isNew || n !== edit.name),
    );
    if (err) {
      props.onToast(err);
      return cancelEdit();
    }
    committingRef.current = true;
    try {
      if (edit.isNew) await api.mkdir(side, joinPath(path, name));
      else await api.rename(side, joinPath(path, edit.name), name);
      setEdit(null);
      select([name], name, name);
      setTick((t) => t + 1);
      focusList();
    } catch (e) {
      props.onToast(errorMessage(e));
      cancelEdit();
    } finally {
      committingRef.current = false;
    }
  };

  // ------------------------------------------------------------ mouse

  const rowMouseDown = (name: string, e: MouseEvent) => {
    if (e.button !== 0) return;
    props.onActivate();
    pendingRef.current = null;
    if (e.metaKey || e.ctrlKey) {
      select(
        selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name],
        name,
        name,
      );
    } else if (e.shiftKey && anchor && names.includes(anchor)) {
      const a = names.indexOf(anchor);
      const b = names.indexOf(name);
      setSel(names.slice(Math.min(a, b), Math.max(a, b) + 1));
      setCursor(name);
    } else if (!selected.includes(name)) {
      select([name], name, name);
    } else {
      // Clicking inside an existing selection may start a drag of all of it;
      // collapse to this row only if the click completes without dragging.
      pendingRef.current = name;
    }
  };
  const rowClick = (name: string, e: MouseEvent) => {
    if (pendingRef.current === name && !e.metaKey && !e.shiftKey && !e.ctrlKey)
      select([name], name, name);
    pendingRef.current = null;
  };
  const rowContext = (name: string, e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    props.onActivate();
    if (!selected.includes(name)) select([name], name, name);
    setCtx({ x: e.clientX, y: e.clientY, onRow: true });
  };
  const bgContext = (e: MouseEvent) => {
    e.preventDefault();
    props.onActivate();
    setSel([]);
    setCtx({ x: e.clientX, y: e.clientY, onRow: false });
  };

  // ------------------------------------------------------------ keyboard

  const scrollToName = (name: string) => {
    const el = listRef.current?.querySelector(`[data-name="${CSS.escape(name)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  };
  const onKey = (e: KeyboardEvent) => {
    if (edit) return;
    const meta = e.metaKey || e.ctrlKey;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      if (meta) return k === 'ArrowUp' ? goUp() : openSelected();
      if (!names.length) return;
      const cur = cursor ?? selected[selected.length - 1] ?? null;
      let i = cur ? names.indexOf(cur) : -1;
      i = k === 'ArrowDown' ? Math.min(names.length - 1, i + 1) : Math.max(0, i < 0 ? 0 : i - 1);
      const n = names[i]!;
      if (e.shiftKey && anchor && names.includes(anchor)) {
        const a = names.indexOf(anchor);
        setSel(names.slice(Math.min(a, i), Math.max(a, i) + 1));
        setCursor(n);
      } else select([n], n, n);
      scrollToName(n);
    } else if (k === 'Enter') {
      e.preventDefault();
      openSelected();
    } else if (k === 'Backspace') {
      e.preventDefault();
      if (meta) requestDelete();
      else goUp();
    } else if (k === 'Delete') {
      e.preventDefault();
      requestDelete();
    } else if (k === 'F2') {
      e.preventDefault();
      startRename();
    } else if (meta && k.toLowerCase() === 'a') {
      e.preventDefault();
      setSel(names);
    } else if (meta && k === 'ArrowRight' && isA) {
      e.preventDefault();
      send();
    } else if (meta && k === 'ArrowLeft' && !isA) {
      e.preventDefault();
      send();
    }
  };

  // ------------------------------------------------------------ drag and drop

  const validTarget = drag !== null && drag.from !== side && connected;
  // Finder drops onto the Mac pane are Mac-to-Mac copies and need no device.
  const finderOk = !isA || connected;
  const fromFinder = (e: DragEvent) => !drag && isFinderDrag(Array.from(e.dataTransfer.types));

  const dragStart = (name: string, e: DragEvent) => {
    const list = selected.includes(name) ? selected : [name];
    if (!selected.includes(name)) select([name], name, name);
    pendingRef.current = null;
    if (!beginPaneDrag({ from: side, dir: path, names: list }, e, props.setDrag)) return;
    const g = ghostRef.current;
    if (g) {
      const label = g.querySelector('[data-c]');
      if (label) label.textContent = list.length === 1 ? name : `${list.length} items`;
      e.dataTransfer.setDragImage(g, 14, 14);
    }
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.setData('text/plain', list.join('\n'));
  };
  const sameOver = (o: OverInfo) =>
    over !== null &&
    over.side === o.side &&
    over.folder === o.folder &&
    over.ok === o.ok &&
    over.finder === o.finder;
  const setOver = (o: OverInfo) => {
    if (!sameOver(o)) props.setOver(o);
  };
  const paneDragOver = (e: DragEvent) => {
    if (fromFinder(e)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = finderOk ? 'copy' : 'none';
      setOver({ side, folder: null, ok: finderOk, finder: true });
      return;
    }
    if (!drag) return;
    if (validTarget) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setOver({ side, folder: null, ok: true, finder: false });
    } else {
      e.dataTransfer.dropEffect = 'none';
      setOver({ side, folder: null, ok: false, finder: false });
    }
  };
  const paneDragLeave = (e: DragEvent) => {
    const next = e.relatedTarget as Node | null;
    if (over?.side === side && (!next || !e.currentTarget.contains(next))) props.setOver(null);
  };
  const rowDragOver = (entry: FileEntry, e: DragEvent) => {
    const finder = fromFinder(e);
    if (entry.isDir && (finder ? finderOk : validTarget)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      setOver({ side, folder: entry.name, ok: true, finder });
    }
  };
  const dragEnd = () => {
    props.setDrag(null);
    props.setOver(null);
  };
  const notReady =
    st === 'idle' || st === 'connecting' || st === 'ending'
      ? 'Connect a device first'
      : 'Waiting for device';
  const drop = (e: DragEvent, folder: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (fromFinder(e)) {
      const captured = captureDrop(e.dataTransfer, filePathReader());
      dragEnd();
      if (!finderOk) return props.onToast(`${notReady}.`);
      if (!isA && captured.kind === 'paths' && isDropInPlace(captured.paths, path)) return;
      props.onFinderDrop(side, folder ? joinPath(path, folder) : path, captured);
      return;
    }
    const d = drag;
    dragEnd();
    if (!d || d.from === side || !connected) return;
    props.onTransfer(
      d.from,
      d.names.map((n) => joinPath(d.dir, n)),
      folder ? joinPath(path, folder) : path,
    );
  };

  const myOver = over && over.side === side ? over : null;
  let dropLabel: string | null = null;
  const target = myOver ? (myOver.folder ?? folderLabel(side, path, home)) : '';
  if (myOver?.finder) {
    dropLabel = myOver.ok ? `Copy from Finder to ${target}` : notReady;
  } else if (myOver && drag) {
    if (myOver.ok) {
      const n = drag.names.length;
      dropLabel = `Copy ${n === 1 ? '1 item' : `${n} items`} to ${target}`;
    } else if (drag.from === side) dropLabel = 'Can’t copy within the same pane';
    else dropLabel = notReady;
  }

  // ------------------------------------------------------------ context menu

  const ctxItems: MenuEntry[] = [];
  if (ctx) {
    const n = selected.length;
    const one = n === 1 ? byName.get(selected[0]!) : undefined;
    if (ctx.onRow) {
      if (one?.isDir) ctxItems.push({ id: 'open', label: 'Open', icon: 'folder_open', kbd: '⌘↓' });
      ctxItems.push(
        {
          id: 'send',
          label: isA ? 'Send to Mac' : 'Send to phone',
          icon: isA ? 'arrow_forward' : 'arrow_back',
          kbd: isA ? '⌘→' : '⌘←',
          disabled: !connected,
        },
        {
          id: 'reveal',
          label: revealText,
          icon: 'open_in_new',
          disabled: isA && !connected,
        },
        { kind: 'sep' },
      );
      if (n === 1)
        ctxItems.push({
          id: 'rename',
          label: 'Rename',
          icon: 'edit',
          kbd: 'F2',
          disabled: !canModify,
        });
      ctxItems.push(
        { id: 'newFolder', label: 'New folder', icon: 'create_new_folder', disabled: !canModify },
        { kind: 'sep' },
      );
      ctxItems.push(
        isA
          ? {
              id: 'delete',
              label: n > 1 ? `Delete ${n} items…` : 'Delete…',
              icon: 'delete',
              kbd: '⌘⌫',
              danger: true,
              disabled: !canModify,
            }
          : {
              id: 'delete',
              label: n > 1 ? `Move ${n} items to Trash` : 'Move to Trash',
              icon: 'delete',
              kbd: '⌘⌫',
            },
      );
    } else {
      ctxItems.push(
        { id: 'newFolder', label: 'New folder', icon: 'create_new_folder', disabled: !canModify },
        { id: 'refresh', label: 'Refresh', icon: 'refresh' },
        { kind: 'sep' },
        { id: 'hidden', label: 'Show hidden files', icon: hidden ? 'check' : '' },
      );
    }
  }
  const onCtxSelect = (id: string) => {
    if (id === 'open') openSelected();
    else if (id === 'send') send();
    else if (id === 'reveal') reveal();
    else if (id === 'rename') startRename();
    else if (id === 'newFolder') startNewFolder();
    else if (id === 'delete') requestDelete();
    else if (id === 'refresh') refresh();
    else if (id === 'hidden') setHidden(!hidden);
  };
  const ctxStyle = ctx
    ? {
        left: Math.min(ctx.x, window.innerWidth - 236),
        top: Math.min(ctx.y, window.innerHeight - ctxItems.length * 29 - 20),
      }
    : {};

  // ------------------------------------------------------------ header

  const battery = isA && live ? session.battery : null;
  const storage = isA ? (live ? session.storage : null) : props.macStorage;
  const lowBattery = battery !== null && battery.level < LOW_BATTERY;

  const shortcuts = isA
    ? ANDROID_SHORTCUTS.map((s) => ({ label: s.label, path: s.path, icon: s.icon }))
    : MAC_SHORTCUTS.map((s) => ({
        label: s.label,
        path: s.rel ? joinPath(home, s.rel) : home,
        icon: s.icon,
      }));
  const currentShortcut = activeShortcut(
    shortcuts.map((s) => s.path),
    path,
  );
  const crumbs = crumbsFor(side, path, home);

  const newFolderName = isA ? 'New folder' : 'untitled folder';

  return (
    <section
      className={`pane ${side}${props.active ? ' active' : ''}`}
      aria-label={isA ? 'Android device' : 'This Mac'}
      onDragOver={paneDragOver}
      onDragLeave={paneDragLeave}
      onDrop={(e) => drop(e, null)}
    >
      <div className="pane-topline" />
      {isA && st === 'reconnecting' && device ? (
        <div className="pane-banner warn" role="alert">
          <Spinner size={14} />
          <div className="text">
            <span>Reconnecting to {device.model}…</span>
            <span className="sub">Queued transfers will start when it’s back.</span>
          </div>
        </div>
      ) : null}
      {isA && st === 'lost' ? (
        <div className="pane-banner bad" role="alert">
          <Icon name="link_off" />
          <div className="text">
            <span>Lost connection to {device?.model ?? 'the device'}</span>
            <span className="sub">
              {session.error ?? 'Check that Wireless debugging is still on.'}
            </span>
          </div>
          <div className="actions">
            <button className="btn danger sm" onClick={props.onReconnect}>
              Reconnect
            </button>
            <button className="btn sm" onClick={props.onStartNewSession}>
              Start new session
            </button>
          </div>
        </div>
      ) : null}

      <div className={`pane-body${trouble ? ' dim' : ''}`}>
        <div className="pane-head">
          <div className={`glyph${isA ? (live ? ' live' : ' off') : ''}`}>
            <Icon
              name={
                isA
                  ? device?.transport === 'emulator'
                    ? 'developer_board'
                    : 'smartphone'
                  : 'laptop_mac'
              }
            />
          </div>
          <div className="pane-title">
            <div className="t">
              {isA ? (live && device ? device.model : 'Android') : 'This Mac'}
            </div>
            <div className="s">
              {isA
                ? live && device
                  ? `${device.androidVersion} · ${TRANSPORT_LABEL[device.transport]}`
                  : 'No device connected'
                : `macOS · ${home}`}
            </div>
          </div>
          {battery ? (
            <div
              className={`battery${lowBattery ? ' low' : ''}`}
              title={
                lowBattery
                  ? `Battery low (${battery.level}%)`
                  : battery.charging
                    ? `${battery.level}%, charging`
                    : `${battery.level}%`
              }
            >
              <Icon name={batteryIcon(battery.level)} />
              <span>{battery.level}%</span>
              {battery.charging ? (
                <span className="icon bolt" aria-label="Charging">
                  bolt
                </span>
              ) : null}
            </div>
          ) : null}
          {storage ? (
            <div className="storage">
              <div className="txt">
                <b>{fmtBytes(storage.freeBytes)}</b> free of {fmtBytes(storage.totalBytes)}
              </div>
              <div className="bar">
                <div
                  style={{
                    width: `${storage.totalBytes ? ((1 - storage.freeBytes / storage.totalBytes) * 100).toFixed(1) : 0}%`,
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>

        {!live ? (
          <div className="empty-device">
            <div className="inner">
              <div className="tile">
                <Icon name="phonelink" />
              </div>
              <h2>No device connected</h2>
              <p>
                Turn on Wireless debugging on your phone, make sure it’s on the same WiFi as this
                Mac, then start a session.
              </p>
              <button
                className="btn primary"
                onClick={props.onStartSession}
                disabled={props.startDisabled || st === 'connecting'}
              >
                {st === 'connecting' ? <Spinner /> : null}
                {st === 'connecting' ? 'Connecting…' : 'Start Session'}
              </button>
              <button
                className="btn link"
                onClick={props.onOpenPair}
                disabled={props.startDisabled}
              >
                Pair a new device
              </button>
            </div>
          </div>
        ) : (
          <>
            <div
              className="toolbar"
              role="toolbar"
              aria-label={isA ? 'Android toolbar' : 'Mac toolbar'}
            >
              <button
                className="icon-btn"
                aria-label="Back"
                title="Back"
                onClick={goBack}
                disabled={!back.length}
              >
                <Icon name="arrow_back" />
              </button>
              <button
                className="icon-btn"
                aria-label="Enclosing folder"
                title="Enclosing folder (⌘↑)"
                onClick={goUp}
                disabled={isAtRoot(side, path)}
              >
                <Icon name="arrow_upward" />
              </button>
              <nav className="crumbs" aria-label="Path">
                {crumbs.map((c, i) => {
                  const last = i === crumbs.length - 1;
                  return (
                    <div key={c.path} className={`crumb${last ? ' last' : ''}`}>
                      <button
                        onClick={() => navigate(c.path)}
                        aria-current={last ? 'page' : undefined}
                        title={c.path}
                      >
                        {c.label}
                      </button>
                      {!last ? <Icon name="chevron_right" /> : null}
                    </div>
                  );
                })}
              </nav>
              <button
                className="icon-btn"
                aria-label="New folder"
                title="New folder"
                onClick={startNewFolder}
                disabled={!canModify}
              >
                <Icon name="create_new_folder" />
              </button>
              <button className="icon-btn" aria-label="Refresh" title="Refresh" onClick={refresh}>
                <span
                  className="icon"
                  aria-hidden="true"
                  style={{
                    transform: `rotate(${spin * 360}deg)`,
                    transition: 'transform .6s ease',
                  }}
                >
                  refresh
                </span>
              </button>
              <button
                className={`icon-btn${hidden ? ' on' : ''}`}
                aria-label="Show hidden files"
                aria-pressed={hidden}
                title="Show hidden files"
                onClick={() => setHidden(!hidden)}
              >
                <Icon name={hidden ? 'visibility' : 'visibility_off'} />
              </button>
              <button
                className="icon-btn"
                aria-label={revealText}
                title={
                  isA
                    ? `${revealText}: copy the selection to the downloads folder, then show it`
                    : revealText
                }
                onClick={reveal}
                disabled={!selected.length || (isA && !connected)}
              >
                <Icon name="open_in_new" />
              </button>
              <div className="divider" />
              <button
                className={`send-btn${isA ? '' : ' rev'}`}
                onClick={send}
                disabled={!selected.length || !connected}
                title={isA ? 'Send selection to Mac (⌘→)' : 'Send selection to phone (⌘←)'}
              >
                <span className="long">{isA ? 'Send to Mac' : 'Send to phone'}</span>
                <span className="short">{isA ? 'To Mac' : 'To phone'}</span>
                <Icon name={isA ? 'arrow_forward' : 'arrow_back'} />
              </button>
            </div>

            <div className="pane-main">
              <nav className="shortcuts" aria-label="Shortcuts">
                <div className="title">{isA ? 'On the phone' : 'On this Mac'}</div>
                {shortcuts.map((s) => (
                  <button
                    key={s.path}
                    className={`shortcut${s.path === currentShortcut ? ' on' : ''}`}
                    title={s.label}
                    aria-current={s.path === currentShortcut ? 'location' : undefined}
                    onClick={() => navigate(s.path)}
                  >
                    <Icon name={s.icon} />
                    <span className="label">{s.label}</span>
                  </button>
                ))}
              </nav>

              <div
                className={`listwrap${myOver && !myOver.folder ? (myOver.ok ? ' drop-ok' : ' drop-no') : ''}`}
              >
                <div className="cols" role="row">
                  {(
                    [
                      ['Name', 'name', false],
                      ['Size', 'size', true],
                      ['Modified', 'mtime', false],
                    ] as const
                  ).map(([label, key, end]) => {
                    const on = sort.key === key;
                    return (
                      <button
                        key={key}
                        role="columnheader"
                        aria-sort={on ? (sort.asc ? 'ascending' : 'descending') : 'none'}
                        className={`colhead${on ? ' on' : ''}${end ? ' end' : ''}`}
                        onClick={() =>
                          setSort(on ? { key, asc: !sort.asc } : { key, asc: key === 'name' })
                        }
                      >
                        {label}
                        <Icon name={on ? (sort.asc ? 'arrow_upward' : 'arrow_downward') : ''} />
                      </button>
                    );
                  })}
                </div>
                <div
                  ref={listRef}
                  className="list"
                  role="grid"
                  aria-multiselectable="true"
                  aria-label={isA ? 'Files on Android device' : 'Files on this Mac'}
                  tabIndex={0}
                  onKeyDown={onKey}
                  onFocus={props.onActivate}
                  onMouseDown={(e) => {
                    if (e.target === e.currentTarget) {
                      setSel([]);
                      props.onActivate();
                    }
                  }}
                  onContextMenu={bgContext}
                >
                  {edit?.isNew ? (
                    <div className="row new">
                      <div className="row-name">
                        <Icon name="folder" fill className="folder-icon" />
                        <EditInput
                          initial={newFolderName}
                          selectBase={false}
                          label="New folder name"
                          onCommit={commitEdit}
                          onCancel={cancelEdit}
                        />
                      </div>
                      <div className="meta size">–</div>
                      <div className="meta">Now</div>
                    </div>
                  ) : null}
                  {rows.map((en, i) => {
                    const isSel = selected.includes(en.name);
                    const editing = edit !== null && !edit.isNew && edit.name === en.name;
                    const dropHere = myOver?.ok === true && myOver.folder === en.name;
                    const cls = [
                      'row',
                      i % 2 ? 'zebra' : '',
                      isSel ? 'sel' : '',
                      dropHere ? 'drop' : '',
                    ]
                      .filter(Boolean)
                      .join(' ');
                    return (
                      <div
                        key={en.name}
                        data-name={en.name}
                        className={cls}
                        role="row"
                        aria-selected={isSel}
                        draggable={!editing}
                        onMouseDown={(e) => rowMouseDown(en.name, e)}
                        onClick={(e) => rowClick(en.name, e)}
                        onDoubleClick={() => {
                          if (en.isDir) navigate(joinPath(path, en.name));
                        }}
                        onContextMenu={(e) => rowContext(en.name, e)}
                        onDragStart={(e) => dragStart(en.name, e)}
                        onDragOver={(e) => rowDragOver(en, e)}
                        onDrop={(e) => drop(e, en.isDir ? en.name : null)}
                        onDragEnd={dragEnd}
                      >
                        <div className={`row-name${en.name.startsWith('.') ? ' hidden-file' : ''}`}>
                          <Icon
                            name={iconFor(en.name, en.isDir)}
                            fill={en.isDir}
                            className={en.isDir ? 'folder-icon' : ''}
                          />
                          {editing ? (
                            <EditInput
                              initial={en.name}
                              selectBase={!en.isDir}
                              label="Rename"
                              onCommit={commitEdit}
                              onCancel={cancelEdit}
                            />
                          ) : (
                            <span
                              className="name"
                              onDoubleClick={(e) => {
                                if (!en.isDir) {
                                  e.stopPropagation();
                                  startRename(en.name);
                                }
                              }}
                            >
                              {en.name}
                            </span>
                          )}
                        </div>
                        <div className="meta size">{en.isDir ? '–' : fmtBytes(en.size)}</div>
                        <div className="meta">{fmtDate(en.mtimeMs, now, narrow)}</div>
                      </div>
                    );
                  })}
                  {offlineName ? (
                    <div className="list-note offline" role="status">
                      <Icon name="cloud_off" />
                      {offlineBannerText(offlineName)}
                    </div>
                  ) : loadError ? (
                    <div className="list-note error">Can’t open this folder. {loadError}</div>
                  ) : null}
                  {!loadError && !offlineName && entries === null ? (
                    <div className="list-note">
                      <Spinner size={14} />
                    </div>
                  ) : null}
                  {entries !== null && !rows.length && !edit?.isNew ? (
                    <div className="list-note">This folder is empty</div>
                  ) : null}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {dropLabel ? (
        <div className={`drop-pill${myOver?.ok ? ' ok' : ''}`}>
          <Icon name={myOver?.ok ? 'download' : 'block'} />
          {dropLabel}
        </div>
      ) : null}

      <div ref={ghostRef} className="drag-ghost" aria-hidden="true">
        <Icon name="file_copy" />
        <span data-c="">1 item</span>
      </div>

      {ctx ? (
        <MenuList
          items={ctxItems}
          style={ctxStyle}
          width={224}
          onClose={() => setCtx(null)}
          onSelect={onCtxSelect}
        />
      ) : null}
    </section>
  );
}

function EditInput({
  initial,
  selectBase,
  label,
  onCommit,
  onCancel,
}: {
  initial: string;
  selectBase: boolean;
  label: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, selectBase && dot > 0 ? dot : initial.length);
  }, [initial, selectBase]);
  return (
    <input
      ref={ref}
      className="edit-input"
      aria-label={label}
      defaultValue={initial}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          doneRef.current = true;
          onCommit(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          doneRef.current = true;
          onCancel();
        }
      }}
      onBlur={(e) => {
        if (!doneRef.current) onCommit(e.currentTarget.value);
      }}
    />
  );
}
