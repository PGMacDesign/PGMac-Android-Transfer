import { describe, expect, it } from 'vitest';
import { isExternalUrl } from '../../electron/links.ts';

describe('isExternalUrl', () => {
  it('allows http and https links', () => {
    expect(isExternalUrl('https://github.com/PGMacDesign/PGMac-Android-Transfer')).toBe(true);
    expect(isExternalUrl('http://example.com/a?b=c')).toBe(true);
    expect(isExternalUrl('HTTPS://EXAMPLE.COM')).toBe(true);
  });

  it('refuses every other scheme and anything unparseable', () => {
    for (const url of [
      'file:///Applications/Calculator.app',
      'javascript:alert(1)',
      'data:text/html,hi',
      'smb://server/share',
      'x-apple.systempreferences:com.apple.preference.security',
      'about:blank',
      'mailto:a@b.c',
      '/relative/path',
      '',
      'not a url',
    ]) {
      expect(isExternalUrl(url), url).toBe(false);
    }
  });
});
