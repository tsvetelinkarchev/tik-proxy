/**
 * TIK Bot — Binance API Proxy Server v1.1
 * =========================================
 * Uses only built-in Node.js modules — no node-fetch needed.
 * Zero dependency issues across all Node versions.
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const https    = require('https');
const app      = express();

const PORT           = process.env.PORT || 3001;
const BINANCE_HOST   = 'api.binance.com';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

const ALLOWED_PATHS = [
  '/api/v3/ping', '/api/v3/time', '/api/v3/ticker/price',
  '/api/v3/ticker/24hr', '/api/v3/depth', '/api/v3/account',
  '/api/v3/openOrders', '/api/v3/myTrades', '/api/v3/order',
  '/api/v3/allOrders', '/api/v3/exchangeInfo',
];

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

const requestCounts = new Map();
function rateLimitCheck(ip) {
  const now   = Date.now();
  const entry = requestCounts.get(ip) || { count: 0, reset: now + 60000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60000; }
  entry.count++;
  requestCounts.set(ip, entry);
  return entry.count <= 60;
}

function makeRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: { msg: data } }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

app.all('/proxy/*', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (!rateLimitCheck(ip)) return res.status(429).json({ msg: 'Rate limit exceeded' });

  const path = '/' + req.params[0];
  if (!ALLOWED_PATHS.some(p => path.startsWith(p)))
    return res.status(403).json({ msg: `Endpoint not whitelisted: ${path}` });

  const apiKey  = req.headers['x-mbx-apikey'];
  const query   = new URLSearchParams(req.query).toString();
  const fullPath = path + (query ? '?' + query : '');
  const headers  = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-MBX-APIKEY'] = apiKey;

  let bodyStr;
  if (['POST','PUT','DELETE'].includes(req.method) && req.body) {
    bodyStr = new URLSearchParams(req.body).toString();
    headers['Content-Type']   = 'application/x-www-form-urlencoded';
    headers['Content-Length'] = Buffer.byteLength(bodyStr);
  }

  try {
    const result = await makeRequest({ hostname: BINANCE_HOST, path: fullPath, method: req.method, headers }, bodyStr);
    console.log(`[${new Date().toISOString()}] ${req.method} ${path} → ${result.status}`);
    res.status(result.status).json(result.body);
  } catch (e) {
    console.error(`Proxy error: ${e.message}`);
    res.status(500).json({ msg: `Proxy error: ${e.message}` });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString(), version: '1.1' });
});

app.listen(PORT, () => {
  console.log(`TIK Proxy v1.1 running on port ${PORT}`);
  console.log(`Allowed origin: ${ALLOWED_ORIGIN}`);
});
