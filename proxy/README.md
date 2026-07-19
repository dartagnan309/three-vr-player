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

> Note: the API password travels in the query string. Keep this proxy local/private.
