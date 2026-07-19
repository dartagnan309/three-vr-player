import { Player } from 'three-vr-player';

const $ = (id: string) => document.getElementById(id)!;

const player = new Player($('player'), {
  // Optional CORS proxy for non-CORS-clean sources (start ./proxy). Cross-origin
  // URLs are routed through it; CORS-clean URLs would also work without it.
  proxy: { url: 'http://localhost:8888', apiPassword: 'changeme' },
  controls: true,
});

const load = () => {
  const url = ($('url') as HTMLInputElement).value.trim();
  if (url) void player.load(url);
};
$('load').addEventListener('click', load);
$('url').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') load(); });

// Expose for debugging / E2E.
(window as unknown as { __demo: Player }).__demo = player;
