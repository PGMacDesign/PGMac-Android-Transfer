import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

export function Icon({
  name,
  fill,
  className,
}: {
  name: string;
  fill?: boolean;
  className?: string;
}) {
  const cls = ['icon', fill ? 'fill' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={cls} aria-hidden="true">
      {name}
    </span>
  );
}

export function Spinner({ size = 12 }: { size?: number }) {
  return <span className="spinner" aria-hidden="true" style={{ width: size, height: size }} />;
}

/** Re-renders every `intervalMs` and returns the current time. */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, enabled]);
  return now;
}

export function Modal({
  children,
  onDismiss,
  dismissable = true,
}: {
  children: ReactNode;
  onDismiss: () => void;
  dismissable?: boolean;
}) {
  return (
    <div
      className="backdrop"
      onMouseDown={(e) => {
        if (dismissable && e.target === e.currentTarget) onDismiss();
      }}
    >
      {children}
    </div>
  );
}

export interface MenuEntry {
  kind?: 'item' | 'sep' | 'header';
  label?: string;
  icon?: string;
  kbd?: string;
  danger?: boolean;
  disabled?: boolean;
  run?: () => void;
  /** Alternative to `run`: passed to MenuList's `onSelect`. */
  id?: string;
}

export function MenuList({
  items,
  style,
  width,
  onClose,
  onSelect,
}: {
  items: MenuEntry[];
  style: CSSProperties;
  width?: number;
  onClose: () => void;
  onSelect?: (id: string) => void;
}) {
  return (
    <>
      <div
        className="catcher"
        onMouseDown={(e) => {
          e.preventDefault();
          onClose();
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div className="menu" role="menu" style={{ ...style, width }}>
        {items.map((it, i) => {
          if (it.kind === 'sep') return <div key={i} className="menu-sep" />;
          if (it.kind === 'header')
            return (
              <div key={i} className="menu-header">
                {it.label}
              </div>
            );
          return (
            <button
              key={i}
              role="menuitem"
              className={`menu-item${it.danger ? ' danger' : ''}`}
              disabled={it.disabled}
              onClick={() => {
                onClose();
                if (it.id !== undefined) onSelect?.(it.id);
                else it.run?.();
              }}
            >
              <Icon name={it.icon ?? ''} />
              <span className="label">{it.label}</span>
              {it.kbd ? <span className="kbd">{it.kbd}</span> : null}
            </button>
          );
        })}
      </div>
    </>
  );
}

export interface ToastData {
  id: number;
  text: string;
  kind: 'ok' | 'error';
}

export function Toast({ toast, onDismiss }: { toast: ToastData; onDismiss: () => void }) {
  return (
    <div className={`toast ${toast.kind}`} role="alert">
      <Icon name={toast.kind === 'ok' ? 'check_circle' : 'error'} fill className="lead" />
      <span className="msg">{toast.text}</span>
      <button aria-label="Dismiss" onClick={onDismiss}>
        <Icon name="close" />
      </button>
    </div>
  );
}
