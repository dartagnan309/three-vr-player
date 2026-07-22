# Optional CORS proxy (mediaflow-proxy)

To use a cross-origin video as a WebGL texture, the response must be **CORS-clean**
(`Access-Control-Allow-Origin`). Many hosts don't send that header, which taints the
canvas and breaks rendering. This optional companion runs
[mediaflow-proxy](https://github.com/mhdzumair/mediaflow-proxy) locally, which
re-serves the stream with permissive CORS headers.

## Run

```bash
cp .env.example .env      # set API_PASSWORD if you like
docker compose up
```

The proxy listens on `http://localhost:8888`.

## Point the player at it

```ts
new Player(container, {
  src: 'https://some-host.example/video.mp4',
  proxy: { url: 'http://localhost:8888', apiPassword: 'changeme' },
});
```

or on the web component:

```html
<three-video src="…" controls proxy-url="http://localhost:8888" proxy-password="changeme"></three-video>
```

Sources that already send `Access-Control-Allow-Origin` don't need the proxy — omit
the `proxy` option and they load directly.

## Transcoding incompatible audio (AC-3 / DTS → AAC)

Some files carry audio the browser can't decode (Dolby AC-3/E-AC3, DTS — common in
`.mkv`). mediaflow-proxy can re-serve a **progressive** source as browser-compatible
**fMP4**: audio is normalized to AAC and video is copied when it's already H.264 (only
re-encoded if it isn't). Turn it on per-source:

```ts
new Player(container, {
  src: 'https://some-host.example/movie.mkv',
  proxy: { url: 'http://localhost:8888', apiPassword: 'changeme', transcode: true },
});
```

or tick **Transcode audio** in the ⚙ settings, add `proxy-transcode` on the web
component, or call `player.setProxy({ url, apiPassword, enabled: true, transcode: true })`.

Under the hood this adds `&transcode=true` to the proxy's `/proxy/stream` request. It
applies to progressive sources only (HLS/DASH manifests are passed through unchanged).
The proxy must have transcoding enabled (`ENABLE_TRANSCODE=true`, its default);
GPU is used when available. Transcoding is heavier than a plain proxy — expect more CPU
and some startup latency.

> Note: the API password travels in the query string. Keep this proxy local/private.
