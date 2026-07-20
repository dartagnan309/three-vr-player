import { Player } from 'three-vr-player';
import type { Projection } from 'three-vr-player';

interface Item {
  title: string;
  sub: string;
  poster: string;
  src: string;
  projection?: Projection;
}

// sample clips
const ITEMS: Item[] = [
  { title: 'Virtual Set', sub: 'VR 180° · 3D', poster: 'https://verdi.github.io/VR180-Web-Player/poster.jpg', src: 'https://verdi.github.io/VR180-Web-Player/sbs-video.mp4' }
];

const PLAY_SVG =
  '<svg viewBox="0 0 80 80" aria-hidden="true">' +
  '<circle cx="40" cy="40" r="38" fill="rgba(18,20,26,.62)" stroke="rgba(255,255,255,.92)" stroke-width="2"/>' +
  '<path d="M33 26 L57 40 L33 54 Z" fill="#fff"/></svg>';

// Detect immersive-VR once. On a headset (Quest etc.) a play tap jumps straight into VR
// instead of playing in the page.
let vrSupported = false;
if (navigator.xr) {
  navigator.xr.isSessionSupported('immersive-vr').then((ok) => { vrSupported = ok; }).catch(() => { /* keep false */ });
}

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
  active.player.dispose();
  active.card.classList.remove('loading', 'playing');
  active = null;
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
    const player = new Player(stage, { src: item.src, projection: item.projection ?? '180-sbs', controls: true });
    active = { player, card };

    const reveal = () => { card.classList.remove('loading'); card.classList.add('playing'); };
    player.on('ready', reveal);
    player.on('fallback', reveal);
    player.on('error', () => { if (active?.card === card) stopActive(); });

    if (vrSupported) {
      // Headset present: go straight into immersive VR from this tap rather than playing
      // in the page. enterVR() runs synchronously off the pointer event so it keeps the
      // transient activation WebXR requires; start playback once the session begins (there
      // are no in-page controls in VR). If the headset refuses, the in-page view still shows.
      player.on('enterxr', () => void player.play());
      player.enterVR().catch(() => { /* refused → fall back to the in-page 3D view */ });
    }
  });

  onTap(closeBtn, stopActive);
  grid.appendChild(card);
}
