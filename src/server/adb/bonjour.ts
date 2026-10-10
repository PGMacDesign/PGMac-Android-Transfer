import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  parseDnsSdAddress,
  parseDnsSdBrowse,
  parseDnsSdResolve,
  type MdnsService,
} from './parse.ts';

const DNS_SD = '/usr/bin/dns-sd';
const TYPES = [
  ['connect', '_adb-tls-connect._tcp'],
  ['pairing', '_adb-tls-pairing._tcp'],
] as const;

export const bonjourAvailable = () => process.platform === 'darwin' && existsSync(DNS_SD);

/**
 * dns-sd never exits on its own: collect its output until `enough` says stop or `ms` passes,
 * then kill it.
 */
function dnsSd(args: string[], ms: number, enough?: (out: string) => boolean): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(DNS_SD, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = () => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(out);
    };
    const timer = setTimeout(finish, ms);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
      if (enough?.(out)) finish();
    });
    child.on('error', finish);
    child.on('close', finish);
  });
}

/**
 * ADB services as seen by macOS's mDNSResponder. adb's built-in mDNS listener can receive
 * nothing on some Macs (it sends queries but never sees replies, e.g. with two interfaces on
 * one subnet) while the system resolver sees the phone fine.
 */
export async function bonjourServices(browseMs = 1500, resolveMs = 2000): Promise<MdnsService[]> {
  const browsed = await Promise.all(
    TYPES.map(async ([kind, type]) =>
      parseDnsSdBrowse(await dnsSd(['-B', type, 'local.'], browseMs)).map((instance) => ({
        kind,
        type,
        instance,
      })),
    ),
  );
  const addresses = new Map<string, Promise<string | null>>();
  const addressOf = (host: string) => {
    let p = addresses.get(host);
    if (!p) {
      p = dnsSd(['-G', 'v4', host], resolveMs, (o) => !!parseDnsSdAddress(o)).then(
        parseDnsSdAddress,
      );
      addresses.set(host, p);
    }
    return p;
  };
  const resolved = await Promise.all(
    browsed.flat().map(async ({ kind, type, instance }): Promise<MdnsService | null> => {
      const out = await dnsSd(
        ['-L', instance, type, 'local.'],
        resolveMs,
        (o) => !!parseDnsSdResolve(o),
      );
      const hp = parseDnsSdResolve(out);
      const ip = hp && (await addressOf(hp.host));
      return hp && ip ? { instance, kind, host: ip, port: hp.port } : null;
    }),
  );
  return resolved.filter((s): s is MdnsService => s !== null);
}
