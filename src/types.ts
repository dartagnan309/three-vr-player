export type Projection =
  | '180-mono' | '180-sbs' | '180-tb'
  | '360-mono' | '360-sbs' | '360-tb'
  | 'fisheye190-mono' | 'fisheye190-sbs' | 'fisheye190-tb'
  | 'fisheye200-mono' | 'fisheye200-sbs' | 'fisheye200-tb'
  | 'fisheye210-mono' | 'fisheye210-sbs' | 'fisheye210-tb'
  | 'fisheye220-mono' | 'fisheye220-sbs' | 'fisheye220-tb'
  | 'flat-2d' | 'flat-sbs-full' | 'flat-sbs-half' | 'flat-tb';

/** Normalized proxy state shared between the Player, the settings UI, and the
 *  `proxychange` event payload. */
export interface ProxyUIState {
  url: string;
  apiPassword: string;
  enabled: boolean;
  transcode: boolean;
}

export interface PlayerOptions {
  /** Initial source URL. If omitted, call `player.load(src)` later. */
  src?: string;
  /** Projection mode. Default `'180-sbs'` (or auto-detected from `src`). */
  projection?: Projection;
  /** Guess the projection from the src filename on load. Default `true`. */
  autoDetect?: boolean;
  /** Render the built-in controls UI. Default `true`. */
  controls?: boolean;
  /** Optional CORS proxy (e.g. a mediaflow-proxy) for cross-origin sources.
   *  Set `transcode: true` to have the proxy re-serve progressive sources as
   *  browser-compatible fMP4 (audio → AAC; video → H.264 only when it isn't already). */
  proxy?: { url: string; apiPassword?: string; headers?: Record<string, string>; transcode?: boolean };
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
  /**
   * Arm the headset's own "Enter VR" affordance via `navigator.xr.offerSession`, re-offered
   * on each session end so it keeps working. Independent of `vrButton`. Default `true`;
   * set `false` to never call `offerSession`.
   */
  offerSession?: boolean;
  /** Title shown on the in-VR control panel. Optional. */
  title?: string;
  /**
   * Content carries a DeoVR-style packed alpha matte (fisheye passthrough). When omitted, it's
   * inferred from a `_ALPHA` marker in the source filename. Only affects fisheye projections.
   */
  alpha?: boolean;
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
  /** Emitted when the CORS proxy config/toggle changes (keeps the settings UI in sync). */
  | 'proxychange'
  /** Emitted when the player drops to 2D native playback due to CORS. */
  | 'fallback';
