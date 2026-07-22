import { Player } from './Player.js';
import type { Projection } from './types.js';

/**
 * `<three-video src="…" projection="180-sbs" controls>` — a framework-agnostic
 * custom element wrapping {@link Player}. Give it a size via CSS.
 */
export class ThreeVideoElement extends HTMLElement {
  private player?: Player;

  static get observedAttributes() { return ['src', 'projection']; }

  connectedCallback() {
    if (this.player) return;
    if (!this.style.display) this.style.display = 'block';
    this.player = new Player(this, {
      src: this.getAttribute('src') ?? undefined,
      projection: (this.getAttribute('projection') as Projection) ?? undefined,
      controls: this.hasAttribute('controls'),
      swapEyes: this.hasAttribute('swap-eyes'),
      autoDetect: this.getAttribute('auto-detect') !== 'false',
      fov: this.numAttr('fov'),
      supersampling: this.numAttr('supersampling'),
      proxy: this.getAttribute('proxy-url')
        ? {
            url: this.getAttribute('proxy-url')!,
            apiPassword: this.getAttribute('proxy-password') ?? undefined,
            transcode: this.hasAttribute('proxy-transcode'),
          }
        : undefined,
    });
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null) {
    if (!this.player || value == null) return;
    if (name === 'src') void this.player.load(value);
    if (name === 'projection') this.player.setProjection(value as Projection);
  }

  disconnectedCallback() { this.player?.dispose(); this.player = undefined; }

  private numAttr(n: string): number | undefined {
    const v = this.getAttribute(n);
    return v == null ? undefined : Number(v);
  }

  /** The underlying Player instance (for programmatic control). */
  get api(): Player | undefined { return this.player; }
}

export function registerWebComponent(tag = 'three-video') {
  if (typeof customElements !== 'undefined' && !customElements.get(tag)) {
    customElements.define(tag, ThreeVideoElement);
  }
}
