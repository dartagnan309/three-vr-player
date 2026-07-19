# Roadmap

Planned work beyond the v1 embeddable player. Contributions welcome.

## 1. VR input & in-VR UX
- [ ] Motion controllers with pointer-ray selection
- [ ] WebXR hand tracking
- [ ] In-VR floating control panel (play/pause, seek, volume, projection) on a plane
- [ ] Haptic feedback on UI hover
- [ ] Recenter / reset view
- [ ] Grab-to-reposition the screen in space (6-DoF)
- [ ] Thumbstick zoom

## 2. WebRTC live ingest
- [ ] `load()` accepting a `MediaStream` / live `<video>` element
- [ ] WHEP subscribe (and a Millicast-style helper) for low-latency live sources

## 3. Fisheye / lens-correction projections
- [ ] True fisheye **VR180** projection (not just equirectangular)
- [ ] Per-lens correction meshes + a calibration hook for specific cameras

## 4. Framework wrappers
- [ ] React component
- [ ] Vue component
- [ ] Svelte component

## 5. Extras
- [ ] WebVTT subtitles / captions
- [ ] Playlists / queue (next / previous)
- [ ] Keyboard shortcuts
- [ ] Native MPEG-DASH via dash.js + a quality selector
- [ ] Passthrough / AR (`immersive-ar`) for mixed-reality viewing
- [ ] Theming / skinning API + i18n
