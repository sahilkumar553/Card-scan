# Card Scanner (Desktop + Mobile OCR)

QR-based desktop-mobile card scanner using Google Vision OCR.

## What this project does

- Desktop page shows a card form and opens a QR session.
- Mobile page opens camera, captures card frames, and uploads images.
- Server extracts card number, expiry, name, and type from OCR text.
- Desktop polls session status and autofills when scan is ready.

## Tech stack

- Node.js + Express
- Multer (in-memory image upload)
- Google Cloud Vision (`@google-cloud/vision`)
- QR generation (`qrcode`)
- Tunnel support (`localtunnel`)
- Frontend: HTML/CSS + jQuery

## Project structure

- `server.js` - API server, session state, OCR parsing, tunnel logic
- `public/index.html` - desktop form + scan QR modal
- `public/index.js` - desktop polling/autofill flow
- `public/scanner.html` - mobile scanner page
- `public/scanner.js` - camera capture + real-time upload loop
- `public/style.css` - shared UI styles
- `vision-key.json` - local Google Vision service account key (fallback)

## Setup

### 1) Install dependencies

```bash
npm install
```

### 2) Configure Google Vision credentials

You can use either option:

- Environment variable:
  - `GOOGLE_APPLICATION_CREDENTIALS=/absolute/path/to/key.json`
- Local fallback file:
  - place key as `vision-key.json` in project root

### 3) Start app

```bash
npm start
```

Opens at:

- `http://localhost:3000`

## Secure production hosting (recommended: Render)

This app should be hosted behind HTTPS so mobile camera access works reliably.

### 1) Prepare repository securely

- Ensure secrets are not committed (`.gitignore` includes `vision-key.json` and `.env*`)
- If `vision-key.json` was ever committed, rotate the key in GCP and remove history exposure
- Keep `PUBLIC_BASE_URL` and credential paths in host environment variables

### 2) Deploy on Render

- Push this project to GitHub
- Create a new **Web Service** from the repo
- Render picks up `render.yaml` automatically
- Configure a secret file in Render:
  - Upload GCP service-account key as `gcp-vision-key.json`
  - Mount path: `/etc/secrets/gcp-vision-key.json`
- Set required env vars:
  - `NODE_ENV=production`
  - `PUBLIC_BASE_URL=https://<your-service>.onrender.com`
  - `GOOGLE_APPLICATION_CREDENTIALS=/etc/secrets/gcp-vision-key.json`

### 3) Verify production security

- Visit `https://<your-service>.onrender.com/api/health`
- Confirm desktop and mobile flows work over HTTPS
- Confirm QR links open your `PUBLIC_BASE_URL` domain
- Check API responses still return expected status codes for invalid uploads/sessions

### 4) Optional hardening for enterprise use

- Put Cloudflare in front of Render for WAF + bot mitigation + DDoS controls
- Restrict Google service account permissions to Vision API only
- Rotate service-account keys on a schedule and after any suspected leak
- Add centralized logging/alerting for repeated 4xx/5xx spikes

## Tunnel options (for mobile camera over HTTPS)

### Auto tunnel with localtunnel

```bash
npm run start:tunnel
```

Behavior:

- Starts server with `AUTO_TUNNEL=true`
- Exposes public URL used in generated QR links
- Health endpoint reports current tunnel in `secureTunnelUrl`

### Cloudflare tunnel (manual)

```bash
npm run tunnel:cloudflare
```

Use when localtunnel is unstable or blocked.

## API reference

### `POST /api/session`

Creates a scan session and returns desktop/mobile connection details.

Response shape:

- `ok`
- `sessionId`
- `mobileUrl`
- `qrCode` (data URL)
- `expiresInSec`

### `POST /api/scan`

Uploads a card image for OCR.

Request:

- multipart/form-data
- `sessionId`
- `cardImage` (jpeg/png)

Success response:

- `ok`
- `message`
- `data.maskedCardNumber`
- `data.cardholderName`
- `data.expiryDate`
- `data.cardType`

Possible errors:

- `400` missing session/image
- `404` session not found
- `410` session expired
- `422` card number not detected/invalid

### `GET /api/get-data?sessionId=...`

Desktop polling endpoint.

Responses:

- pending: `{ ok: true, status: "pending" }`
- ready: `{ ok: true, status: "ready", data: ... }`

### `GET /api/health`

Service diagnostics.

Includes:

- `ok`
- `service`
- `activeSessions`
- `secureTunnelUrl`

## Session lifecycle

1. Desktop requests `POST /api/session`
2. QR encodes `scanner.html?sessionId=...`
3. Mobile scans and repeatedly posts frames to `POST /api/scan`
4. Server stores parsed result in in-memory `scanSessions`
5. Desktop polls `GET /api/get-data` every 1.5s
6. On `ready`, desktop autofills and stops polling

Notes:

- Session TTL is 5 minutes (`SESSION_TTL_MS`)
- Expired sessions are cleaned every 30s

## OCR parsing rules

### Card number

- OCR text normalization maps lookalike characters (`O->0`, `I->1`, etc.)
- Detects candidates of 13-16 digits
- Validates with Luhn check
- Strict hard limit: maximum 16 digits (`MAX_CARD_DIGITS`)

### Expiry date

- Parses `MM/YY` or `MM/YYYY` patterns (also OCR lookalike digits)
- Handles cards with both `VALID FROM` and `VALID THRU`
- Prioritizes expiry contexts (`THRU`, `EXP`, `EXPIRES`)
- If multiple date candidates are present, picks the latest date

### Cardholder name

- Scores uppercase multi-word name candidates from OCR lines
- Filters blocked/issuer words and noisy tokens
- Uses proximity to card anchors (number/expiry labels)

### Card type detection

- Prefix-based detection for: `VISA`, `MASTERCARD`, `RUPAY`, `AMEX`, `DISCOVER`

## Frontend behavior

### Desktop (`public/index.js`)

- Opens QR modal
- Polls server until scan result is ready
- Applies card type badge/icon
- Enforces max 16 digits for card number input and autofill formatting

### Mobile scanner (`public/scanner.js`)

- Requires secure context (HTTPS) for camera access
- Captures centered card frame from video stream
- Sends compressed JPEG frames on interval
- Stops on success and prompts user to close page

## Known limitations

- Sessions are in-memory only (reset on server restart)
- OCR accuracy depends on lighting/focus/glare
- localtunnel can be unstable in some networks/firewalls

## Troubleshooting

### Port already in use (`EADDRINUSE`)

- Kill process on `3000` and restart
- Or run on a different port via env var

### Tunnel shows 503 or disconnects

- Restart `npm run start:tunnel`
- Use fresh URL from `GET /api/health`
- Switch to Cloudflare tunnel if localtunnel is blocked

### Camera not opening on phone

- Use HTTPS tunnel URL, not localhost
- Confirm camera permission in browser settings
- Try Chrome/Safari latest versions

## Security notes

- Never commit real production credential files
- Use least-privilege service accounts for Vision API
- Rotate keys if exposed
- In production, always set `PUBLIC_BASE_URL` to your HTTPS domain
