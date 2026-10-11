import { describe, expect, it } from 'vitest';
import {
  parseBattery,
  ADB_BLOCKED_ERROR,
  parseConnectOutcome,
  parseConnectResult,
  parseDnsSdAddress,
  parseDnsSdBrowse,
  parseDnsSdResolve,
  parseDevices,
  parseFindListing,
  parseFindTimes,
  parseMdnsServices,
  parsePairResult,
  parseStatfs,
  sumSizes,
} from '../src/server/adb/parse.ts';
import { shQuote } from '../src/server/adb/adb.ts';
import { describeAdbFailure } from '../src/server/transfers/adbRunner.ts';
import { keepBothName } from '../src/server/transfers/naming.ts';
import { normalizeAbs, pathsOverlap, validateName } from '../src/server/fs/paths.ts';

// Fixtures captured from adb 37 against an Android 17 emulator.
const DEVICES = `List of devices attached
emulator-5554          device product:sdk_gphone16k_arm64 model:sdk_gphone16k_arm64 device:emu64a16k transport_id:4
192.168.1.42:37115     device product:husky model:Pixel_8_Pro device:husky transport_id:7
adb-2B1C3D-AbCdEf._adb-tls-connect._tcp device product:husky model:Pixel_8_Pro device:husky transport_id:8
R5CT1234ABC            unauthorized usb:1-1 transport_id:9
`;

const BATTERY = `Current Battery Service state:
  AC powered: false
  USB powered: true
  Wireless powered: false
  Dock powered: false
  status: 2
  health: 2
  present: true
  level: 78
  scale: 100
`;

describe('adb output parsers', () => {
  it('parses adb devices -l with transports and models', () => {
    expect(parseDevices(DEVICES)).toEqual([
      {
        serial: 'emulator-5554',
        state: 'device',
        model: 'sdk gphone16k arm64',
        transport: 'emulator',
      },
      { serial: '192.168.1.42:37115', state: 'device', model: 'Pixel 8 Pro', transport: 'wifi' },
      {
        serial: 'adb-2B1C3D-AbCdEf._adb-tls-connect._tcp',
        state: 'device',
        model: 'Pixel 8 Pro',
        transport: 'wifi',
      },
      { serial: 'R5CT1234ABC', state: 'unauthorized', model: null, transport: 'usb' },
    ]);
  });

  it('parses mdns services in both type spellings and ignores junk', () => {
    const out = [
      'List of discovered mdns services',
      'adb-2B1C3D-AbCdEf\t_adb-tls-connect._tcp\t192.168.1.42:37115',
      'studio-k3j4h5\t_adb-tls-pairing._tcp.\t192.168.1.42:41827',
      'garbage line',
      '',
    ].join('\n');
    expect(parseMdnsServices(out)).toEqual([
      { instance: 'adb-2B1C3D-AbCdEf', kind: 'connect', host: '192.168.1.42', port: 37115 },
      { instance: 'studio-k3j4h5', kind: 'pairing', host: '192.168.1.42', port: 41827 },
    ]);
  });

  it('parses battery level and charging state', () => {
    expect(parseBattery(BATTERY)).toEqual({ level: 78, charging: true });
    expect(
      parseBattery(
        BATTERY.replace('USB powered: true', 'USB powered: false').replace(
          'status: 2',
          'status: 3',
        ),
      ),
    ).toEqual({
      level: 78,
      charging: false,
    });
    expect(parseBattery('nothing here')).toBeNull();
  });

  it('parses statfs output', () => {
    expect(parseStatfs('2057466 2541783 4096\n')).toEqual({
      freeBytes: 2057466 * 4096,
      totalBytes: 2541783 * 4096,
    });
    expect(parseStatfs('stat: error')).toBeNull();
  });

  it('parses NUL-separated find listings, including spaces, quotes and tabs-free names', () => {
    const out =
      'drwxrws---\t4096\t1791223346.714145465\tsub dir\0' +
      "-rw-rw----\t3\t1791223346.722145465\tit's a b.txt\0" +
      '-rw-rw----\t2\t1791223346.726145465\t.hidden\0' +
      'lrwxrwxrwx\t12\t1791223346.000000000\tlink\0';
    expect(parseFindListing(out)).toEqual([
      { name: 'sub dir', isDir: true, isSymlink: false, size: 0, mtimeMs: 1791223346714 },
      { name: "it's a b.txt", isDir: false, isSymlink: false, size: 3, mtimeMs: 1791223346722 },
      { name: '.hidden', isDir: false, isSymlink: false, size: 2, mtimeMs: 1791223346726 },
      { name: 'link', isDir: false, isSymlink: true, size: 12, mtimeMs: 1791223346000 },
    ]);
  });

  it('sums file sizes', () => {
    expect(sumSizes('10\n20\n\n5\n')).toEqual({ bytes: 35, files: 3 });
  });

  it('reads adb pair and connect results from output, not exit codes', () => {
    expect(parsePairResult('Successfully paired to 192.168.1.42:41827 [guid=adb-x]')).toEqual({
      ok: true,
    });
    expect(parsePairResult('Failed: Wrong password or connection was dropped.')).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Wrong pairing code/),
    });
    expect(parsePairResult("error: protocol fault (couldn't read status message)")).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Could not reach/),
    });
    expect(parseConnectResult('connected to 192.168.1.42:37115')).toBe(true);
    expect(parseConnectResult('already connected to 192.168.1.42:37115')).toBe(true);
    expect(parseConnectResult("failed to connect to '127.0.0.1:5999': Connection refused")).toBe(
      false,
    );
  });

  it('explains a daemon macOS blocks from the local network, with the exact fix', () => {
    expect(ADB_BLOCKED_ERROR).toBe(
      'macOS is blocking adb from your local network. Quit any tools using adb, run `adb kill-server && adb start-server` in Terminal, then try again.',
    );
    for (const out of [
      'Failed: Unable to start pairing client: unable to connect to 192.168.1.42:41827: No route to host',
      'error: unable to connect to 192.168.1.42:41827: no route to host',
    ]) {
      expect(parsePairResult(out)).toEqual({ ok: false, error: ADB_BLOCKED_ERROR });
    }
    expect(
      parseConnectOutcome('failed to connect to 192.168.1.42:37115: No route to host'),
    ).toEqual({ ok: false, error: ADB_BLOCKED_ERROR });
  });

  it('keeps the address message for other unreachable pairing failures', () => {
    for (const out of [
      "failed to connect to '192.168.1.42:41827': Connection refused",
      'error: unable to connect to 192.168.1.42:41827',
      'error: connect to 192.168.1.42:41827 timed out',
      "error: protocol fault (couldn't read status message)",
    ]) {
      expect(parsePairResult(out)).toEqual({
        ok: false,
        error:
          'Could not reach the phone at that address. Check the IP and port on the pairing screen.',
      });
    }
  });

  it('reports a reason only for connect failures the user can act on', () => {
    expect(parseConnectOutcome('connected to 192.168.1.42:37115')).toEqual({ ok: true });
    expect(parseConnectOutcome('already connected to 192.168.1.42:37115')).toEqual({ ok: true });
    for (const out of [
      "failed to connect to '192.168.1.42:37115': Connection refused",
      'failed to connect to 192.168.1.42:37115: Operation timed out',
      "error: protocol fault (couldn't read status message)",
    ]) {
      expect(parseConnectOutcome(out)).toEqual({ ok: false, error: null });
    }
    // The boolean parser existing callers use is unchanged.
    expect(parseConnectResult('failed to connect to 192.168.1.42:37115: No route to host')).toBe(
      false,
    );
  });

  it('maps adb transfer failures to short messages', () => {
    expect(describeAdbFailure("adb: error: device 'x' not found")).toBe('Device disconnected');
    expect(describeAdbFailure('adb: error: failed to copy: No space left on device')).toMatch(
      /space/,
    );
    expect(describeAdbFailure('adb: error: something odd')).toBe('something odd');
  });
});

describe('parseFindTimes', () => {
  it('reads dates by relative path, including odd names and the start point', () => {
    const out = '1577934245.5\t\0' + '1577934245\tsub/a b\nc.txt\0' + 'junk\0' + '0\tz\0';
    expect(parseFindTimes(out)).toEqual([
      { rel: '', mtimeMs: 1577934245500 },
      { rel: 'sub/a b\nc.txt', mtimeMs: 1577934245000 },
    ]);
  });

  it('drops a record cut off by a timeout', () => {
    expect(parseFindTimes('1577934245\ta.txt\0' + '1577934246\t')).toEqual([
      { rel: 'a.txt', mtimeMs: 1577934245000 },
    ]);
  });
});

describe('quoting and paths', () => {
  it('single-quotes for the device shell', () => {
    expect(shQuote("it's here")).toBe(`'it'\\''s here'`);
    expect(shQuote('$(rm -rf /)')).toBe(`'$(rm -rf /)'`);
  });

  it('normalizes absolute paths and rejects unsafe input', () => {
    expect(normalizeAbs('/sdcard/Download/../DCIM/')).toBe('/sdcard/DCIM');
    expect(normalizeAbs('/')).toBe('/');
    expect(() => normalizeAbs('relative/path')).toThrow();
    expect(() => normalizeAbs('/bad\0path')).toThrow();
    expect(() => normalizeAbs(42)).toThrow();
  });

  it('validates names', () => {
    expect(validateName('  ok name ')).toBe('ok name');
    for (const bad of ['', '.', '..', 'a/b', 'x\0']) expect(() => validateName(bad)).toThrow();
  });

  it('detects overlapping paths', () => {
    expect(pathsOverlap('/a/b', '/a/b')).toBe(true);
    expect(pathsOverlap('/a', '/a/b/c')).toBe(true);
    expect(pathsOverlap('/a/b/c', '/a')).toBe(true);
    expect(pathsOverlap('/a/b', '/a/bc')).toBe(false);
  });
});

describe('keepBothName', () => {
  it('numbers like Finder and skips taken names', () => {
    expect(keepBothName('photo.jpg', false, new Set(['photo.jpg']))).toBe('photo (1).jpg');
    expect(keepBothName('photo.jpg', false, new Set(['photo (1).jpg']))).toBe('photo (2).jpg');
    expect(keepBothName('archive.tar.gz', false, new Set())).toBe('archive.tar (1).gz');
    expect(keepBothName('.zshrc', false, new Set())).toBe('.zshrc (1)');
    expect(keepBothName('v1.2 folder', true, new Set())).toBe('v1.2 folder (1)');
  });
});

describe('dns-sd output', () => {
  it('lists browsed instances that are still present, including names with spaces', () => {
    const out = [
      'Browsing for _adb-tls-connect._tcp',
      'DATE: ---Mon 05 Oct 2026---',
      '12:34:59.686  ...STARTING...',
      'Timestamp     A/R    Flags  if Domain               Service Type         Instance Name',
      '12:34:59.687  Add        3  10 local.               _adb-tls-connect._tcp. adb-ABC-xyz',
      '12:34:59.687  Add        2  25 local.               _adb-tls-connect._tcp. adb-ABC-xyz',
      '12:34:59.688  Add        2  10 local.               _adb-tls-connect._tcp. Pixel 9 Pro',
      '12:35:01.000  Rmv        0  10 local.               _adb-tls-connect._tcp. Pixel 9 Pro',
      '12:35:01.000  Rmv        0  10 local.               _adb-tls-connect._tcp. adb-ABC-xyz',
    ].join('\n');
    expect(parseDnsSdBrowse(out)).toEqual(['adb-ABC-xyz']);
  });

  it('reads the host and port from a resolve', () => {
    const out =
      '12:35:33.859  adb-ABC-xyz._adb-tls-connect._tcp.local. can be reached at Android.local.:35231 (interface 10)\n api=36.1 v=1';
    expect(parseDnsSdResolve(out)).toEqual({ host: 'Android.local.', port: 35231 });
    expect(parseDnsSdResolve('Lookup adb-ABC-xyz')).toBeNull();
  });

  it('reads the first IPv4 address from an address lookup', () => {
    const out = [
      'Timestamp     A/R  Flags         IF  Hostname          Address          TTL',
      '12:35:30.707  Add  40000003      10  Android.local.    192.168.1.42     120',
    ].join('\n');
    expect(parseDnsSdAddress(out)).toBe('192.168.1.42');
    expect(parseDnsSdAddress('Timestamp A/R Flags')).toBeNull();
  });
});
