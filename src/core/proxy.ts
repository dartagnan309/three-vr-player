export type StreamFormat = 'hls' | 'dash' | 'progressive';

export interface ProxyConfig {
  url: string;
  apiPassword?: string;
  headers?: Record<string, string>;
  /** Ask the proxy to transcode to browser-compatible fMP4 (H.264/AAC). Audio is always
   *  normalized to AAC (fixing AC-3/E-AC3/DTS); video is copied when it's already H.264 and
   *  re-encoded otherwise (HEVC/VP9 → H.264). Applies to progressive sources only.
   *  Default `false`. */
  transcode?: boolean;
}

/** Detect streaming format from a URL by extension. */
export function detectFormat(rawUrl: string): StreamFormat {
  let pathname = rawUrl;
  try { pathname = new URL(rawUrl).pathname; } catch { /* relative/opaque: use raw */ }
  const lower = pathname.toLowerCase();
  if (lower.endsWith('.m3u8')) return 'hls';
  if (lower.endsWith('.mpd')) return 'dash';
  return 'progressive';
}

const ENDPOINTS: Record<StreamFormat, string> = {
  progressive: '/proxy/stream',
  hls: '/proxy/hls/manifest.m3u8',
  dash: '/proxy/mpd/manifest.m3u8',
};

/**
 * Build the URL the `<video>`/hls.js should load. When `proxy` is omitted the raw
 * URL is returned (it must then be CORS-clean to be used as a WebGL texture).
 */
export function buildProxyUrl(rawUrl: string, proxy?: ProxyConfig): { url: string; format: StreamFormat } {
  const format = detectFormat(rawUrl);
  if (!proxy || !proxy.url) return { url: rawUrl, format };
  const base = proxy.url.replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('d', rawUrl);
  if (proxy.apiPassword) params.set('api_password', proxy.apiPassword);
  // Transcoding is only offered on the progressive /proxy/stream endpoint (returns fMP4).
  // The HLS/DASH manifest endpoints ignore it, so don't send a misleading flag there.
  if (proxy.transcode && format === 'progressive') params.set('transcode', 'true');
  for (const [name, value] of Object.entries(proxy.headers ?? {})) {
    if (value != null && value !== '') params.set(`h_${name}`, value);
  }
  return { url: `${base}${ENDPOINTS[format]}?${params.toString()}`, format };
}
