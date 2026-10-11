import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Candidate,
  ConflictDecision,
  PairCodeRequest,
  PlanResponse,
  Side,
} from '../shared/protocol.ts';
import { api, errorMessage } from './api.ts';
import { AdbMissing } from './components/AdbMissing.tsx';
import { AppBar, pillFor } from './components/AppBar.tsx';
import {
  ConfirmModal,
  ConflictModal,
  DevicePickerModal,
  DownloadsModal,
  PairModal,
  SearchingModal,
  SettingsModal,
  type ConfirmSpec,
  type ConflictState,
} from './components/modals.tsx';
import { Pane, type OverInfo } from './components/Pane.tsx';
import { TransferPanel } from './components/TransferPanel.tsx';
import { Icon, MenuList, Spinner, Toast, useNow, type ToastData } from './components/ui.tsx';
import { isNoTrash, noTrashConfirm } from './deletes.ts';
import { desktopBridge, fileChooser, type DragInfo } from './desktop.ts';
import { collectDrops, isFinderDrag, type CapturedDrop, type FinderDrop } from './finder.ts';
import { downloadRevealLabel, isActive, revealLabel } from './jobs.ts';
import { appMenuItems, type AppMenuAction } from './menu.ts';
import { folderLabel, joinPath } from './paths.ts';
import { usePrefs } from './prefs.ts';
import { getStoreState, startStore, useStore } from './store.ts';
import { runUploads } from './uploader.ts';

type ModalState =
  | { kind: 'searching' }
  | { kind: 'picker'; candidates: Candidate[]; connectingId: string | null }
  | { kind: 'pair'; tab: 'qr' | 'code' }
  | { kind: 'conflict'; state: ConflictState }
  | {
      kind: 'confirm';
      spec: ConfirmSpec;
      /** May hand back a follow-up modal (e.g. the permanent-delete confirm after NO_TRASH). */
      action: () => Promise<ModalState | void>;
      busy: boolean;
    }
  | { kind: 'settings' }
  | { kind: 'downloads' }
  | null;

startStore();

export function App() {
  const store = useStore();
  const prefs = usePrefs();
  const snap = store.snapshot;

  const [modal, setModal] = useState<ModalState>(null);
  const [toast, setToast] = useState<ToastData | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeSide, setActiveSide] = useState<Side>('mac');
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [over, setOver] = useState<OverInfo | null>(null);
  const [paths, setPaths] = useState<Record<Side, string | null>>({ android: null, mac: null });
  const [quit, setQuit] = useState(false);

  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Finder drops waiting on the conflict dialog, by batch id; uploads start at commit. */
  const pendingDrops = useRef(new Map<string, FinderDrop[]>());
  const startToken = useRef(0);
  const now = useNow(60_000);

  const showToast = useCallback((text: string, kind: 'ok' | 'error' = 'error') => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ id: Date.now(), text, kind });
    toastTimer.current = setTimeout(() => setToast(null), 4500);
  }, []);
  const fail = useCallback((e: unknown) => showToast(errorMessage(e)), [showToast]);

  const onPathChange = useCallback((side: Side, path: string) => {
    setPaths((p) => (p[side] === path ? p : { ...p, [side]: path }));
  }, []);

  const session = snap?.session ?? null;
  const pairing = snap?.pairing ?? null;
  const st = session?.state ?? 'idle';
  const live = st === 'connected' || st === 'reconnecting' || st === 'lost';
  const deviceName = session?.device?.model ?? 'the device';

  // Pairing hands off to connecting on the server; once connected, the modal has done its job.
  const pairDone = modal?.kind === 'pair' && pairing?.status === 'success' && st === 'connected';
  useEffect(() => {
    if (!pairDone) return;
    const id = setTimeout(() => setModal(null), 600);
    return () => clearTimeout(id);
  }, [pairDone]);

  // ------------------------------------------------------------ session

  const startQr = useCallback(() => {
    api.pairQr().catch(fail);
  }, [fail]);

  const openPair = () => {
    setMenuOpen(false);
    setModal({ kind: 'pair', tab: 'qr' });
    startQr();
  };

  const startSession = async () => {
    const token = ++startToken.current;
    setModal({ kind: 'searching' });
    try {
      const r = await api.startSession();
      if (token !== startToken.current) return;
      if (r.result === 'connected') setModal(null);
      else if (r.result === 'pick')
        setModal({ kind: 'picker', candidates: r.candidates, connectingId: null });
      else {
        setModal({ kind: 'pair', tab: 'qr' });
        startQr();
      }
    } catch (e) {
      if (token !== startToken.current) return;
      setModal(null);
      fail(e);
    }
  };

  const connect = async (id: string) => {
    setModal((m) => (m?.kind === 'picker' ? { ...m, connectingId: id } : m));
    try {
      await api.connect(id);
      setModal((m) => (m?.kind === 'picker' ? null : m));
    } catch (e) {
      setModal((m) => (m?.kind === 'picker' ? { ...m, connectingId: null } : m));
      fail(e);
    }
  };

  const doEnd = () => api.endSession().then(() => undefined);

  const endSession = () => {
    const active = (snap?.jobs ?? []).filter(isActive).length;
    if (!active) {
      doEnd().catch(fail);
      return;
    }
    setModal({
      kind: 'confirm',
      busy: false,
      spec: {
        title: 'End session?',
        body: `${active} transfer${active === 1 ? '' : 's'} in progress will be cancelled. ${deviceName} will be disconnected.`,
        danger: false,
        icon: 'link_off',
        tone: 'amber',
        confirm: 'End session',
        cancel: 'Keep transferring',
        destructiveButton: true,
      },
      action: doEnd,
    });
  };

  const reconnect = () => {
    api.reconnect().catch(fail);
  };
  // Start Session clears the lost session itself, keeping transfers that don't need the
  // phone (Finder drops on the Mac pane); End Session here would cancel those too.
  const startNewSession = () => startSession();

  // ------------------------------------------------------------ pairing modal

  const closeModal = () => {
    if (modal?.kind === 'searching') startToken.current++;
    if (modal?.kind === 'conflict') pendingDrops.current.delete(modal.state.batchId);
    if (modal?.kind === 'pair' && pairing && pairing.status !== 'success')
      api.pairCancel().catch(() => undefined);
    if (modal?.kind === 'confirm' && modal.busy) return;
    setModal(null);
  };

  const setPairTab = (tab: 'qr' | 'code') => {
    if (modal?.kind !== 'pair' || modal.tab === tab) return;
    setModal({ kind: 'pair', tab });
    if (tab === 'code') {
      if (pairing?.mode === 'qr' && pairing.status === 'waiting')
        api.pairCancel().catch(() => undefined);
    } else if (!(pairing?.mode === 'qr' && pairing.status === 'waiting')) {
      startQr();
    }
  };

  const submitCode = async (req: PairCodeRequest) => {
    try {
      await api.pairCode(req);
    } catch (e) {
      fail(e);
    }
  };

  // ------------------------------------------------------------ transfers

  const sideName = (side: Side) => (side === 'android' ? deviceName : 'This Mac');

  const startUploads = (drops: FinderDrop[], uploads: { name: string; jobId: string }[]) => {
    const byName = new Map(drops.map((d) => [d.item.name, d]));
    const tasks = uploads.flatMap((u) => {
      const drop = byName.get(u.name);
      return drop ? [{ jobId: u.jobId, drop }] : [];
    });
    void runUploads(tasks, {
      fetch: (input, init) => fetch(input, init),
      jobStatus: (id) => getStoreState().snapshot?.jobs.find((j) => j.id === id)?.status,
    });
  };

  const commitBatch = async (batchId: string, decisions: Record<string, ConflictDecision>) => {
    const drops = pendingDrops.current.get(batchId);
    pendingDrops.current.delete(batchId);
    const r = await api.commit({ batchId, decisions });
    if (drops) startUploads(drops, r.uploads);
  };

  const requestFinderDrop = async (to: Side, destDir: string, captured: CapturedDrop) => {
    try {
      let plan: PlanResponse;
      if (captured.kind === 'paths') {
        // The desktop app copies straight from the dropped paths; nothing is uploaded.
        plan = await api.plan({ from: 'paths', destSide: to, destDir, srcPaths: captured.paths });
      } else {
        const drops = await collectDrops(captured.sources);
        if (!drops.length) return showToast('Nothing to copy.');
        plan = await api.plan({
          from: 'finder',
          destSide: to,
          destDir,
          items: drops.map((d) => d.item),
        });
        pendingDrops.current.set(plan.batchId, drops);
      }
      if (!plan.conflicts.length) return await commitBatch(plan.batchId, {});
      setModal({
        kind: 'conflict',
        state: {
          batchId: plan.batchId,
          destLabel: folderLabel(to, destDir, snap?.mac.home ?? ''),
          itemCount: plan.itemCount,
          conflicts: plan.conflicts,
          existingLabel: `On ${sideName(to)}`,
          incomingLabel: 'From Finder',
        },
      });
    } catch (e) {
      fail(e);
    }
  };

  const requestTransfer = async (
    from: Side,
    srcPaths: string[],
    destDir: string,
    reveal = false,
  ) => {
    if (!srcPaths.length) return;
    const to: Side = from === 'android' ? 'mac' : 'android';
    try {
      const plan = await api.plan({ from, srcPaths, destDir, ...(reveal ? { reveal } : {}) });
      if (!plan.conflicts.length) {
        await api.commit({ batchId: plan.batchId, decisions: {} });
        return;
      }
      setModal({
        kind: 'conflict',
        state: {
          batchId: plan.batchId,
          destLabel: folderLabel(to, destDir, snap?.mac.home ?? ''),
          itemCount: plan.itemCount,
          conflicts: plan.conflicts,
          existingLabel: `On ${sideName(to)}`,
          incomingLabel: `From ${sideName(from)}`,
        },
      });
    } catch (e) {
      fail(e);
    }
  };

  const resolveConflicts = async (batchId: string, decisions: Record<string, ConflictDecision>) => {
    setModal(null);
    try {
      await commitBatch(batchId, decisions);
    } catch (e) {
      fail(e);
    }
  };

  const requestReveal = (side: Side, paths: string[]) => {
    if (!paths.length) return;
    if (side === 'mac') {
      api.reveal(paths).catch(fail);
      return;
    }
    const dir = snap?.settings.downloadsDir;
    if (!dir) return showToast('Set a downloads folder first.');
    void requestTransfer('android', paths, dir, true);
  };

  // ------------------------------------------------------------ delete

  const requestDelete = (side: Side, dir: string, names: string[]) => {
    const what = names.length === 1 ? `“${names[0]}”` : `${names.length} items`;
    const android = side === 'android';
    setModal({
      kind: 'confirm',
      busy: false,
      spec: android
        ? {
            title: `Permanently delete ${what} from ${deviceName}?`,
            body: 'This cannot be undone. Android has no Trash for files deleted over adb.',
            danger: true,
            icon: 'delete_forever',
            tone: 'red',
            confirm: 'Delete permanently',
            cancel: 'Cancel',
            destructiveButton: true,
          }
        : {
            title: `Move ${what} to Trash?`,
            body: 'You can restore them from the Trash in Finder.',
            danger: false,
            icon: 'delete',
            tone: 'neutral',
            confirm: 'Move to Trash',
            cancel: 'Cancel',
            destructiveButton: false,
          },
      action: async (): Promise<ModalState | void> => {
        const paths = names.map((n) => joinPath(dir, n));
        try {
          await api.remove(side, paths);
        } catch (e) {
          if (android || !isNoTrash(e)) throw e;
          return {
            kind: 'confirm',
            busy: false,
            spec: noTrashConfirm(what),
            action: async () => {
              await api.remove(side, paths, true);
              showToast(`Deleted ${what}.`, 'ok');
            },
          };
        }
        showToast(
          android ? `Deleted ${what} from ${deviceName}.` : `Moved ${what} to Trash.`,
          'ok',
        );
      },
    });
  };

  const runConfirm = async () => {
    if (modal?.kind !== 'confirm' || modal.busy) return;
    const { action } = modal;
    setModal({ ...modal, busy: true });
    try {
      setModal((await action()) ?? null);
    } catch (e) {
      setModal(null);
      fail(e);
    }
  };

  // Dropping a file anywhere the panes don't handle would make the browser open it and
  // leave the app.
  useEffect(() => {
    const guard = (e: globalThis.DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer) return;
      if (!isFinderDrag(Array.from(e.dataTransfer.types))) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'none';
    };
    window.addEventListener('dragover', guard);
    window.addEventListener('drop', guard);
    return () => {
      window.removeEventListener('dragover', guard);
      window.removeEventListener('drop', guard);
    };
  }, []);

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (menuOpen) return setMenuOpen(false);
      if (modal) return closeModal();
      if (toast) setToast(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ------------------------------------------------------------ render

  if (quit) {
    return (
      <div className="app">
        <div className="loading-screen">
          <div>
            <Icon name="power_settings_new" />
            The server has stopped. Run <code>npm start</code> to start it again, then reload this
            page.
          </div>
        </div>
      </div>
    );
  }

  if (!snap || !session) {
    return (
      <div className="app">
        <div className="loading-screen">
          <div>
            <Spinner size={14} />
            Connecting to the local server…
          </div>
        </div>
      </div>
    );
  }

  const adbFound = snap.adb.found;
  const uiPhase =
    modal?.kind === 'searching' || modal?.kind === 'picker'
      ? 'searching'
      : modal?.kind === 'pair'
        ? 'pairing'
        : null;
  const pill = pillFor(adbFound, session, uiPhase);

  const menuItems = appMenuItems({
    theme: prefs.theme,
    density: prefs.density,
    adbFound,
    desktop: desktopBridge() !== null,
  });
  const onMenuSelect = (id: string) => {
    switch (id as AppMenuAction) {
      case 'theme:system':
        return prefs.setTheme('system');
      case 'theme:light':
        return prefs.setTheme('light');
      case 'theme:dark':
        return prefs.setTheme('dark');
      case 'density:compact':
        return prefs.setDensity('compact');
      case 'density:comfortable':
        return prefs.setDensity('comfortable');
      case 'settings':
        setMenuOpen(false);
        return setModal({ kind: 'settings' });
      case 'downloads':
        setMenuOpen(false);
        return setModal({ kind: 'downloads' });
      case 'pair':
        return openPair();
      case 'quitServer':
        api.quit().then(() => setQuit(true), fail);
        return;
    }
  };

  const paneCommon = {
    session,
    home: snap.mac.home,
    macStorage: snap.mac.storage,
    fsVersions: store.fsVersions,
    listEpoch: store.listEpoch,
    offlineVolumes: snap.offlineVolumes ?? [],
    volumeMove: store.volumeMove,
    drag,
    over,
    setDrag,
    setOver,
    onPathChange,
    onTransfer: (from: Side, srcPaths: string[], destDir: string) =>
      void requestTransfer(from, srcPaths, destDir),
    onFinderDrop: (to: Side, destDir: string, captured: CapturedDrop) =>
      void requestFinderDrop(to, destDir, captured),
    onReveal: requestReveal,
    revealLabel: revealLabel(snap.mac.platform),
    downloadRevealLabel: downloadRevealLabel(snap.mac.platform),
    onDeleteRequest: requestDelete,
    onToast: showToast,
    onStartSession: () => void startSession(),
    onOpenPair: openPair,
    onReconnect: reconnect,
    onStartNewSession: () => void startNewSession(),
    startDisabled: !adbFound,
  };

  return (
    <div className="app">
      <AppBar
        pill={pill}
        showEnd={live}
        startDisabled={!adbFound || st === 'connecting' || st === 'ending'}
        menuOpen={menuOpen}
        onStart={() => void startSession()}
        onEnd={endSession}
        onToggleMenu={() => setMenuOpen(!menuOpen)}
      />
      {!store.online ? (
        <div className="offline-bar" role="alert">
          <Spinner size={12} />
          Lost contact with the local server. Retrying…
        </div>
      ) : null}

      {!adbFound ? (
        <AdbMissing
          onCheck={async () => {
            try {
              const r = await api.recheckAdb();
              if (r.found)
                showToast(`Found adb${r.version ? ` ${r.version}` : ''} at ${r.path}.`, 'ok');
              else showToast('Still can’t find adb.');
            } catch (e) {
              fail(e);
            }
          }}
        />
      ) : (
        <>
          <div className="panes">
            <Pane
              key={`android:${session.device?.serial ?? 'none'}`}
              side="android"
              active={activeSide === 'android'}
              onActivate={() => setActiveSide('android')}
              otherDir={paths.mac}
              {...paneCommon}
            />
            <Pane
              key="mac"
              side="mac"
              active={activeSide === 'mac'}
              onActivate={() => setActiveSide('mac')}
              otherDir={live ? paths.android : null}
              {...paneCommon}
            />
          </div>
          <TransferPanel
            jobs={snap.jobs}
            sessionState={st}
            maxConcurrent={snap.settings.maxConcurrent}
            onSetParallel={(n) => {
              api.settings({ maxConcurrent: n }).catch(fail);
            }}
            onCancel={(id) => {
              api.cancelJob(id).catch(fail);
            }}
            onRetry={(id) => {
              api.retryJob(id).catch(fail);
            }}
            onClear={() => {
              api.clearJobs().catch(fail);
            }}
          />
        </>
      )}

      {toast ? <Toast key={toast.id} toast={toast} onDismiss={() => setToast(null)} /> : null}

      {menuOpen ? (
        <MenuList
          items={menuItems}
          style={{ top: 42, right: 10 }}
          width={236}
          onClose={() => setMenuOpen(false)}
          onSelect={onMenuSelect}
        />
      ) : null}

      {modal?.kind === 'searching' ? <SearchingModal onCancel={closeModal} /> : null}
      {modal?.kind === 'picker' ? (
        <DevicePickerModal
          candidates={modal.candidates}
          connectingId={modal.connectingId}
          onConnect={(id) => void connect(id)}
          onPair={openPair}
          onCancel={closeModal}
        />
      ) : null}
      {modal?.kind === 'pair' ? (
        <PairModal
          pairing={pairing}
          tab={modal.tab}
          onTab={setPairTab}
          onRetryQr={startQr}
          onSubmitCode={submitCode}
          onClose={closeModal}
        />
      ) : null}
      {modal?.kind === 'conflict' ? (
        <ConflictModal
          state={modal.state}
          now={now}
          onResolve={(d) => void resolveConflicts(modal.state.batchId, d)}
          onCancel={closeModal}
        />
      ) : null}
      {modal?.kind === 'settings' ? (
        <SettingsModal
          settings={snap.settings}
          adb={snap.adb}
          chooseFile={fileChooser()}
          onSave={async (patch) => {
            await api.settings(patch);
            setModal(null);
            showToast('Settings saved.', 'ok');
          }}
          onCancel={closeModal}
        />
      ) : null}
      {modal?.kind === 'downloads' ? (
        <DownloadsModal
          current={snap.settings.downloadsDir}
          revealLabel={downloadRevealLabel(snap.mac.platform)}
          onSave={async (dir) => {
            await api.settings({ downloadsDir: dir });
            setModal(null);
            showToast(`Downloads folder set to ${dir}.`, 'ok');
          }}
          onCancel={closeModal}
        />
      ) : null}
      {modal?.kind === 'confirm' ? (
        <ConfirmModal
          spec={modal.spec}
          busy={modal.busy}
          onConfirm={() => void runConfirm()}
          onCancel={closeModal}
        />
      ) : null}
    </div>
  );
}
