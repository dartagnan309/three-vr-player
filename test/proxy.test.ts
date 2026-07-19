import { describe, it, expect } from 'vitest';
import { detectFormat, buildProxyUrl } from '../src/core/proxy.js';

const PROXY = { url: 'http://localhost:8888', apiPassword: 'pw' };

describe('detectFormat', () => {
  it('maps by extension, ignoring query', () => {
    expect(detectFormat('https://x/a.mp4')).toBe('progressive');
    expect(detectFormat('https://x/a.webm')).toBe('progressive');
    expect(detectFormat('https://x/a.m3u8?t=1')).toBe('hls');
    expect(detectFormat('https://x/a.mpd')).toBe('dash');
  });
});

describe('buildProxyUrl', () => {
  it('progressive → /proxy/stream with d + api_password', () => {
    const { url, format } = buildProxyUrl('https://x/a.mp4', PROXY);
    expect(format).toBe('progressive');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('http://localhost:8888/proxy/stream');
    expect(u.searchParams.get('d')).toBe('https://x/a.mp4');
    expect(u.searchParams.get('api_password')).toBe('pw');
  });
  it('hls → /proxy/hls/manifest.m3u8', () => {
    expect(buildProxyUrl('https://x/a.m3u8', PROXY).url).toContain('/proxy/hls/manifest.m3u8?');
  });
  it('dash → /proxy/mpd/manifest.m3u8', () => {
    expect(buildProxyUrl('https://x/a.mpd', PROXY).url).toContain('/proxy/mpd/manifest.m3u8?');
  });
  it('the %20 sample round-trips through d', () => {
    const raw = 'https://vr.cam/wp-content/uploads/video/IPS_2024-04-12.11.58.50.9680%20-%20sample.mp4';
    expect(new URL(buildProxyUrl(raw, PROXY).url).searchParams.get('d')).toBe(raw);
  });
  it('no proxy → raw url', () => {
    expect(buildProxyUrl('https://x/a.mp4').url).toBe('https://x/a.mp4');
  });
  it('extra headers → h_<Name>', () => {
    const { url } = buildProxyUrl('https://x/a.mp4', { url: 'http://localhost:8888', headers: { Referer: 'https://vr.cam/' } });
    expect(new URL(url).searchParams.get('h_Referer')).toBe('https://vr.cam/');
  });
});
