import type { Camera } from 'three';

const DEG = Math.PI / 180;

/** Clamp look angles (degrees) to keep the view inside the front hemisphere. */
export function clampAngles(lon: number, lat: number): { lon: number; lat: number } {
  return {
    lon: Math.max(-90, Math.min(90, lon)),
    lat: Math.max(-85, Math.min(85, lat)),
  };
}

/**
 * Pointer/touch drag → camera yaw/pitch, clamped to the front hemisphere.
 * Disabled while an XR session drives the head pose, and for flat-screen modes.
 */
export class LookControls {
  private lon = 0;
  private lat = 0;
  private dragging = false;
  private px = 0;
  private py = 0;
  private enabled = true;
  private readonly isPresenting: () => boolean;

  constructor(
    private readonly camera: Camera,
    private readonly dom: HTMLElement,
    opts: { isPresenting?: () => boolean } = {},
  ) {
    this.isPresenting = opts.isPresenting ?? (() => false);
    this.dom.addEventListener('pointerdown', this.onDown);
    this.dom.addEventListener('pointermove', this.onMove);
    this.dom.addEventListener('pointerup', this.onUp);
    this.dom.addEventListener('pointercancel', this.onUp);
  }

  private capture(fn: 'setPointerCapture' | 'releasePointerCapture', id: number) {
    try { this.dom[fn]?.(id); } catch { /* pointer not active */ }
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    this.dragging = true;
    this.px = e.clientX;
    this.py = e.clientY;
    this.capture('setPointerCapture', e.pointerId);
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    const dx = e.clientX - this.px;
    const dy = e.clientY - this.py;
    this.px = e.clientX;
    this.py = e.clientY;
    ({ lon: this.lon, lat: this.lat } = clampAngles(this.lon - dx * 0.15, this.lat + dy * 0.15));
  };

  private onUp = (e: PointerEvent) => {
    this.dragging = false;
    this.capture('releasePointerCapture', e.pointerId);
  };

  update() {
    if (this.isPresenting() || !this.enabled) return;
    const phi = (90 - this.lat) * DEG;
    const theta = this.lon * DEG;
    this.camera.lookAt(
      Math.sin(phi) * Math.sin(theta),
      Math.cos(phi),
      -Math.sin(phi) * Math.cos(theta),
    );
  }

  reset() { this.lon = 0; this.lat = 0; }

  setEnabled(v: boolean) {
    this.enabled = v;
    if (!v) { this.lon = 0; this.lat = 0; this.camera.lookAt(0, 0, -1); }
  }

  getAngles() { return { lon: this.lon, lat: this.lat }; }

  dispose() {
    this.dom.removeEventListener('pointerdown', this.onDown);
    this.dom.removeEventListener('pointermove', this.onMove);
    this.dom.removeEventListener('pointerup', this.onUp);
    this.dom.removeEventListener('pointercancel', this.onUp);
  }
}
