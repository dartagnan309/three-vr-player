import { Player } from 'three-vr-player';
import type { Projection } from 'three-vr-player';

interface Item {
  title: string;
  sub: string;
  poster: string;
  src: string;
  projection?: Projection;
  alpha?: boolean;
}

// sample clips
const ITEMS: Item[] = [
  { title: 'Virtual Set', sub: 'VR 180° · 3D', poster: 'https://verdi.github.io/VR180-Web-Player/poster.jpg', src: 'https://verdi.github.io/VR180-Web-Player/sbs-video.mp4' },
  // Fisheye alpha passthrough (DeoVR FISHEYE190). No sample is shipped — drop a DeoVR `_ALPHA`
  // fisheye file into demo/ and point `src` at it (git-ignores demo/*.mp4). Enters immersive-AR
  // (passthrough) instead of VR; the packed alpha keys the subject out over the real world.
  { title: 'Passthrough (Fisheye190)', sub: 'AR · alpha · 3D', poster: 'https://verdi.github.io/VR180-Web-Player/poster.jpg', src: '/your-fisheye190-alpha-sample.mp4', projection: 'fisheye190-sbs', alpha: true },
];

const PLAY_SVG =
  '<svg viewBox="0 0 80 80" aria-hidden="true">' +
  '<circle cx="40" cy="40" r="38" fill="rgba(18,20,26,.62)" stroke="rgba(255,255,255,.92)" stroke-width="2"/>' +
  '<path d="M33 26 L57 40 L33 54 Z" fill="#fff"/></svg>';

// Detect immersive-VR once. On a headset (Quest etc.) a play tap jumps straight into VR
// instead of playing in the page.
let vrSupported = false;
let arSupported = false;
if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => { vrSupported = ok; }).catch(() => { /* keep false */ });
  navigator.xr.isSessionSupported('immersive-ar').then((ok) => { arSupported = ok; }).catch(() => { /* keep false */ });
}

const isFisheye = (p?: Projection) => !!p && p.startsWith('fisheye');

// Fire on a real pointer tap. The Quest controller ray doesn't reliably synthesize
// 'click' on <button>, but pointerup does (and carries the activation WebXR needs).
// Keep 'click' for mouse/keyboard, deduped so each tap runs once.
function onTap(el: HTMLElement, fn: (e: Event) => void): void {
  let downOn = false;
  let firedAt = -1e9;
  const run = (e: Event) => { firedAt = e.timeStamp; fn(e); };
  el.addEventListener('pointerdown', () => { downOn = true; });
  el.addEventListener('pointercancel', () => { downOn = false; });
  el.addEventListener('pointerup', (e) => { if (downOn) { downOn = false; run(e); } });
  el.addEventListener('click', (e) => { if (e.timeStamp - firedAt > 700) run(e); });
}

const grid = document.getElementById('grid')!;

// Only one video is initialized at a time — clicking a new poster tears down the previous
// player (freeing its WebGL context + download) and restores that card's poster.
let active: { player: Player; card: HTMLElement } | null = null;

function stopActive(): void {
  if (!active) return;
  // Null out first: dispose() may end the XR session and re-fire 'exitxr', which calls
  // back here — the early return above then makes the re-entrant call a no-op.
  const { player, card } = active;
  active = null;
  player.dispose();
  card.classList.remove('loading', 'playing');
}

for (const item of ITEMS) {
  const card = document.createElement('article');
  card.className = 'card';
  card.innerHTML =
    '<div class="stage">' +
      `<img class="poster" loading="lazy" src="${item.poster}" alt="${item.title}" />` +
      `<button class="play" type="button" aria-label="Play ${item.title}">${PLAY_SVG}</button>` +
      '<div class="spinner"></div>' +
      '<button class="close" type="button" aria-label="Stop and close">✕</button>' +
    '</div>' +
    `<div class="meta"><span class="title">${item.title}</span><span class="sub">${item.sub}</span></div>`;

  const stage = card.querySelector<HTMLElement>('.stage')!;
  const playBtn = card.querySelector<HTMLButtonElement>('.play')!;
  const closeBtn = card.querySelector<HTMLButtonElement>('.close')!;

  onTap(playBtn, () => {
    stopActive();
    card.classList.add('loading');
    const player = new Player(stage, { src: item.src, projection: item.projection ?? '180-sbs', controls: true, title: item.title, alpha: item.alpha });
    active = { player, card };

    const reveal = () => { card.classList.remove('loading'); card.classList.add('playing'); };
    player.on('ready', reveal);
    player.on('fallback', reveal);
    player.on('error', () => { if (active?.card === card) stopActive(); });
    // Leaving the immersive session ends the viewing — tear down the player and restore
    // the card's poster + play button rather than dropping back into the in-page 3D view.
    player.on('exitxr', () => { if (active?.card === card) stopActive(); });

    // Headset present: go straight into an immersive session from this tap rather than playing
    // in the page. The request runs synchronously off the pointer event so it keeps the
    // transient activation WebXR requires; start playback once the session begins (there are
    // no in-page controls in VR). Fisheye/alpha content enters AR (passthrough); everything
    // else enters VR. If the headset refuses, the in-page view still shows.
    const fisheye = isFisheye(item.projection);
    if (fisheye && arSupported) {
      player.on('enterxr', () => void player.play());
      player.enterAR().catch(() => { /* refused → fall back to the in-page 3D view */ });
    } else if (vrSupported) {
      player.on('enterxr', () => void player.play());
      player.enterVR().catch(() => { /* refused → fall back to the in-page 3D view */ });
    }
  });

  onTap(closeBtn, stopActive);
  grid.appendChild(card);
}
