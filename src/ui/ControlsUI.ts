import type { Projection } from '../types.js';
import { PROJECTIONS } from '../core/projections.js';
import { formatTime } from './format.js';

/** What the ControlsUI needs from the Player to drive playback + view. */
export interface PlayerBridge {
  video: HTMLVideoElement;
  surface: HTMLElement;            // canvas — for wheel-zoom
  fullscreenTarget: HTMLElement;
  vrButton: HTMLElement;
  vrSupported(): Promise<boolean>;
  getProjection(): Projection;
  setProjection(p: Projection): void;
  setSwapEyes(v: boolean): void;
  setFov(deg: number): void;
  setSupersampling(x: number): void;
  initial: { swapEyes: boolean; fov: number; supersampling: number };
}

type Props = Record<string, unknown> & { class?: string };
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  const { class: cls, ...rest } = props;
  if (cls) el.className = cls;
  Object.assign(el, rest);
  for (const c of children) el.append(c);
  return el;
}

/** Builds the controls bar + settings/menus inside `root` and wires them to `bridge`. */
export class ControlsUI {
  private readonly nodes: HTMLElement[] = [];
  private readonly disposers: (() => void)[] = [];

  constructor(root: ParentNode, bridge: PlayerBridge) {
    const v = bridge.video;

    // --- playback ---
    const play = h('button', { class: 'tvp-btn tvp-play', title: 'Play/Pause', textContent: '▶' });
    const seek = h('input', { class: 'tvp-seek', type: 'range', min: '0', max: '1000', value: '0' });
    const time = h('span', { class: 'tvp-time', textContent: '0:00 / 0:00' });

    // --- volume ---
    const mute = h('button', { class: 'tvp-btn tvp-mute', title: 'Volume', textContent: '🔊' });
    const volume = h('input', { class: 'tvp-volume', type: 'range', min: '0', max: '1', step: '0.01', value: '1' });
    const volPopup = h('div', { class: 'tvp-volpopup', hidden: true }, [volume]);
    const volWrap = h('span', { class: 'tvp-volwrap' }, [mute, volPopup]);

    // --- VR slot ---
    const vrSlot = h('span', { class: 'tvp-vrslot' });

    // --- projection menu ---
    const projBtn = h('button', { class: 'tvp-btn tvp-projbtn', title: 'Projection', textContent: '🌐' });
    const projMenu = h('div', { class: 'tvp-projmenu', hidden: true });
    for (const p of PROJECTIONS) {
      const b = h('button', { textContent: p.label });
      b.dataset.mode = p.value;
      projMenu.append(b);
    }
    const projWrap = h('span', { class: 'tvp-projwrap' }, [projBtn, projMenu]);

    // --- settings ---
    const settingsBtn = h('button', { class: 'tvp-btn tvp-settingsbtn', title: 'Settings', textContent: '⚙' });
    const fullscreen = h('button', { class: 'tvp-btn tvp-fullscreen', title: 'Fullscreen', textContent: '⛶' });

    const controls = h('footer', { class: 'tvp-controls' }, [play, seek, time, volWrap, vrSlot, projWrap, settingsBtn, fullscreen]);

    const swapCb = h('input', { type: 'checkbox', checked: bridge.initial.swapEyes });
    const fovRange = h('input', { type: 'range', min: '30', max: '100', step: '1', value: String(bridge.initial.fov) });
    const fovVal = h('span', { textContent: String(bridge.initial.fov) });
    const ssRange = h('input', { type: 'range', min: '1', max: '2', step: '0.25', value: String(bridge.initial.supersampling) });
    const ssVal = h('span', { textContent: String(bridge.initial.supersampling) });
    const settings = h('section', { class: 'tvp-settings' }, [
      h('label', { class: 'row' }, [swapCb, 'Swap eyes (if depth looks wrong)']),
      h('label', {}, [makeText('Field of view (zoom): ', fovVal, '°'), fovRange]),
      h('label', {}, [makeText('Supersampling: ', ssVal, '× (sharpness)'), ssRange]),
    ]);

    const toast = h('div', { class: 'tvp-toast' });

    this.nodes.push(controls, settings, toast);
    for (const n of this.nodes) root.append(n);

    // ---- wiring ----
    const on = <T extends EventTarget>(t: T, ev: string, fn: (e: any) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(ev, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(ev, fn as EventListener, opts));
    };
    const setSeekFill = (pct: number) => seek.style.setProperty('--seek', `${pct}%`);

    on(play, 'click', () => { v.paused ? void v.play() : v.pause(); });
    on(v, 'play', () => { play.textContent = '⏸'; });
    on(v, 'pause', () => { play.textContent = '▶'; });

    on(v, 'timeupdate', () => {
      if (v.duration) {
        const pct = (v.currentTime / v.duration) * 100;
        seek.value = String(pct * 10);
        setSeekFill(pct);
        time.textContent = `${formatTime(v.currentTime)} / ${formatTime(v.duration)}`;
      }
    });
    on(seek, 'input', () => {
      setSeekFill(Number(seek.value) / 10);
      if (v.duration) v.currentTime = (Number(seek.value) / 1000) * v.duration;
    });

    on(mute, 'click', (e: Event) => { e.stopPropagation(); volPopup.hidden = !volPopup.hidden; });
    on(volume, 'input', () => { v.volume = Number(volume.value); v.muted = v.volume === 0; mute.textContent = v.muted ? '🔇' : '🔊'; });

    const updateProjection = () => {
      const mode = bridge.getProjection();
      let label = 'Projection';
      projMenu.querySelectorAll('button').forEach((b) => {
        const on2 = b.dataset.mode === mode;
        b.classList.toggle('active', on2);
        if (on2) label = `Projection: ${b.textContent}`;
      });
      projBtn.title = label;
    };
    on(projBtn, 'click', (e: Event) => { e.stopPropagation(); projMenu.hidden = !projMenu.hidden; });
    on(projMenu, 'click', (e: Event) => {
      const b = (e.target as HTMLElement).closest('button[data-mode]') as HTMLElement | null;
      if (b) { bridge.setProjection(b.dataset.mode as Projection); updateProjection(); projMenu.hidden = true; }
    });
    updateProjection();

    on(settingsBtn, 'click', (e: Event) => { e.stopPropagation(); settings.classList.toggle('open'); });
    on(swapCb, 'change', () => bridge.setSwapEyes(swapCb.checked));
    on(fovRange, 'input', () => { const d = Number(fovRange.value); fovVal.textContent = String(d); bridge.setFov(d); });
    on(ssRange, 'input', () => { const x = Number(ssRange.value); ssVal.textContent = String(x); bridge.setSupersampling(x); });
    on(bridge.surface, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      const next = Math.max(30, Math.min(100, Number(fovRange.value) + Math.sign(e.deltaY) * 3));
      fovRange.value = String(next); fovVal.textContent = String(next); bridge.setFov(next);
    }, { passive: false });

    on(fullscreen, 'click', () => {
      const t = bridge.fullscreenTarget;
      if (!document.fullscreenElement) void t.requestFullscreen?.();
      else void document.exitFullscreen?.();
    });

    // outside-click closes the popups (composedPath crosses the shadow boundary)
    on(document, 'click', (e: Event) => {
      const path = (e as Event & { composedPath(): EventTarget[] }).composedPath();
      if (!volPopup.hidden && !path.includes(volPopup) && !path.includes(mute)) volPopup.hidden = true;
      if (!projMenu.hidden && !path.includes(projMenu) && !path.includes(projBtn)) projMenu.hidden = true;
    });

    // VR button only when an immersive-VR device is available
    void bridge.vrSupported().then((ok) => {
      if (ok) {
        Object.assign(bridge.vrButton.style, { position: 'static', left: 'auto', bottom: 'auto', transform: 'none', margin: '0' });
        vrSlot.append(bridge.vrButton);
      }
    });

    // silence unused-var lint for the toast helper (available for future use)
    void toast;
  }

  dispose() {
    for (const d of this.disposers) d();
    for (const n of this.nodes) n.remove();
  }
}

function makeText(prefix: string, valueSpan: HTMLElement, suffix: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  frag.append(prefix, valueSpan, suffix);
  return frag;
}
