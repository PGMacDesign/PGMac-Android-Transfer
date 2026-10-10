import { describe, expect, it } from 'vitest';
import {
  batteryIcon,
  fmtBytes,
  fmtCountdown,
  fmtDate,
  fmtEta,
  fmtSpeed,
  iconFor,
} from '../../src/web/format.ts';

describe('fmtBytes', () => {
  it('uses decimal units with one decimal under 100', () => {
    expect(fmtBytes(0)).toBe('0 B');
    expect(fmtBytes(999)).toBe('999 B');
    expect(fmtBytes(1000)).toBe('1 KB');
    expect(fmtBytes(4.1e6)).toBe('4.1 MB');
    expect(fmtBytes(312e6)).toBe('312 MB');
    expect(fmtBytes(41.2e9)).toBe('41.2 GB');
    expect(fmtBytes(5.7e9)).toBe('5.7 GB');
    expect(fmtBytes(1e12)).toBe('1 TB');
  });
  it('rolls over instead of showing 1000 of a unit', () => {
    expect(fmtBytes(999_990)).toBe('1 MB');
  });
  it('renders unknown sizes as a dash', () => {
    expect(fmtBytes(null)).toBe('–');
    expect(fmtBytes(Number.NaN)).toBe('–');
  });
});

describe('fmtDate', () => {
  const now = new Date(2026, 9, 5, 15, 0).getTime();
  it('labels today and yesterday', () => {
    expect(fmtDate(new Date(2026, 9, 5, 9, 14).getTime(), now)).toBe('Today, 09:14');
    expect(fmtDate(new Date(2026, 9, 4, 23, 5).getTime(), now)).toBe('Yesterday, 23:05');
  });
  it('uses day month year otherwise', () => {
    expect(fmtDate(new Date(2026, 8, 14, 18, 30).getTime(), now)).toBe('14 Sep 2026, 18:30');
  });
  it('has a short form for narrow layouts', () => {
    expect(fmtDate(new Date(2026, 9, 5, 9, 14).getTime(), now, true)).toBe('Today 09:14');
    expect(fmtDate(new Date(2026, 8, 14, 18, 30).getTime(), now, true)).toBe('14 Sep, 18:30');
    expect(fmtDate(new Date(2025, 10, 2, 12, 0).getTime(), now, true)).toBe('2 Nov 2025');
  });
});

describe('fmtEta / fmtSpeed / fmtCountdown', () => {
  it('formats durations', () => {
    expect(fmtEta(12.2)).toBe('13s');
    expect(fmtEta(125)).toBe('2m 05s');
    expect(fmtEta(3725)).toBe('1h 02m');
    expect(fmtEta(Number.POSITIVE_INFINITY)).toBe('–');
  });
  it('formats speed in MB/s', () => {
    expect(fmtSpeed(22_400_000)).toBe('22.4 MB/s');
    expect(fmtSpeed(0)).toBe('–');
  });
  it('formats countdowns and clamps at zero', () => {
    expect(fmtCountdown(120_000)).toBe('2:00');
    expect(fmtCountdown(61_500)).toBe('1:02');
    expect(fmtCountdown(-5)).toBe('0:00');
  });
});

describe('icons', () => {
  it('maps extensions and folders', () => {
    expect(iconFor('DCIM', true)).toBe('folder');
    expect(iconFor('PXL_1.JPG', false)).toBe('image');
    expect(iconFor('clip.mp4', false)).toBe('movie');
    expect(iconFor('.zshrc', false)).toBe('draft');
    expect(iconFor('README', false)).toBe('draft');
  });
  it('flags low battery', () => {
    expect(batteryIcon(12)).toBe('battery_alert');
    expect(batteryIcon(78)).toBe('battery_6_bar');
    expect(batteryIcon(100)).toBe('battery_full');
  });
});
