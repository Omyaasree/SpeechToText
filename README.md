# Text to Speech

A static, client-side text-to-speech tool. Paste or upload text, pick a speed
(0.02x–2x), choose to read as natural sentences or word by word, and listen,
or click any word to jump playback there. Built on the browser-native Web
Speech API. No backend, no API keys, no build step.

## Run locally

Any static file server works, for example:

```bash
cd /path/to/tts-webapp
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Files

- `index.html` / `script.js` / `styles.css`: the app
- `privacy.html`, `terms.html`: legal pages (contain `[fill in]` placeholders
  you need to complete before launch: launch date, contact email, and whether
  you've added any analytics)
- `favicon.svg`, `favicon-32.png`, `icon-192.png`, `apple-touch-icon.png`: site
  icons at the sizes iOS, Android, and older browsers each expect

## Mobile / iOS / Android compliance

- Touch targets: every button, the voice `<select>`, and the range slider's
  thumb are sized to the 44x44 CSS px minimum both Apple's Human Interface
  Guidelines and Android's Material Design specify (also WCAG 2.5.5). Word
  spans in the read-along view are padded out for the same reason.
- No accidental zoom: the textarea and voice select use 16px type, the
  threshold below which iOS Safari auto-zooms on focus.
- Icons: `apple-touch-icon.png` (180x180) is what iOS uses for "Add to Home
  Screen"; `icon-192.png` and `favicon-32.png` cover Android and older
  browsers that don't support SVG favicons.
- `theme-color` meta tags (light/dark) tint the mobile browser chrome to
  match the page instead of showing a default color.
- `viewport-fit=cover` plus `env(safe-area-inset-*)` padding on the header,
  main content, and footer keeps content clear of the notch/home indicator
  on notched iPhones.
- `-webkit-tap-highlight-color: transparent` and `touch-action: manipulation`
  remove the gray tap flash and double-tap-to-zoom delay on buttons, links,
  and word spans.
- Verified at 320px (iPhone SE), 375px, and 320-768px widths in both light
  and dark color schemes: no horizontal overflow, no clipped controls.

## Before you launch

- [ ] Fill in the `[fill in ...]` placeholders in `privacy.html` and `terms.html`
- [ ] Connect a custom domain (see below)
- [ ] Confirm the favicon shows correctly in a browser tab
- [ ] Deploy and do a final click-through on the live URL

## Deploying + connecting a custom domain

This is a static site, so any static host works. Two common free options:

**Vercel**
1. `npm i -g vercel` then run `vercel` from this folder, or drag the folder into vercel.com's dashboard.
2. In the project's Settings → Domains, add your domain and follow the DNS records it gives you (add them at your domain registrar).

**Netlify**
1. Drag this folder into app.netlify.com/drop, or connect it via a Git repo.
2. In Site settings → Domain management, add your custom domain and follow the DNS instructions.

Either way, the domain itself has to be purchased through a registrar (Namecheap, Google Domains successor, Cloudflare, etc.). That's a purchase only you can make.

## Reading style: Sentences vs. Words

- **Sentences** speaks the text as one continuous utterance per playback,
  which sounds natural (proper intonation, pauses at punctuation). This is
  the default.
- **Words** speaks one word at a time, useful for close, deliberate
  listening. This is also what always runs below 0.1x, regardless of which
  option is selected, since the engine physically cannot speak that slowly
  in one continuous utterance.
- Switching either the reading style or the speed while something is already
  playing restarts seamlessly from the exact current word, at the new
  setting. Neither can change on audio already in flight, so under the hood
  this cancels and starts a fresh utterance from that position.

## Browser notes

- Playback speed and voice list depend on the browser/OS. Chrome, Edge, and Safari all support the Web Speech API; voice quality at slow speeds varies by voice, so it's worth testing a couple of voices in the dropdown to find the clearest one.
- Chrome has a long-standing bug where very long utterances stop after ~15 seconds; the app works around this with a periodic pause/resume, already implemented in `script.js`.
- The Web Speech API clamps `rate` to a minimum of 0.1x; the engine itself cannot physically speak slower than that. Below 0.1x, `script.js` speaks one word at a time at 0.1x and inserts silence between words to reach the requested pace (see the `RATE_FLOOR` / chunked-playback logic).
- **Sentences mode word highlighting on mobile is approximate.** The browser's
  `boundary` event, which reports which word is currently being spoken, is
  unreliable on mobile (iOS Safari essentially never fires it; Android
  Chrome is inconsistent). When it doesn't fire, `script.js` falls back to
  estimating position from elapsed time and the selected rate (see
  `startPositionEstimator`), which keeps highlighting and position tracking
  working but not perfectly in sync with the actual audio. Words mode doesn't
  have this problem since it tracks its own position exactly, word by word.
