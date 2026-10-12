// Packaging uses electron-builder rather than Electron Forge. The server's .ts sources and the
// prebuilt UI ship as-is, so there is no bundling step for Forge's plugin pipeline to drive;
// what's needed is a declarative file allowlist, devDependency pruning, a universal macOS
// build and a DMG, all of which electron-builder does from this one file. It wraps
// @electron/osx-sign and @electron/notarize, so signing and notarization are later config
// additions (mac.identity, mac.notarize), not a tool change.
//
// The universal build works because every production dependency is pure JavaScript: the arm64
// and x64 app.asar files are identical, so they merge without per-arch exceptions.
import type { Configuration } from 'electron-builder';

const config: Configuration = {
  appId: 'com.pgmacdesign.androidtransfer',
  productName: 'PGMac Android Transfer',
  // Version, and the `main` entry, come from package.json. Not setting buildVersion or
  // extraMetadata keeps the bundle's version and app.getVersion() on that single source.
  directories: {
    output: 'release',
    buildResources: 'build',
  },
  // An allowlist, so a new top-level directory stays out of the app until it's added here.
  // electron-builder adds the production dependencies under node_modules on its own and
  // leaves devDependencies out; the negations below apply to those files too.
  files: [
    'package.json',
    'electron/**/*',
    'src/server/**/*',
    'src/shared/**/*',
    'dist/web/**/*',
    '!**/*.map',
    '!**/.env',
    '!**/.env.*',
    // Dependencies publish docs, tests, examples, benchmarks and type declarations, at any depth
    // inside the package; nothing loads them at runtime. License texts stay, whatever their
    // extension, and source maps are already covered by `**/*.map`. The folder pattern starts
    // inside a package (`[!@]*` keeps a scope folder from counting as one), so a dependency that
    // is itself named `test` or `@scope/spec` still ships. Its zero-depth cases are spelled out
    // (`{,**/}`, `{,/**}`) because minimatch misses some matches where a `**` between segments
    // stands for no folders at all.
    '!**/node_modules/{[!@]*,@*/*}/{,**/}{docs,test,tests,__tests__,spec,example,examples,benchmark,benchmarks}{,/**}',
    '!**/node_modules/**/*.{test,spec}.*',
    '!**/node_modules/**/!(LICENSE*|License*|license*).md',
    '!**/node_modules/**/*.d.{ts,mts,cts}',
  ],
  asar: true,
  // Flipped in the Electron binary at package time. With the defaults, anyone could run
  // `ELECTRON_RUN_AS_NODE=1 <app binary> script.js`, or pass NODE_OPTIONS or --inspect, and run
  // their own code as this app, inheriting its signature and the Local Network and folder access
  // the user granted it. The server runs in a utilityProcess, which doesn't need runAsNode. The
  // asar pair makes the app load only app.asar and refuse one whose contents changed.
  electronFuses: {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    grantFileProtocolExtraPrivileges: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // Flipping fuses edits the binary and breaks its ad-hoc signature, and Apple Silicon kills an
    // arm64 binary whose signature doesn't match. With mac.identity null nothing re-signs the app
    // afterwards, so it is ad-hoc signed again here; a real identity signs over it.
    resetAdHocDarwinSignature: true,
  },
  mac: {
    category: 'public.app-category.utilities',
    // A 1024x1024 PNG; electron-builder converts it to .icns at build time.
    icon: 'build/icon.png',
    target: [{ target: 'dmg', arch: ['universal'] }],
    // Unsigned until the signing work: don't pick up whatever identity is in the keychain.
    identity: null,
    // Without these, macOS denies Local Network access instead of prompting, and Bonjour
    // discovery (adb's own mDNS and the dns-sd fallback, both started by the app) sees nothing.
    // Folder and volume strings are what the TCC prompts show when the local pane reads them.
    extendInfo: {
      NSLocalNetworkUsageDescription:
        'PGMac Android Transfer finds and connects to your phone over your WiFi network.',
      NSBonjourServices: ['_adb-tls-connect._tcp', '_adb-tls-pairing._tcp'],
      NSDesktopFolderUsageDescription:
        'PGMac Android Transfer lets you browse your Desktop and copy files to and from your phone.',
      NSDocumentsFolderUsageDescription:
        'PGMac Android Transfer lets you browse your Documents folder and copy files to and from your phone.',
      NSDownloadsFolderUsageDescription:
        'PGMac Android Transfer lets you browse your Downloads folder and copy files to and from your phone.',
      NSNetworkVolumesUsageDescription:
        'PGMac Android Transfer lets you browse network drives and copy files to and from your phone.',
      NSRemovableVolumesUsageDescription:
        'PGMac Android Transfer lets you browse external drives and copy files to and from your phone.',
    },
  },
  dmg: {
    // The usual drag-to-Applications layout: the app on the left, the link on the right.
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },
};

export default config;
