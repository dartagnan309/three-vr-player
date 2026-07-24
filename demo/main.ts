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

// Dev-only in-VR harness: loaded only with `?xr`, so it (and its `iwer` dep) never touches the
// normal demo path or the shipped library. Then run `await xrHarness.runChecks()` in the console.
if (new URLSearchParams(location.search).has('xr')) {
  void import('./dev/xr-harness.js').then(async ({ install }) => {
    window.xrHarness = await install(player);
    console.log('%c in-VR harness ready — await xrHarness.runChecks() ', 'background:#4f8cff;color:#fff;padding:2px 8px;border-radius:3px;font-weight:600');
  });
}
