export type Projection =
  | '180-sbs' | '180-mono'
  | '360-mono' | '360-sbs' | '360-tb'
  | 'flat-2d' | 'flat-sbs-full' | 'flat-sbs-half';

export interface PlayerOptions {
  /** Initial source URL. If omitted, call `player.load(src)` later. */
  src?: string;
  /** Projection mode. Default `'180-sbs'` (or auto-detected from `src`). */
  projection?: Projection;
  /** Guess the projection from the src filename on load. Default `true`. */
  autoDetect?: boolean;
  /** Render the built-in controls UI. Default `true`. */
  controls?: boolean;
  /** Optional CORS proxy (e.g. a mediaflow-proxy) for cross-origin sources. */
  proxy?: { url: string; apiPassword?: string; headers?: Record<string, string> };
  /** Swap which eye's half is shown (for reversed sources). Default `false`. */
  swapEyes?: boolean;
  /** Vertical field of view in degrees. Default `70`. */
  fov?: number;
  /** Supersampling factor (× devicePixelRatio, capped at 4). Default `1.5`. */
  supersampling?: number;
  /** `crossOrigin` for the `<video>`. Default `'anonymous'`; `null` to omit. */
  crossOrigin?: 'anonymous' | 'use-credentials' | null;
  /** Persist view settings to localStorage. Default `false`. */
  persistSettings?: boolean;
  /** Mount into a Shadow DOM for style isolation. Default `true`. */
  shadowDom?: boolean;
  /** Show the Enter-VR button when a headset is available. Default `true`. */
  vrButton?: boolean;
  /** Title shown on the in-VR control panel. Optional. */
  title?: string;
  /**
   * If a cross-origin source can't be used as a WebGL texture (CORS-tainted) and
   * isn't proxied, fall back to plain 2D `<video>` playback instead of erroring.
   * Default `true`.
   */
  nativeFallback?: boolean;
}

export type PlayerEvent =
  | 'ready' | 'play' | 'pause' | 'ended' | 'error' | 'timeupdate'
  | 'projectionchange' | 'enterxr' | 'exitxr'
  /** Emitted when the player drops to 2D native playback due to CORS. */
  | 'fallback';
