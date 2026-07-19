# three-vr-player

An embeddable web player for **3D and VR video** — VR **180°/360°** (mono or stereo)
and flat **side-by-side / top-bottom 3D movies** — rendered **undistorted** on desktop
(mouse drag to look around) and in **WebXR** (true per-eye stereo). Built on
[three.js](https://threejs.org).

Drop it into any page as a `<three-video>` element, or drive it from JavaScript with
the `Player` class. Optional [mediaflow-proxy](./proxy) companion handles CORS for
sources that don't send it.

## Install

```bash
npm install three-vr-player three
```

`three` is a **peer dependency** (bring your own). `hls.js` is optional — install it
only if you need HLS: `npm install hls.js`.

## Quick start (JS API)

```ts
import { Player } from 'three-vr-player';

const player = new Player(document.getElementById('app')!, {
  src: 'https://…/clip.mp4',   // 180 SBS by default; auto-detected from the filename
  controls: true,
});

player.on('ready', () => console.log('loaded'));
player.setProjection('360-tb');
```

Give the container a size (the player fills it): `#app { width: 100%; height: 480px }`.

## Web component (no build step)

```html
<script type="module" src="https://unpkg.com/three-vr-player/dist/three-vr-player.standalone.js"></script>

<three-video src="https://…/clip_360_sbs.mp4" projection="360-sbs" controls
             style="width:100%;height:480px"></three-video>
```

The `standalone` build bundles three.js and hls.js, so no import map or peer install
is needed. (With a bundler, `import 'three-vr-player'` also registers `<three-video>`.)

## Projections

Auto-detected from the filename on load (override any time). Pick a mode from the 🌐
menu in the controls, or set it programmatically:

| Mode | Geometry | Eyes |
|---|---|---|
| `180-sbs` | 180° dome | left/right |
| `180-mono` | 180° dome | mono |
| `360-mono` | 360° sphere | mono |
| `360-sbs` | 360° sphere | left/right |
| `360-tb` | 360° sphere | top/bottom |
| `flat-2d` | flat screen | mono |
| `flat-sbs-full` | flat screen | left/right (full-width per eye) |
| `flat-sbs-half` | flat screen | left/right (half-width per eye) |

## Options

```ts
new Player(container, {
  src?: string;
  projection?: Projection;      // default '180-sbs' (or auto-detected)
  autoDetect?: boolean;         // default true
  controls?: boolean;           // default true (built-in UI)
  proxy?: { url: string; apiPassword?: string; headers?: Record<string,string> };
  swapEyes?: boolean;           // default false
  fov?: number;                 // default 70
  supersampling?: number;       // default 1.5 (× devicePixelRatio, capped at 4)
  crossOrigin?: 'anonymous' | 'use-credentials' | null; // default 'anonymous'
  persistSettings?: boolean;    // default false (localStorage)
  shadowDom?: boolean;          // default true (style isolation)
  vrButton?: boolean;           // default true (shown only when a headset is present)
});
```

## Methods & events

```ts
player.load(src, { projection? }); player.play(); player.pause();
player.setProjection(p); player.setSwapEyes(b); player.setFov(deg); player.setSupersampling(x);
player.enterVR(); player.dispose();
player.video;   // the underlying <video>
player.three;   // { renderer, scene, camera }

player.on('ready'|'play'|'pause'|'ended'|'error'|'timeupdate'|'projectionchange'|'enterxr'|'exitxr', cb);
```

## Headless core

Want your own controls? Import the engine directly:

```ts
import { StereoScene, VideoSource, LookControls, buildProxyUrl } from 'three-vr-player/core';
```

## CORS / proxy

To use a cross-origin video as a WebGL texture it must be CORS-clean. If your host
doesn't send `Access-Control-Allow-Origin`, run the optional [proxy companion](./proxy)
and pass `proxy: { url, apiPassword }`. CORS-clean sources need no proxy.

## Codecs

The browser must be able to decode the file: MP4/WebM with H.264/HEVC/VP9 + AAC/Opus is
safest. `.mkv` and Dolby AC-3/DTS audio are browser limitations, not the player.

## Develop

```bash
npm install
npm run dev        # demo at http://localhost:8080 (paste a video URL; start ./proxy for non-CORS sources)
npm test           # unit tests (vitest)
npm run typecheck
npm run build      # dist/: ESM + types + standalone
```

## Roadmap & license

See [ROADMAP.md](./ROADMAP.md) — VR controllers + hand-tracking + in-VR panel, WebRTC
live, fisheye lens-correction, framework wrappers, and more. Licensed **MIT**.
