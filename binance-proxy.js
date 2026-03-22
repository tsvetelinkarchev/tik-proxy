/**
 * TIK Bot — Binance API Proxy Server
 * ====================================
 * Required for LIVE mode. Browsers cannot call Binance directly
 * due to CORS restrictions. This thin proxy forwards signed requests.
 *
 * SETUP:
 *   npm install express cors node-fetch dotenv
 *   node binance-proxy.js
 *
 * DEPLOY (pick one):
 *   Railway:  railway up
 *   Render:   render deploy
 *   Fly.io:   fly launch
 *   VPS:      pm2 start binance-proxy.js
 *
 * SECURITY:
 *   - API keys are sent from the browser in request headers
 *   - Keys are NEVER stored on this server
 *   - Only whitelisted Binance endpoints are forwarded
 *   - Rate limiting enforced (60 req/min)
 *   - CORS restricted to your dashboard domain
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const app      = express();

// ── Config ──
const PORT          = process.env.PORT || 3001;
const BINANCE_BASE  = 'https://api.binance.com';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // Set to your dashboard URL in prod

// ── Whitelisted endpoints (security) ──
const ALLOWED_PATHS = [
  '/api/v3/ping',
  '/api/v3/time',
  '/api/v3/ticker/price',
  '/api/v3/ticker/24hr',
  '/api/v3/depth',
  '/api/v3/account',
  '/api/v3/openOrders',
  '/api/v3/myTrades',
  '/api/v3/order',
  '/api/v3/allOrders',
  '/api/v3/exchangeInfo',
  '/fapi/v2/account',       // futures
  '/fapi/v1/positionRisk',  // futures positions
];

// ── Middleware ──
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// ── Rate limiter ──
const requestCounts = new Map();
function rateLimitCheck(ip) {
  const now   = Date.now();
  const entry = requestCounts.get(ip) || { count:0, reset: now+60000 };
  if (now > entry.reset) { entry.count=0; entry.reset=now+60000; }
  entry.count++;
  requestCounts.set(ip, entry);
  return entry.count <= 60; // 60 req/min
}

// ── Proxy handler ──
app.all('/proxy/*', async (req, res) => {
  const ip   = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (!rateLimitCheck(ip)) {
    return res.status(429).json({ msg: 'Rate limit exceeded (60 req/min)' });
  }

  const path = '/' + req.params[0];
  if (!ALLOWED_PATHS.some(p => path.startsWith(p))) {
    return res.status(403).json({ msg: `Endpoint not whitelisted: ${path}` });
  }

  // Forward API key from request header
  const apiKey = req.headers['x-mbx-apikey'];
  const query  = new URLSearchParams(req.query).toString();
  const url    = `${BINANCE_BASE}${path}${query ? '?'+query : ''}`;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-MBX-APIKEY'] = apiKey;

  try {
    const binanceRes = await fetch(url, {
      method:  req.method,
      headers,
      body:    ['POST','PUT','DELETE'].includes(req.method) ? JSON.stringify(req.body) : undefined,
    });
    const data = await binanceRes.json();
    console.log(`[${new Date().toISOString()}] ${req.method} ${path} → ${binanceRes.status}`);
    res.status(binanceRes.status).json(data);
  } catch(e) {
    console.error(`Proxy error: ${e.message}`);
    res.status(500).json({ msg: `Proxy error: ${e.message}` });
  }
});

// ── Health check ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.0' });
});

app.listen(PORT, () => {
  console.log(`TIK Binance Proxy running on port ${PORT}`);
  console.log(`Allowed origin: ${ALLOWED_ORIGIN}`);
  console.log(`Binance base: ${BINANCE_BASE}`);
});
