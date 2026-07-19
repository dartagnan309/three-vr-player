export { Player } from './Player.js';
export type { PlayerOptions, PlayerEvent, Projection } from './types.js';
export { ThreeVideoElement, registerWebComponent } from './webcomponent.js';
export * from './core/index.js';

import { registerWebComponent } from './webcomponent.js';
// Auto-register <three-video> when the main entry is imported.
registerWebComponent();
