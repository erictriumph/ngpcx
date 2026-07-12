# /branding

Generated from the CheckMyARM/NGPCX logo. Source note: `logo-source.svg` is
not a true vector file — it's an SVG wrapper around an embedded 817×817
raster PNG. All files below were generated from that native 817×817 image
via Lanczos resampling, so quality is good down to favicon sizes but this
817px file is the resolution ceiling if a much larger version is ever needed
(e.g. print).

## Favicon set (drop these in `public/`, reference from `<head>`)
- `favicon.ico` — multi-resolution (16/32/48px), the classic favicon
- `favicon-16x16.png`
- `favicon-32x32.png`
- `favicon-48x48.png`
- `apple-touch-icon.png` (180×180 — iOS home screen icon)
- `android-chrome-192x192.png`
- `android-chrome-512x512.png` (also usable as a PWA manifest icon)

Suggested `<head>` tags:
```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon-16x16.png" type="image/png" sizes="16x16">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
```

## General-purpose logo images (for use in page content, not browser chrome)
- `logo-64.png`, `logo-128.png`, `logo-256.png` — smaller working sizes
- `logo-master-817.png` — full native resolution, use for anything larger
- `logo-source.svg` — original file as provided, kept for reference

## Not yet done
- No dark/light variant — this logo was designed against a dark background
  and may need adjustment if used on a light-background page or context.
- No maskable/safe-zone version for Android adaptive icons (the 512px
  android-chrome file is a plain square, not inset for the maskable spec).
