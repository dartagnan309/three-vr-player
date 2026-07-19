import type Hls from 'hls.js';
import type { StreamFormat } from './proxy.js';

/**
 * Attaches a source to a `<video>`. Progressive files go straight on `video.src`;
 * HLS/DASH-as-HLS go through hls.js — which is imported dynamically, so consumers
 * who never play HLS don't pay for it (and it's an optional dependency).
 */
export class VideoSource {
  private hls: Hls | null = null;

  async attach(
    video: HTMLVideoElement,
    source: { url: string; format: StreamFormat },
    opts: { crossOrigin?: string | null } = {},
  ): Promise<void> {
    this.dispose();
    const co = opts.crossOrigin === undefined ? 'anonymous' : opts.crossOrigin;
    if (co === null) video.removeAttribute('crossorigin');
    else video.crossOrigin = co;
    video.playsInline = true;

    const { url, format } = source;
    const isHlsLike = format === 'hls' || format === 'dash';
    const nativeHls = video.canPlayType('application/vnd.apple.mpegurl') !== '';

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onError);
      };
      const onLoaded = () => { cleanup(); resolve(); };
      const onError = () => {
        cleanup();
        const code = video.error ? video.error.code : 'unknown';
        reject(new Error(`Video failed to load (media error ${code}). Is the source reachable and CORS-clean?`));
      };
      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onError);

      if (isHlsLike && !nativeHls) {
        import('hls.js').then(({ default: HlsCtor }) => {
          if (!HlsCtor.isSupported()) {
            cleanup();
            reject(new Error('HLS/DASH stream needs hls.js, which is unsupported in this browser.'));
            return;
          }
          this.hls = new HlsCtor({ enableWorker: true });
          this.hls.on(HlsCtor.Events.ERROR, (_e, data) => {
            if (data.fatal) { cleanup(); this.dispose(); reject(new Error(`HLS fatal error: ${data.type} / ${data.details}`)); }
          });
          this.hls.loadSource(url);
          this.hls.attachMedia(video);
        }).catch(() => {
          cleanup();
          reject(new Error('This looks like an HLS/DASH stream but hls.js could not be loaded. Install "hls.js".'));
        });
      } else {
        video.src = url;
        video.load();
      }
    });
  }

  dispose() {
    if (this.hls) { this.hls.destroy(); this.hls = null; }
  }
}
