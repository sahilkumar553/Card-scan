const express = require('express');
const path = require('path');
const os = require('os');
const fs = require('fs');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const localtunnel = require('localtunnel');
const vision = require('@google-cloud/vision');

const app = express();
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 5 * 60 * 1000;
const MAX_CARD_DIGITS = 16;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const LOCAL_VISION_KEY_PATH = path.join(__dirname, 'vision-key.json');

app.set('trust proxy', true);
app.disable('x-powered-by');

app.use((req, res, next) => {
  if (!IS_PRODUCTION) {
    next();
    return;
  }

  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  if (forwardedProto && forwardedProto !== 'https') {
    return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  }

  return next();
});

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://code.jquery.com'],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      fontSrc: ["'self'", 'https:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  referrerPolicy: { policy: 'no-referrer' },
  hsts: IS_PRODUCTION
    ? { maxAge: 15552000, includeSubDomains: true, preload: true }
    : false
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const sessionRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many session requests. Try again shortly.' }
});

const scanRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many scan requests. Slow down and retry.' }
});

const pollingRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 180,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many polling requests. Try again shortly.' }
});

app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use(express.static(PUBLIC_DIR));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/scanner', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'scanner.html'));
});

app.get('/scanner.html', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'scanner.html'));
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowedMimeTypes = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
    if (!allowedMimeTypes.has((file.mimetype || '').toLowerCase())) {
      cb(new Error('Unsupported file type. Please upload JPEG, PNG, or WEBP image.'));
      return;
    }

    cb(null, true);
  }
});

// Configure Vision client (production requires explicit credential configuration)
const hasGoogleAppCredentials = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
const hasLocalVisionKey = fs.existsSync(LOCAL_VISION_KEY_PATH);

if (IS_PRODUCTION && !hasGoogleAppCredentials) {
  throw new Error('GOOGLE_APPLICATION_CREDENTIALS must be set in production.');
}

if (!hasGoogleAppCredentials && !hasLocalVisionKey) {
  throw new Error('Google Vision credential not found. Set GOOGLE_APPLICATION_CREDENTIALS or provide local vision-key.json for development.');
}

const client = new vision.ImageAnnotatorClient(
  hasGoogleAppCredentials
    ? {}
    : { keyFilename: LOCAL_VISION_KEY_PATH }
);

// In-memory session store: sessionId -> { createdAt, expiresAt, status, data }
const scanSessions = new Map();
let runtimeTunnelUrl = '';
let tunnelInstance = null;

function getLocalIPv4() {
  const interfaces = os.networkInterfaces();

  for (const networkName of Object.keys(interfaces)) {
    const addresses = interfaces[networkName] || [];

    for (const address of addresses) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }

  return null;
}

function getPublicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) {
    try {
      return new URL(process.env.PUBLIC_BASE_URL).toString().replace(/\/$/, '');
    } catch (_error) {
      return '';
    }
  }

  if (runtimeTunnelUrl) {
    return runtimeTunnelUrl.replace(/\/$/, '');
  }

  if (IS_PRODUCTION) {
    return '';
  }

  const hostHeader = (req.get('host') || '').toLowerCase();
  const isLocalhostHost =
    hostHeader.startsWith('localhost') ||
    hostHeader.startsWith('127.0.0.1') ||
    hostHeader.startsWith('[::1]');

  if (isLocalhostHost) {
    const localIp = getLocalIPv4();
    if (localIp) {
      return `http://${localIp}:${PORT}`;
    }
  }

  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const protocol = forwardedProto || req.protocol;

  return `${protocol}://${req.get('host')}`;
}

async function startAutoTunnelIfEnabled() {
  if (process.env.AUTO_TUNNEL !== 'true') {
    return;
  }

  try {
    tunnelInstance = await localtunnel({ port: PORT });
    runtimeTunnelUrl = tunnelInstance.url;
    console.log(`Secure tunnel active: ${runtimeTunnelUrl}`);

    tunnelInstance.on('error', (error) => {
      console.error(`Secure tunnel error: ${error.message}`);
      runtimeTunnelUrl = '';
    });

    tunnelInstance.on('close', () => {
      runtimeTunnelUrl = '';
      tunnelInstance = null;
      console.log('Secure tunnel closed.');
    });
  } catch (error) {
    console.error(`Failed to start secure tunnel: ${error.message}`);
  }
}

async function closeTunnel() {
  if (tunnelInstance) {
    try {
      await tunnelInstance.close();
    } catch (error) {
      console.error(`Error while closing tunnel: ${error.message}`);
    }
    tunnelInstance = null;
    runtimeTunnelUrl = '';
  }
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, session] of scanSessions.entries()) {
    if (session.expiresAt <= now) {
      scanSessions.delete(sessionId);
    }
  }
}

setInterval(cleanupExpiredSessions, 30_000);

function normalizeDigitLikeText(text) {
  return text
    .toUpperCase()
    .replace(/[OQD]/g, '0')
    .replace(/[IL|]/g, '1')
    .replace(/S/g, '5')
    .replace(/B/g, '8')
    .replace(/Z/g, '2')
    .replace(/G/g, '6');
}

function luhnCheck(cardNumber) {
  let sum = 0;
  let shouldDouble = false;

  for (let index = cardNumber.length - 1; index >= 0; index -= 1) {
    let digit = Number(cardNumber[index]);

    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }

    sum += digit;
    shouldDouble = !shouldDouble;
  }

  return sum % 10 === 0;
}

function detectCardType(cardNumber) {
  const bin = cardNumber.replace(/\D/g, '');

  if (/^4/.test(bin)) return 'VISA';
  if (/^(5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/.test(bin)) return 'MASTERCARD';
  if (/^(60|65|81|82|508)/.test(bin)) return 'RUPAY';
  if (/^3[47]/.test(bin)) return 'AMEX';
  if (/^6(?:011|5)/.test(bin)) return 'DISCOVER';

  return 'UNKNOWN';
}

function extractCardNumber(rawText) {
  const compactText = normalizeDigitLikeText(rawText);
  const candidateGroups = compactText.match(/(?:\d[ -]?){13,16}/g) || [];

  for (const group of candidateGroups) {
    const digits = group.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= MAX_CARD_DIGITS && luhnCheck(digits)) {
      return digits;
    }
  }

  const allDigits = compactText.replace(/\D/g, '');
  for (let start = 0; start <= allDigits.length - 13; start += 1) {
    const maxLength = Math.min(MAX_CARD_DIGITS, allDigits.length - start);
    for (let len = maxLength; len >= 13; len -= 1) {
      const candidate = allDigits.slice(start, start + len);
      if (luhnCheck(candidate)) return candidate;
    }
  }

  return '';
}

function extractExpiry(rawText) {
  const lines = (rawText || '')
    .toUpperCase()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const dateRegex = /([0O][1-9]|1[0-2])\s*[-\/]\s*([0-9OQDIL|SBZG]{2,4})/g;
  const thruKeywordRegex = /(VALID\s*THRU|VALIDTHRU|THRU|THROUGH|\bEXP\b|EXPIRY|EXPIRES?|MM\s*\/?\s*YY|MONTH\s*\/?\s*YEAR)/;
  const fromKeywordRegex = /(VALID\s*FROM|VALIDFROM|\bFROM\b|ISSUED?|SINCE|START)/;

  function normalizeDateDigits(value) {
    return (value || '')
      .replace(/[OQD]/g, '0')
      .replace(/[IL|]/g, '1')
      .replace(/S/g, '5')
      .replace(/B/g, '8')
      .replace(/Z/g, '2')
      .replace(/G/g, '6');
  }

  function toExpiry(monthRaw, yearRaw) {
    const month = normalizeDateDigits(monthRaw);
    const yearClean = normalizeDateDigits(yearRaw);
    if (!/^(0[1-9]|1[0-2])$/.test(month)) return '';
    if (!/^\d{2,4}$/.test(yearClean)) return '';
    const year = yearClean.length === 4 ? yearClean.slice(-2) : yearClean;
    return `${month}/${year}`;
  }

  function collectDateMatches(line) {
    const matches = [];
    let match = dateRegex.exec(line);
    while (match) {
      const expiry = toExpiry(match[1], match[2]);
      if (expiry) {
        matches.push({
          expiry,
          index: match.index
        });
      }
      match = dateRegex.exec(line);
    }
    dateRegex.lastIndex = 0;
    return matches;
  }

  function getPositions(line, regex) {
    const matches = [];
    const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
    const instance = new RegExp(regex.source, flags);
    let match = instance.exec(line);

    while (match) {
      matches.push(match.index);
      match = instance.exec(line);
    }

    return matches;
  }

  function nearestDistance(target, positions) {
    if (!positions.length) return Number.POSITIVE_INFINITY;
    return Math.min(...positions.map((position) => Math.abs(target - position)));
  }

  function compareExpiry(a, b) {
    const [aMonth, aYear] = a.expiry.split('/').map(Number);
    const [bMonth, bYear] = b.expiry.split('/').map(Number);

    if (aYear !== bYear) return bYear - aYear;
    return bMonth - aMonth;
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sameLineDates = collectDateMatches(line);
    const hasFrom = fromKeywordRegex.test(line);
    const hasThru = thruKeywordRegex.test(line);

    if (hasFrom && hasThru && sameLineDates.length >= 2) {
      return sameLineDates[sameLineDates.length - 1].expiry;
    }

    const nextLine = index + 1 < lines.length ? lines[index + 1] : '';
    const nextLineDates = nextLine ? collectDateMatches(nextLine) : [];
    if (hasFrom && hasThru && !sameLineDates.length && nextLineDates.length >= 2) {
      return nextLineDates[nextLineDates.length - 1].expiry;
    }
  }

  const candidates = [];

  lines.forEach((line, lineIndex) => {
    const thruPositions = getPositions(line, thruKeywordRegex);
    const fromPositions = getPositions(line, fromKeywordRegex);
    const prevLine = lineIndex > 0 ? lines[lineIndex - 1] : '';
    const nextLine = lineIndex + 1 < lines.length ? lines[lineIndex + 1] : '';

    let match = dateRegex.exec(line);
    while (match) {
      const expiry = toExpiry(match[1], match[2]);
      if (!expiry) {
        match = dateRegex.exec(line);
        continue;
      }

      const position = match.index;

      let score = 0;

      const thruDistance = nearestDistance(position, thruPositions);
      const fromDistance = nearestDistance(position, fromPositions);

      if (Number.isFinite(thruDistance)) {
        score += Math.max(0, 80 - thruDistance);
      }

      if (Number.isFinite(fromDistance)) {
        score -= Math.max(0, 90 - fromDistance);
      }

      if (thruPositions.length && position >= Math.min(...thruPositions)) {
        score += 16;
      }

      if (fromPositions.length && position >= Math.min(...fromPositions)) {
        score -= 24;
      }

      if (prevLine) {
        if (thruKeywordRegex.test(prevLine)) score += 22;
        if (fromKeywordRegex.test(prevLine)) score -= 18;
      }

      if (nextLine) {
        if (thruKeywordRegex.test(nextLine)) score += 8;
        if (fromKeywordRegex.test(nextLine)) score -= 8;
      }

      candidates.push({
        expiry,
        score,
        lineIndex,
        position
      });

      match = dateRegex.exec(line);
    }

    dateRegex.lastIndex = 0;
  });

  if (!candidates.length) return '';

  if (candidates.length > 1) {
    const latest = [...candidates].sort(compareExpiry)[0];
    return latest.expiry;
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.lineIndex !== a.lineIndex) return b.lineIndex - a.lineIndex;
    return b.position - a.position;
  });

  return candidates[0].expiry;
}

function extractCardholderName(rawText) {
  const blockedWords = new Set([
    'VALID','THRU','THROUGH','FROM','MONTH','YEAR','EXP','EXPIRES',
    'CARD','DEBIT','CREDIT','BANK','VISA','MASTERCARD','RUPAY',
    'AMEX',
    'DISCOVER',
    'PLATINUM',
    'SIGNATURE',
    'CLASSIC',
    'GOLD',
    'WORLD',
    'ELECTRON',
    'PAY',
    'MEMBER',
    'SINCE',
    'CORP',
    'LIMITED',
    'LTD',
    'PRIVATE',
    'BUSINESS',
    'AZADI',
    'AMRIT',
    'MAHOTSAV',
    'INDIA'
  ]);

  const removablePrefixes = new Set(['MR', 'MRS', 'MS', 'MISS', 'DR', 'SHRI', 'SMT']);
  const lines = rawText
    .toUpperCase()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const anchorIndices = [];
  const anchorPattern = /(VALID|THRU|THROUGH|EXP|MONTH|YEAR|MM\/?YY|DEBIT|CREDIT|CARD)/;
  const cardNumberIndices = [];
  const expiryIndices = [];

  lines.forEach((line, index) => {
    if (anchorPattern.test(line) || /(0[1-9]|1[0-2])\s*[\/-]\s*(\d{2}|\d{4})/.test(line)) {
      anchorIndices.push(index);
    }

    const digitsOnly = line.replace(/\D/g, '');
    if (digitsOnly.length >= 13 && digitsOnly.length <= MAX_CARD_DIGITS) {
      cardNumberIndices.push(index);
    }

    if (/(0[1-9]|1[0-2])\s*[\/-]\s*(\d{2}|\d{4})/.test(line)) {
      expiryIndices.push(index);
    }
  });

  function normalizeNameLine(line) {
    return line
      .replace(/[0]/g, 'O')
      .replace(/[1]/g, 'I')
      .replace(/[5]/g, 'S')
      .replace(/[8]/g, 'B')
      .replace(/[^A-Z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  let bestCandidate = '';
  let bestScore = Number.NEGATIVE_INFINITY;

  lines.forEach((line, index) => {
    const normalized = normalizeNameLine(line);
    if (!normalized || normalized.length < 5 || normalized.length > 40) return;

    let words = normalized.split(' ').filter(Boolean);
    if (!words.length) return;

    if (removablePrefixes.has(words[0])) {
      words = words.slice(1);
    }

    if (words.length < 2 || words.length > 4) return;
    if (words.some((word) => word.length < 2 || word.length > 14)) return;
    if (words.some((word) => blockedWords.has(word))) return;

    const hasVowels = words.every((word) => /[AEIOU]/.test(word));
    if (!hasVowels) return;

    let score = 0;
    const fullName = words.join(' ');

    if (words.length === 2 || words.length === 3) score += 5;
    if (words.length === 4) score += 2;

    const avgLen = fullName.replace(/\s/g, '').length / words.length;
    if (avgLen >= 3 && avgLen <= 8) score += 3;

    if (/^[A-Z\s]+$/.test(fullName)) score += 2;

    if (anchorIndices.length) {
      const minDistance = Math.min(...anchorIndices.map((anchorIndex) => Math.abs(anchorIndex - index)));
      if (minDistance <= 2) score += 3;
      else if (minDistance <= 4) score += 1;
    }

    if (cardNumberIndices.length) {
      const nearestCardIndex = cardNumberIndices.reduce((closest, current) => (
        Math.abs(current - index) < Math.abs(closest - index) ? current : closest
      ));

      if (index > nearestCardIndex && index - nearestCardIndex <= 6) score += 4;
      if (index < nearestCardIndex) score -= 2;
    }

    if (expiryIndices.length) {
      const nearestExpiryIndex = expiryIndices.reduce((closest, current) => (
        Math.abs(current - index) < Math.abs(closest - index) ? current : closest
      ));

      if (index > nearestExpiryIndex && index - nearestExpiryIndex <= 4) score += 3;
    }

    if (/([A-Z])\1{2,}/.test(fullName)) score -= 3;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = fullName;
    }
  });

  return bestScore > 0 ? bestCandidate : '';
}

async function runVisionOCR(imageBuffer) {
  const [result] = await client.documentTextDetection({
    image: { content: imageBuffer.toString('base64') }
  });

  return result.fullTextAnnotation?.text || '';
}

function maskCardNumber(cardNumber) {
  if (!cardNumber || cardNumber.length < 4) return '';
  return `•••• •••• •••• ${cardNumber.slice(-4)}`;
}

app.post('/api/session', sessionRateLimiter, async (req, res) => {
  try {
    cleanupExpiredSessions();

    const sessionId = uuidv4();
    const createdAt = Date.now();
    const expiresAt = createdAt + SESSION_TTL_MS;

    scanSessions.set(sessionId, {
      createdAt,
      expiresAt,
      status: 'pending',
      data: null
    });

    const baseUrl = getPublicBaseUrl(req);
    if (!baseUrl) {
      return res.status(500).json({
        ok: false,
        error: 'PUBLIC_BASE_URL must be configured for secure hosted deployment.'
      });
    }

    const desktopUrl = `${baseUrl}/?sessionId=${encodeURIComponent(sessionId)}&autopoll=1`;
    const mobileUrl = `${baseUrl}/scanner.html?sessionId=${encodeURIComponent(sessionId)}&returnTo=${encodeURIComponent(desktopUrl)}`;
    const qrDataUrl = await QRCode.toDataURL(mobileUrl, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 260
    });

    res.json({
      ok: true,
      sessionId,
      mobileUrl,
      desktopUrl,
      qrCode: qrDataUrl,
      expiresInSec: Math.floor(SESSION_TTL_MS / 1000)
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/scan', scanRateLimiter, upload.single('cardImage'), async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing sessionId' });

    const session = scanSessions.get(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found/expired' });
    if (session.expiresAt <= Date.now()) {
      scanSessions.delete(sessionId);
      return res.status(410).json({ ok: false, error: 'Session expired' });
    }

    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, error: 'No image uploaded' });
    }

    const ocrText = await runVisionOCR(req.file.buffer);
    const cardNumber = extractCardNumber(ocrText);
    const expiryDate = extractExpiry(ocrText);
    const cardholderName = extractCardholderName(ocrText);

    if (!cardNumber) {
      return res.status(422).json({
        ok: false,
        error: 'Card number not detected. Please capture again with better lighting.'
      });
    }

    if (cardNumber.length > MAX_CARD_DIGITS) {
      return res.status(422).json({
        ok: false,
        error: 'Card number must be 16 digits or less.'
      });
    }

    const cardType = detectCardType(cardNumber);

    session.status = 'ready';
    session.data = {
      cardNumber,
      maskedCardNumber: maskCardNumber(cardNumber),
      cardholderName,
      expiryDate,
      cardType,
      scannedAt: new Date().toISOString(),
      deliveredAt: null
    };

    res.json({
      ok: true,
      message: 'Card scanned successfully',
      data: {
        maskedCardNumber: session.data.maskedCardNumber,
        cardholderName: session.data.cardholderName,
        expiryDate: session.data.expiryDate,
        cardType: session.data.cardType
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Scan failed' });
  }
});

app.get('/api/get-data', pollingRateLimiter, (req, res) => {
  cleanupExpiredSessions();

  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing sessionId' });

  const session = scanSessions.get(sessionId);
  if (!session) return res.status(404).json({ ok: false, error: 'Session not found/expired' });

  if (session.expiresAt <= Date.now()) {
    scanSessions.delete(sessionId);
    return res.status(410).json({ ok: false, error: 'Session expired' });
  }

  if (session.status !== 'ready' || !session.data) {
    return res.json({ ok: true, status: 'pending' });
  }

  const payload = {
    ok: true,
    status: 'ready',
    data: session.data
  };

  if (session.data && !session.data.deliveredAt) {
    session.data.deliveredAt = new Date().toISOString();
  }

  return res.json(payload);
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'card-scanner',
    activeSessions: scanSessions.size,
    secureTunnelUrl: runtimeTunnelUrl || process.env.PUBLIC_BASE_URL || null
  });
});

app.use((error, _req, res, next) => {
  if (!error) {
    next();
    return;
  }

  if (error instanceof multer.MulterError) {
    res.status(400).json({ ok: false, error: error.message });
    return;
  }

  if (error.message && /Unsupported file type/i.test(error.message)) {
    res.status(400).json({ ok: false, error: error.message });
    return;
  }

  next(error);
});

app.use((error, _req, res, _next) => {
  const message = IS_PRODUCTION ? 'Internal server error' : (error.message || 'Internal server error');
  res.status(500).json({ ok: false, error: message });
});

const server = app.listen(PORT, async () => {
  const localIp = getLocalIPv4();
  console.log(`Card scanner server running at http://localhost:${PORT}`);
  if (localIp) {
    console.log(`Mobile access URL: http://${localIp}:${PORT}`);
  }
  if (process.env.PUBLIC_BASE_URL) {
    console.log(`Using PUBLIC_BASE_URL for QR: ${process.env.PUBLIC_BASE_URL}`);
  }
  await startAutoTunnelIfEnabled();
});

process.on('SIGINT', async () => {
  await closeTunnel();
  server.close(() => process.exit(0));
});

process.on('SIGTERM', async () => {
  await closeTunnel();
  server.close(() => process.exit(0));
});
