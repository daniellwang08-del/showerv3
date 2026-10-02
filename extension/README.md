# Job Application Assistant - Browser Extension

Manifest V3 side-panel for [NAO](https://atomspace.it.com/). Sign in with
your account, cache profile/settings, and autofill applications with AI help.

No build step. Load this folder unpacked in Chrome/Edge.

## Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select this `extension/` folder
4. Open the side panel from the toolbar icon

## Sign in

- Default API/dashboard origin is `https://atomspace.it.com` (`config.js`).
- Opening the dashboard syncs that origin automatically.
- On first sign-in Chrome asks for permission to the server origin.
- After a domain change, reload the extension: a stored origin that no longer
  matches `config.js` is discarded on the next read (`src/store.js`).

## CORS (production)

Production must allow the extension origin (id is fixed by the manifest `key`):

```
FRONTEND_URL=https://atomspace.it.com
CORS_EXTRA_ORIGINS=chrome-extension://leemdaklomjjbdfmaepplhpbeomhifmn
```

## Local development

Temporarily set `DEFAULT_BACKEND_URL` in `config.js` to your Vite URL
(e.g. `http://localhost:5173` or `http://<lan-ip>:5173`), reload the
extension, and open the dashboard once so it syncs.

## Files

- `manifest.json` — MV3 permissions + dashboard content script matches
- `config.js` — `DEFAULT_BACKEND_URL`
- `background.js` — side panel + bridge injection
- `src/store.js` / `src/api.js` / `src/app.js` — auth, API, UI
- `content/` — autofill engines + webapp bridge
