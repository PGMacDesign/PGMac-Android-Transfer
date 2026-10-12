import { describe, expect, it } from 'vitest';
import { windowUrl } from '../../electron/lib.ts';
import { isExternalUrl, navigationDecision } from '../../electron/links.ts';

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

describe('navigationDecision', () => {
  const appOrigin = 'http://127.0.0.1:4848';

  it('lets the window navigate within the app origin', () => {
    expect(navigationDecision('http://127.0.0.1:4848/', appOrigin)).toBe('allow');
    expect(navigationDecision('http://127.0.0.1:4848/some/page?x=1#t=abc', appOrigin)).toBe(
      'allow',
    );
  });

  it('matches the origin of the URL the window loads', () => {
    expect(navigationDecision(windowUrl(4848, 'secret'), appOrigin)).toBe('allow');
  });

  it('hands other web origins to the browser instead, loopback ones included', () => {
    for (const url of [
      'https://github.com/PGMacDesign/PGMac-Android-Transfer',
      'http://127.0.0.1:4849/',
      'https://127.0.0.1:4848/',
      'http://localhost:4848/',
      'http://127.0.0.1.evil.example:4848/',
    ]) {
      expect(navigationDecision(url, appOrigin), url).toBe('external');
    }
  });

  it('blocks every other scheme without handing it on', () => {
    for (const url of [
      'file:///Applications/Calculator.app',
      'javascript:alert(1)',
      'data:text/html,hi',
      'about:blank',
      'x-apple.systempreferences:com.apple.preference.security',
      'not a url',
      '',
    ]) {
      expect(navigationDecision(url, appOrigin), url).toBe('block');
    }
  });

  it('allows nothing before the server is listening', () => {
    expect(navigationDecision('http://127.0.0.1:4848/', null)).toBe('external');
    expect(navigationDecision('file:///etc/passwd', null)).toBe('block');
    expect(navigationDecision('data:text/html,hi', null)).toBe('block');
  });
});
