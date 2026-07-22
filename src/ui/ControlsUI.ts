import type { Projection } from '../types.js';
import {
  composeProjection, decomposeProjection, FISHEYE_ANGLES,
  type ProjType, type Split, type FisheyeAngle, type FlatWidth,
} from '../core/projections.js';
import { formatTime } from './format.js';

/** What the ControlsUI needs from the Player to drive playback + view. */
export interface PlayerBridge {
  video: HTMLVideoElement;
  surface: HTMLElement;            // canvas — for wheel-zoom
  fullscreenTarget: HTMLElement;
  vrSupported(): Promise<boolean>;
  enterVR(): Promise<void>;
  exitVR(): void;
  isPresenting(): boolean;
  onVrChange(cb: (presenting: boolean) => void): void;
  getProjection(): Projection | 'off';
  setProjection(p: Projection | 'off'): void;
  setSwapEyes(v: boolean): void;
  setFov(deg: number): void;
  setSupersampling(x: number): void;
  initial: { swapEyes: boolean; fov: number; supersampling: number };
  proxy: { url: string; apiPassword: string; enabled: boolean };
  setProxy(p: { url: string; apiPassword: string; enabled: boolean }): void;
  /** Notifies when the proxy config changes (incl. programmatic setProxy) so the fields stay in sync. */
  onProxyChange(cb: (p: { url: string; apiPassword: string; enabled: boolean }) => void): void;
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

    // --- VR ---
    const vrBtn = h('button', { class: 'tvp-btn tvp-vrbtn', title: 'Enter VR', textContent: '🥽', hidden: true });

    // --- projection menu (decomposed grid: layout × type × fisheye-angle) ---
    const projBtn = h('button', { class: 'tvp-btn tvp-projbtn', title: 'Projection', textContent: '🌐' });
    const projMenu = h('div', { class: 'tvp-projmenu', hidden: true });
    // Build a labelled row of choice buttons; each carries data-axis + data-value.
    const axisRow = (axis: string, caption: string, items: { value: string; label: string }[]): HTMLElement => {
      const row = h('div', { class: 'tvp-projrow' }, items.map((it) => {
        const b = h('button', { class: 'tvp-projopt', textContent: it.label });
        b.dataset.axis = axis; b.dataset.value = it.value;
        return b;
      }));
      return h('div', { class: 'tvp-projgroup' }, [h('span', { class: 'tvp-projcap', textContent: caption }), row]);
    };
    const layoutGroup = axisRow('split', 'Layout', [
      { value: 'mono', label: 'Mono' }, { value: 'sbs', label: 'SBS' }, { value: 'tb', label: 'TB' },
    ]);
    const typeGroup = axisRow('type', 'Type', [
      { value: 'flat', label: 'Flat' }, { value: '180', label: '180°' },
      { value: '360', label: '360°' }, { value: 'fisheye', label: 'Fisheye' },
    ]);
    // Contextual third row: fisheye angle (fisheye) OR SBS width (flat + SBS) — one shown at a time.
    const angleGroup = axisRow('angle', 'Fisheye angle', FISHEYE_ANGLES.map((a) => ({ value: String(a), label: `${a}°` })));
    const widthGroup = axisRow('flatWidth', 'SBS width', [{ value: 'half', label: 'Half' }, { value: 'full', label: 'Full' }]);
    const offBtn = h('button', { class: 'tvp-projopt tvp-projoff', textContent: 'Off (native player)' });
    offBtn.dataset.axis = 'off'; offBtn.dataset.value = 'off';
    projMenu.append(layoutGroup, typeGroup, angleGroup, widthGroup, h('hr', { class: 'tvp-sep' }), offBtn);
    const projWrap = h('span', { class: 'tvp-projwrap' }, [projBtn, projMenu]);

    // --- settings ---
    const settingsBtn = h('button', { class: 'tvp-btn tvp-settingsbtn', title: 'Settings', textContent: '⚙' });
    const fullscreen = h('button', { class: 'tvp-btn tvp-fullscreen', title: 'Fullscreen', textContent: '⛶' });

    const controls = h('footer', { class: 'tvp-controls' }, [play, seek, time, volWrap, vrBtn, projWrap, settingsBtn, fullscreen]);

    const swapCb = h('input', { type: 'checkbox', checked: bridge.initial.swapEyes });
    const fovRange = h('input', { type: 'range', min: '30', max: '100', step: '1', value: String(bridge.initial.fov) });
    const fovVal = h('span', { textContent: String(bridge.initial.fov) });
    const ssRange = h('input', { type: 'range', min: '1', max: '2', step: '0.25', value: String(bridge.initial.supersampling) });
    const ssVal = h('span', { textContent: String(bridge.initial.supersampling) });
    const useProxyCb = h('input', { type: 'checkbox', checked: bridge.proxy.enabled });
    const proxyUrlIn = h('input', { type: 'text', value: bridge.proxy.url, placeholder: 'http://localhost:8888', spellcheck: false });
    const proxyPwIn = h('input', { type: 'password', value: bridge.proxy.apiPassword, placeholder: 'API password' });
    const settings = h('section', { class: 'tvp-settings' }, [
      h('label', { class: 'row' }, [swapCb, 'Swap eyes (if depth looks wrong)']),
      h('label', {}, [makeText('Field of view (zoom): ', fovVal, '°'), fovRange]),
      h('label', {}, [makeText('Supersampling: ', ssVal, '× (sharpness)'), ssRange]),
      h('hr', { class: 'tvp-sep' }),
      h('label', { class: 'row' }, [useProxyCb, 'Use CORS proxy']),
      h('label', {}, ['Proxy URL', proxyUrlIn]),
      h('label', {}, ['API password', proxyPwIn]),
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
    // Only one popup (volume / projection / settings) open at a time.
    const closeMenus = () => { volPopup.hidden = true; projMenu.hidden = true; settings.classList.remove('open'); };
    let toastTimer = 0;
    const showToast = (msg: string) => {
      toast.textContent = msg;
      toast.classList.add('show');
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => toast.classList.remove('show'), 4500);
    };

    // Fire on a real pointer tap. The Meta Quest controller ray often fails to
    // synthesize `click` on <button> (tiny ray movement between press/release exceeds
    // the click threshold), while pointerup always fires. We trigger on pointerup and
    // keep `click` for keyboard/assistive tech, deduped so each activation fires once.
    // (pointerup carries transient activation too, so WebXR requestSession still works.)
    const onTap = (el: HTMLElement, fn: (e: Event) => void) => {
      let downOn = false;
      let firedAt = -1e9;
      const run = (e: Event) => { firedAt = e.timeStamp; fn(e); };
      on(el, 'pointerdown', () => { downOn = true; });
      on(el, 'pointercancel', () => { downOn = false; });
      on(el, 'pointerup', (e: Event) => { if (downOn) { downOn = false; run(e); } });
      on(el, 'click', (e: Event) => { if (e.timeStamp - firedAt > 700) run(e); });
    };

    onTap(play, () => { v.paused ? void v.play() : v.pause(); });
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

    onTap(mute, () => { const open = volPopup.hidden; closeMenus(); volPopup.hidden = !open; });
    on(volume, 'input', () => { v.volume = Number(volume.value); v.muted = v.volume === 0; mute.textContent = v.muted ? '🔇' : '🔊'; });

    // The grid edits one axis at a time, so it keeps a working (type, split, angle) even
    // while output is 'off' (native player). Seeded from the current projection.
    let lastProj: Projection = bridge.getProjection() === 'off' ? '180-sbs' : bridge.getProjection() as Projection;
    const updateProjection = () => {
      const mode = bridge.getProjection();
      const off = mode === 'off';
      if (!off) lastProj = mode as Projection;
      const spec = decomposeProjection(lastProj);
      const isFisheye = spec.type === 'fisheye';
      const isFlatSbs = spec.type === 'flat' && spec.split === 'sbs';
      // Third row: fisheye → angle; flat+SBS → width; otherwise neither is shown.
      angleGroup.hidden = !isFisheye;
      widthGroup.hidden = !isFlatSbs;
      projMenu.querySelectorAll<HTMLButtonElement>('button.tvp-projopt').forEach((b) => {
        const { axis, value } = b.dataset;
        const active =
          axis === 'off' ? off :
          off ? false :
          axis === 'type' ? value === spec.type :
          axis === 'split' ? value === spec.split :
          axis === 'angle' ? (isFisheye && value === String(spec.angle)) :
          axis === 'flatWidth' ? (isFlatSbs && value === spec.flatWidth) : false;
        b.classList.toggle('active', active);
      });
      projBtn.title = off ? 'Projection: Off (native player)' : 'Projection';
    };
    onTap(projBtn, () => { const open = projMenu.hidden; closeMenus(); projMenu.hidden = !open; });
    onTap(projMenu, (e: Event) => {
      const b = (e.target as HTMLElement).closest('button.tvp-projopt') as HTMLButtonElement | null;
      if (!b) return;
      const { axis, value } = b.dataset;
      if (axis === 'off') { bridge.setProjection('off'); updateProjection(); return; }
      const s = decomposeProjection(lastProj);
      if (axis === 'type') s.type = value as ProjType;
      else if (axis === 'split') s.split = value as Split;
      else if (axis === 'angle') { s.type = 'fisheye'; s.angle = Number(value) as FisheyeAngle; } // angle → force fisheye
      else if (axis === 'flatWidth') s.flatWidth = value as FlatWidth;                            // (flat SBS only)
      bridge.setProjection(composeProjection(s.type, s.split, s.angle, s.flatWidth));
      updateProjection();
    });
    updateProjection();

    onTap(settingsBtn, () => { const open = !settings.classList.contains('open'); closeMenus(); settings.classList.toggle('open', open); });
    on(swapCb, 'change', () => bridge.setSwapEyes(swapCb.checked));
    on(fovRange, 'input', () => { const d = Number(fovRange.value); fovVal.textContent = String(d); bridge.setFov(d); });
    on(ssRange, 'input', () => { const x = Number(ssRange.value); ssVal.textContent = String(x); bridge.setSupersampling(x); });
    const applyProxy = () => bridge.setProxy({ url: proxyUrlIn.value.trim(), apiPassword: proxyPwIn.value, enabled: useProxyCb.checked });
    on(useProxyCb, 'change', applyProxy);
    on(proxyUrlIn, 'change', applyProxy);
    on(proxyPwIn, 'change', applyProxy);
    // Reflect programmatic (or reloaded) proxy changes back into the fields. Only setting the
    // element properties — no 'change' event is dispatched, so this won't re-trigger applyProxy.
    bridge.onProxyChange(({ url, apiPassword, enabled }) => {
      proxyUrlIn.value = url; proxyPwIn.value = apiPassword; useProxyCb.checked = enabled;
    });
    on(bridge.surface, 'wheel', (e: WheelEvent) => {
      e.preventDefault();
      const next = Math.max(30, Math.min(100, Number(fovRange.value) + Math.sign(e.deltaY) * 3));
      fovRange.value = String(next); fovVal.textContent = String(next); bridge.setFov(next);
    }, { passive: false });

    onTap(fullscreen, () => {
      const t = bridge.fullscreenTarget;
      if (!document.fullscreenElement) void t.requestFullscreen?.();
      else void document.exitFullscreen?.();
    });

    // outside-tap closes any open popup (pointerdown fires reliably on Quest; click may not)
    on(document, 'pointerdown', (e: Event) => {
      const path = (e as Event & { composedPath(): EventTarget[] }).composedPath();
      const inside = (el: Node) => path.includes(el);
      if (![volPopup, mute, projMenu, projBtn, settings, settingsBtn].some(inside)) closeMenus();
    });

    // Auto-hide the control bar after 5s of inactivity; show on movement over the player.
    let hideTimer = 0;
    const popupOpen = () => !volPopup.hidden || !projMenu.hidden || settings.classList.contains('open');
    const hideBar = () => { if (!popupOpen()) controls.classList.add('tvp-hidden'); };
    const showBar = () => { controls.classList.remove('tvp-hidden'); clearTimeout(hideTimer); hideTimer = window.setTimeout(hideBar, 5000); };
    on(bridge.fullscreenTarget, 'pointermove', showBar);
    on(bridge.fullscreenTarget, 'pointerdown', showBar);
    on(bridge.fullscreenTarget, 'pointerleave', () => { clearTimeout(hideTimer); hideBar(); });
    this.disposers.push(() => clearTimeout(hideTimer));
    showBar();

    // VR button only when an immersive-VR device is available
    void bridge.vrSupported().then((ok) => { vrBtn.hidden = !ok; });
    onTap(vrBtn, () => {
      if (bridge.isPresenting()) { bridge.exitVR(); return; }
      // requestSession is the first thing off the tap so it keeps the user gesture;
      // any rejection is surfaced instead of silently swallowed.
      bridge.enterVR().catch((err: unknown) => showToast(err instanceof Error ? err.message : 'Could not enter VR.'));
    });
    bridge.onVrChange((presenting) => { vrBtn.classList.toggle('active', presenting); vrBtn.title = presenting ? 'Exit VR' : 'Enter VR'; });
  }

  dispose() {
    for (const d of this.disposers) d();
    for (const n of this.nodes) n.remove();
  }
}

/** One caption line: "Field of view (zoom): 70°". Wrapped in a single span so it
 *  stays on one row inside the column-flex label (a bare fragment would let the
 *  value and unit drop onto their own lines). */
function makeText(prefix: string, valueSpan: HTMLElement, suffix: string): HTMLElement {
  const line = document.createElement('span');
  line.className = 'tvp-caption';
  line.append(prefix, valueSpan, suffix);
  return line;
}
