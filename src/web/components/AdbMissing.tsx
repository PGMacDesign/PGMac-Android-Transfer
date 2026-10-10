import { useState } from 'react';
import { Icon, Spinner } from './ui.tsx';

const CMD = 'brew install android-platform-tools';

export function AdbMissing({ onCheck }: { onCheck: () => Promise<void> }) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  return (
    <div className="setup">
      <div className="setup-inner">
        <div className="setup-tile">
          <Icon name="terminal" />
        </div>
        <h1>Android platform tools are required</h1>
        <p>
          PGMac Transfer talks to your phone through adb, which ships with Android’s platform tools.
          It isn’t installed on this Mac, or isn’t on your PATH. Install it with Homebrew:
        </p>
        <div className="codeline">
          <span className="muted">$</span>
          <span className="cmd">{CMD}</span>
          <button
            className="btn sm"
            onClick={() => {
              navigator.clipboard?.writeText(CMD).catch(() => undefined);
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }}
          >
            <Icon name={copied ? 'check' : 'content_copy'} />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
        <p className="small">
          Installed somewhere else? Set ADB_PATH in your .env, or add the folder containing adb to
          your PATH, then check again.
        </p>
        <div>
          <button
            className="btn primary"
            disabled={checking}
            onClick={async () => {
              setChecking(true);
              try {
                await onCheck();
              } finally {
                setChecking(false);
              }
            }}
          >
            {checking ? <Spinner /> : null}
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
      </div>
    </div>
  );
}
