/**
 * ═══════════════════════════════════════════════════════════════
 *  TIK BOT v3.0 — Crypto.com Exchange Integration
 *  Drop-in replacement for the exchange layer
 *
 *  API Docs: https://exchange-docs.crypto.com/exchange/v1/rest-ws/index.html
 *  Auth:     HMAC-SHA256 (same mechanism as Binance — easy migration)
 *  Base URL: https://api.crypto.com/exchange/v1
 *  Works in: Bulgaria ✅  EU Regulated ✅  No geo-restrictions ✅
 *
 *  HOW TO USE:
 *  1. In ai_trading_bot_dashboard.html, find <script>
 *  2. Remove everything from the Crypto.com section marker to </script>
 *  3. Paste the contents of this file before </script>
 *  4. Update your proxy: set BINANCE_BASE = 'https://api.crypto.com/exchange/v1'
 * ═══════════════════════════════════════════════════════════════
 */

'use strict';

// ══════════════════════════════════════════════════════════════════════
//  CRYPTO.COM EXCHANGE — CONNECTION LAYER
// ══════════════════════════════════════════════════════════════════════

const CDC_BASE  = 'https://api.crypto.com/exchange/v1';
const CDC_PROXY = 'https://tik-proxy-production.up.railway.app/proxy'; // ← your Railway URL
const USE_PROXY = true;

// Crypto.com instrument format: BTC_USDT (underscore separator)
const WATCH_SYMBOLS = [
  'BTC_USDT', 'ETH_USDT', 'SOL_USDT', 'BNB_USDT',
  'LINK_USDT', 'ADA_USDT', 'DOT_USDT', 'AVAX_USDT', 'XRP_USDT'
];

// In-memory key store — never written to localStorage or disk
const binanceKeys = { apiKey: null, secretKey: null };
let   binanceConnected  = false;
let   binanceWS         = null;
let   binanceWsActive   = false;
let   priceRefreshTimer = null;
const binanceLastPrices = {};

// Rate limit tracker
const rateLimit = {
  used: 0,
  resetAt: Date.now() + 60000,
  hits429: 0,
  backoffUntil: 0
};

// ── HMAC-SHA256 signing (Web Crypto API — same as Binance) ──
async function hmacSHA256(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── Build signed Crypto.com request body ──
// Crypto.com signs the entire JSON body, not a URL query string
async function buildSignedBody(method, params = {}) {
  const nonce    = Date.now().toString();
  const id       = Math.floor(Math.random() * 1000000);
  const paramStr = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  const sigStr   = `${method}${id}${binanceKeys.apiKey}${paramStr}${nonce}`;
  const sig      = await hmacSHA256(binanceKeys.secretKey, sigStr);

  return {
    id,
    method,
    api_key: binanceKeys.apiKey,
    params,
    nonce,
    sig,
  };
}

// ── Generic Crypto.com REST call ──
async function binanceREST(path, params = {}, method = 'GET', signed = false) {
  // Honour backoff
  if (Date.now() < rateLimit.backoffUntil) {
    const wait = rateLimit.backoffUntil - Date.now();
    addLog('warn', `Rate limit backoff: waiting ${(wait / 1000).toFixed(1)}s`);
    await new Promise(r => setTimeout(r, wait));
  }

  try {
    const base = USE_PROXY ? CDC_PROXY : CDC_BASE;

    let url, fetchOptions;

    if (method === 'GET') {
      // Public GET endpoints — no signing needed
      const q = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
      url = `${base}${path}${q}`;
      fetchOptions = { method: 'GET', headers: { 'Content-Type': 'application/json' } };
    } else {
      // Private POST endpoints — all private calls use POST + signed body
      url = `${base}${path}`;
      const body = signed ? await buildSignedBody(path.replace('/','').replace(/\//g,'.'), params) : { method: path, params };
      fetchOptions = {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      };
    }

    const res = await fetch(url, fetchOptions);

    // Track rate limit from headers
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining !== null) {
      rateLimit.used = 100 - parseInt(remaining || '100');
      updateRateLimitUI();
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('Retry-After') || '30');
      rateLimit.backoffUntil = Date.now() + retryAfter * 1000;
      rateLimit.hits429++;
      addLog('error', `Rate limited · backoff ${retryAfter}s`);
      showToast(`⚠️ Rate limited — waiting ${retryAfter}s`, 'error');
      throw new Error(`RATE_LIMITED_429: retry after ${retryAfter}s`);
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(`Crypto.com ${res.status}: ${err.message || err.msg || res.statusText}`);
    }

    const data = await res.json();

    // Crypto.com wraps responses: { id, method, code, result }
    // code 0 = success, anything else = error
    if (data.code !== undefined && data.code !== 0) {
      throw new Error(`Crypto.com API error ${data.code}: ${data.message || 'Unknown error'}`);
    }

    return data.result !== undefined ? data.result : data;

  } catch(e) {
    if (e.message.includes('Failed to fetch') || e.message.includes('NetworkError')) {
      throw new Error('CORS_BLOCKED: Proxy required. Deploy binance-proxy.js to Railway.');
    }
    throw e;
  }
}

function updateRateLimitUI() {
  const el = document.getElementById('binanceRateLimit');
  if (!el) return;
  const pct   = Math.min(100, rateLimit.used);
  const color = pct > 80 ? 'var(--red)' : pct > 60 ? 'var(--gold)' : 'var(--green)';
  el.innerHTML = `
    <div style="font-size:9px;color:var(--text3);margin-bottom:3px">API USAGE ${rateLimit.used}%</div>
    <div style="height:3px;background:var(--border);border-radius:2px">
      <div style="width:${pct}%;height:100%;background:${color};border-radius:2px;transition:width .5s"></div>
    </div>`;
}

// ══════════════════════════════════════════════════════════════════════
//  CONNECT / DISCONNECT
// ══════════════════════════════════════════════════════════════════════

async function connectBinance() {
  const apiKey    = document.getElementById('binanceApiKey').value.trim();
  const secretKey = document.getElementById('binanceSecretKey').value.trim();

  if (!apiKey || !secretKey) {
    showToast('⚠️ Enter both API Key and Secret Key', 'warn');
    return;
  }
  if (apiKey.length < 10 || secretKey.length < 10) {
    showToast('⚠️ Keys look too short — check for copy errors', 'warn');
    return;
  }

  binanceKeys.apiKey    = apiKey;
  binanceKeys.secretKey = secretKey;
  setBinanceStatus('connecting');
  addLog('info', 'Connecting to Crypto.com Exchange · Testing credentials…');

  try {
    // Test connection: fetch account summary (private endpoint)
    const result = await binanceREST(
      '/private/get-account-summary',
      {},
      'POST',
      true
    );
    // If we get here without throwing, credentials are valid
    onBinanceConnected({ result });
  } catch(e) {
    setBinanceStatus('error');
    binanceKeys.apiKey = binanceKeys.secretKey = null;
    addLog('error', `Crypto.com connect failed: ${e.message}`);
    showToast(`❌ Connection failed: ${e.message}`, 'error');
  }
}

let binanceHeartbeatTimer = null;
let binanceHeartbeatFails = 0;
const MAX_HEARTBEAT_FAILS = 3;

function onBinanceConnected(data) {
  binanceConnected      = true;
  binanceHeartbeatFails = 0;
  setBinanceStatus('connected');
  addLog('trade', '✅ Crypto.com Exchange connected · Fetching balances and prices…');

  fetchBinanceBalance();
  fetchBinancePrices();
  fetchOpenOrders();
  fetchRecentTrades();

  // Refresh prices every 5 seconds
  if (priceRefreshTimer) clearInterval(priceRefreshTimer);
  priceRefreshTimer = setInterval(fetchBinancePrices, 5000);

  // Heartbeat every 30s — ping the public ticker
  if (binanceHeartbeatTimer) clearInterval(binanceHeartbeatTimer);
  binanceHeartbeatTimer = setInterval(async () => {
    if (!binanceConnected) return;
    try {
      await binanceREST('/public/get-ticker', { instrument_name: 'BTC_USDT' }, 'GET', false);
      binanceHeartbeatFails = 0;
    } catch(e) {
      binanceHeartbeatFails++;
      addLog('warn', `Heartbeat fail #${binanceHeartbeatFails}/${MAX_HEARTBEAT_FAILS}: ${e.message.slice(0, 60)}`);
      if (binanceHeartbeatFails >= MAX_HEARTBEAT_FAILS) {
        addLog('error', 'Crypto.com connection lost — stopping bot');
        ENGINE.botActive = false;
        setBinanceStatus('error');
        showToast('⚠️ Crypto.com disconnected — bot stopped', 'error');
        clearInterval(binanceHeartbeatTimer);
        // Try to reconnect after 10 seconds
        setTimeout(() => {
          if (!binanceConnected) {
            addLog('info', 'Attempting automatic reconnect…');
            connectBinance();
          }
        }, 10000);
      }
    }
  }, 30000);
}

function disconnectBinance() {
  binanceConnected      = false;
  binanceKeys.apiKey    = binanceKeys.secretKey = null;
  binanceHeartbeatFails = 0;
  if (binanceHeartbeatTimer) { clearInterval(binanceHeartbeatTimer); binanceHeartbeatTimer = null; }
  if (priceRefreshTimer)     { clearInterval(priceRefreshTimer);     priceRefreshTimer     = null; }
  stopBinanceWebSocket();
  setBinanceStatus('disconnected');
  addLog('info', 'Crypto.com disconnected · Keys cleared from memory');
}

async function testBinancePing() {
  const t0  = Date.now();
  const btn = document.getElementById('binancePingBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    await binanceREST('/public/get-ticker', { instrument_name: 'BTC_USDT' }, 'GET', false);
    const ms = Date.now() - t0;
    showToast(`📡 Crypto.com ping: ${ms}ms`, 'success');
    addLog('info', `Ping: ${ms}ms · Crypto.com Exchange online`);
  } catch(e) {
    showToast(`❌ Ping failed: ${e.message.slice(0, 60)}`, 'error');
    addLog('error', `Ping failed: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📡 Ping'; }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  BALANCE
// ══════════════════════════════════════════════════════════════════════

async function fetchBinanceBalance() {
  if (!binanceConnected) return;
  try {
    const result = await binanceREST('/private/get-account-summary', {}, 'POST', true);

    // result.accounts is an array: [{ currency, balance, available, order, stake }]
    const accounts = result.accounts || [];
    const get = (currency) => {
      const a = accounts.find(a => a.currency === currency);
      return a ? parseFloat(a.available || 0) : 0;
    };

    const usdt = get('USDT');
    const btc  = get('BTC');
    const eth  = get('ETH');

    // Update Exchanges page balance boxes
    const usdtEl = document.getElementById('binanceUSDT');
    const btcEl  = document.getElementById('binanceBTC');
    const ethEl  = document.getElementById('binanceETH');
    if (usdtEl) usdtEl.textContent = usdt.toFixed(2);
    if (btcEl)  btcEl.textContent  = btc.toFixed(5);
    if (ethEl)  ethEl.textContent  = eth.toFixed(4);

    if (usdt > 0) {
      const prev  = userBalance;
      userBalance = usdt;

      // Sync hidden balance input
      const inp = document.getElementById('balanceInput');
      if (inp) inp.value = usdt.toFixed(2);

      // Update balance sync status on Dashboard
      const statusEl = document.getElementById('balanceSyncStatus');
      if (statusEl) {
        statusEl.textContent = `✅ Synced from Crypto.com · ${usdt.toFixed(2)} USDT`;
        statusEl.style.color = 'var(--green)';
      }

      // Show refresh button
      const refreshBtn = document.getElementById('balanceRefreshBtn');
      if (refreshBtn) refreshBtn.style.display = 'block';

      // Seed equity history on first sync
      if (prev <= 0 && equityHistory.length === 0) {
        equityHistory = [{ time: Date.now(), value: usdt }];
      }

      updatePnlStats();

      // Flash START BOT green to signal ready
      if (!ENGINE.botActive) {
        const botBtn = document.getElementById('botBtn');
        if (botBtn) {
          botBtn.style.boxShadow = '0 0 20px rgba(0,230,118,0.7)';
          setTimeout(() => { if (botBtn) botBtn.style.boxShadow = ''; }, 2500);
        }
        const stEl = document.getElementById('statusText');
        if (stEl) stEl.innerHTML = `<span style="color:var(--green)">BALANCE SYNCED · CLICK ▶ START BOT</span>`;
      }

      if (prev !== usdt) addLog('info', `Balance synced: ${usdt.toFixed(2)} USDT`);

    } else {
      const statusEl = document.getElementById('balanceSyncStatus');
      if (statusEl) {
        statusEl.textContent = '⚠️ No USDT balance found — deposit USDT to Crypto.com first';
        statusEl.style.color = 'var(--gold)';
      }
      addLog('warn', 'Crypto.com: 0 USDT balance — deposit funds before starting bot');
    }

    addLog('info', `Balances: USDT=${usdt.toFixed(2)} BTC=${btc.toFixed(5)} ETH=${eth.toFixed(4)}`);

  } catch(e) {
    addLog('error', `Balance fetch failed: ${e.message}`);
    const statusEl = document.getElementById('balanceSyncStatus');
    if (statusEl) {
      statusEl.textContent = `❌ Balance sync failed: ${e.message.slice(0, 50)}`;
      statusEl.style.color = 'var(--red)';
    }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  PRICES
// ══════════════════════════════════════════════════════════════════════

async function fetchBinancePrices() {
  if (!binanceConnected) return;
  const list = document.getElementById('binancePriceList');

  try {
    // Crypto.com: fetch all tickers in one call
    const result = await binanceREST('/public/get-tickers', {}, 'GET', false);
    const tickers = result.data || [];

    const prices = {};
    tickers.forEach(t => {
      if (WATCH_SYMBOLS.includes(t.i)) {
        prices[t.i] = parseFloat(t.a || t.k || 0); // ask price or last price
      }
    });

    // Render price list
    if (list && Object.keys(prices).length > 0) {
      list.innerHTML = Object.entries(prices).map(([sym, price]) => {
        const prev    = binanceLastPrices[sym] || price;
        const up      = price >= prev;
        const display = sym.replace('_USDT', '').replace('_', '/');
        const fmt     = price > 100 ? price.toFixed(2) : price.toFixed(4);
        binanceLastPrices[sym] = price;
        return `
          <div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid var(--border);font-size:10px">
            <span style="color:var(--text2)">${display}/USDT</span>
            <span style="color:${up ? 'var(--green)' : 'var(--red)'};font-weight:600">$${fmt} ${up ? '▲' : '▼'}</span>
          </div>`;
      }).join('');
    }

    // Update live position prices
    positions.filter(p => p.open).forEach(p => {
      const sym   = p.pair.replace('/', '_'); // BTC/USDT → BTC_USDT
      const price = prices[sym] || binanceLastPrices[sym];
      if (price) {
        p.current = price;
        p.pnl     = ((price - p.entry) / p.entry) * p.size * (p.dir === 'LONG' ? 1 : -1);
        p.toPct   = Math.min(100, Math.max(0, Math.abs(p.pnl) / (p.size * ENGINE.TP_PCT) * 100));
      }
    });

    setBinancePriceBadge('live');
    renderSlotGrid();
    renderPositionsTable();
    updatePositionCounters();
    updatePnlStats();

  } catch(e) {
    addLog('error', `Price fetch failed: ${e.message}`);
    setBinancePriceBadge('offline');
  }
}

// ══════════════════════════════════════════════════════════════════════
//  OPEN ORDERS
// ══════════════════════════════════════════════════════════════════════

async function fetchOpenOrders() {
  if (!binanceConnected) return;
  const tbody = document.getElementById('binanceOrdersTable');
  if (!tbody) return;
  try {
    const result = await binanceREST('/private/get-open-orders', {}, 'POST', true);
    const orders = result.order_list || [];

    tbody.innerHTML = orders.length === 0
      ? '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:16px">No open orders</td></tr>'
      : orders.map(o => `
          <tr>
            <td class="td-sym">${(o.instrument_name || '').replace('_', '/')}</td>
            <td><span class="ttype ${o.side === 'BUY' ? 'buy' : 'sell'}">${o.side}</span></td>
            <td>${o.type}</td>
            <td class="td-a">${parseFloat(o.quantity || 0).toFixed(6)}</td>
            <td>${o.price ? '$' + parseFloat(o.price).toFixed(2) : 'MARKET'}</td>
            <td><span class="spill open">${o.status}</span></td>
            <td>
              <button class="btn btn-danger btn-sm"
                onclick="cancelBinanceOrder('${o.order_id}','${o.instrument_name}')">✕</button>
            </td>
          </tr>`).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--red);padding:16px">${e.message}</td></tr>`;
    addLog('error', `Open orders fetch failed: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
//  RECENT FILLS
// ══════════════════════════════════════════════════════════════════════

async function fetchRecentTrades() {
  if (!binanceConnected) return;
  const tbody = document.getElementById('binanceFillsTable');
  if (!tbody) return;
  try {
    const result = await binanceREST(
      '/private/get-order-history',
      { page_size: 10 },
      'POST',
      true
    );
    const fills = (result.order_list || []).slice(0, 10);

    tbody.innerHTML = fills.length === 0
      ? '<tr><td colspan="6" style="text-align:center;color:var(--text3);padding:16px">No recent fills</td></tr>'
      : fills.map(f => {
          const t = new Date(f.update_time || Date.now()).toTimeString().slice(0, 8);
          return `
            <tr>
              <td class="td-sym">${(f.instrument_name || '').replace('_', '/')}</td>
              <td><span class="ttype ${f.side === 'BUY' ? 'buy' : 'sell'}">${f.side}</span></td>
              <td class="td-a">${parseFloat(f.quantity || 0).toFixed(6)}</td>
              <td>$${parseFloat(f.avg_price || 0).toFixed(2)}</td>
              <td style="color:var(--text3)">—</td>
              <td style="color:var(--text3);font-size:9px">${t}</td>
            </tr>`;
        }).join('');
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;color:var(--red);padding:16px">${e.message}</td></tr>`;
    addLog('error', `Recent trades fetch failed: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
//  PLACE ORDER
// ══════════════════════════════════════════════════════════════════════

async function placeBinanceOrder() {
  if (!binanceConnected) { showToast('⚠️ Connect Crypto.com first', 'warn'); return; }

  const symbol = document.getElementById('orderSymbol').value;   // e.g. BTC_USDT
  const side   = document.getElementById('orderSide').value;     // BUY or SELL
  const amount = parseFloat(document.getElementById('orderAmount').value);
  const type   = document.getElementById('orderType').value;     // MARKET or LIMIT
  const btn    = document.querySelector('#binanceOrderPanel button.btn-primary');

  // Safety checks
  if (!amount || amount <= 0)   { showToast('⚠️ Invalid amount', 'warn'); return; }
  if (amount < 1)               { showToast('⚠️ Minimum order is $1', 'warn'); return; }
  if (amount > userBalance)     { showToast(`⚠️ Insufficient balance: ${userBalance.toFixed(2)} USDT`, 'warn'); return; }

  const price = binanceLastPrices[symbol] || 0;
  const qty   = price > 0 ? (amount / price).toFixed(6) : '0';

  // Live confirmation dialog
  const confirmed = window.confirm(
    `⚡ CRYPTO.COM LIVE ORDER\n\n${side} ${qty} ${symbol.replace('_', '/')}\n` +
    `Value: ~$${amount.toFixed(2)} USDT\nType: ${type}\n\nConfirm?`
  );
  if (!confirmed) return;

  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  addLog('info', `Placing ${side} ${symbol} ${type} · $${amount}…`);

  try {
    const params = {
      instrument_name: symbol,
      side,
      type,
      notional:  type === 'MARKET' ? amount.toFixed(2) : undefined,   // market: notional value
      quantity:  type === 'LIMIT'  ? qty                : undefined,   // limit: base quantity
      price:     type === 'LIMIT'  ? price.toFixed(2)  : undefined,
      time_in_force: type === 'LIMIT' ? 'GOOD_TILL_CANCEL' : undefined,
    };
    // Remove undefined keys
    Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);

    const result = await binanceREST('/private/create-order', params, 'POST', true);

    showToast(`✅ Order placed: ${side} ${symbol.replace('_', '/')} · ${qty}`, 'success');
    addLog('trade', `ORDER PLACED: ${side} ${qty} ${symbol.replace('_','/')} @ $${price.toFixed(2)} · $${amount}`);
    fetchOpenOrders();
    fetchRecentTrades();
    await fetchBinanceBalance();

  } catch(e) {
    showToast(`❌ Order failed: ${e.message}`, 'error');
    addLog('error', `Order failed: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '⚡ Execute'; }
  }
}

// ══════════════════════════════════════════════════════════════════════
//  CANCEL ORDER
// ══════════════════════════════════════════════════════════════════════

async function cancelBinanceOrder(orderId, symbol = 'BTC_USDT') {
  if (!binanceConnected) return;
  try {
    await binanceREST(
      '/private/cancel-order',
      { instrument_name: symbol, order_id: orderId },
      'POST',
      true
    );
    showToast(`✅ Order ${orderId.slice(0, 8)}… cancelled`, 'success');
    addLog('info', `Order cancelled: ${orderId.slice(0, 8)}`);
    fetchOpenOrders();
  } catch(e) {
    showToast(`❌ Cancel failed: ${e.message}`, 'error');
    addLog('error', `Cancel order failed: ${e.message}`);
  }
}

// ══════════════════════════════════════════════════════════════════════
//  WEBSOCKET — Crypto.com Heartbeat + Subscription
// ══════════════════════════════════════════════════════════════════════

let wsReconnectDelay = 2000;
let wsHeartbeatTimer = null;

function startBinanceWebSocket() {
  if (binanceWsActive) { stopBinanceWebSocket(); return; }
  setWsStatus('connecting');
  const ws = new WebSocket('wss://stream.crypto.com/exchange/v1/market');
  binanceWS = ws;
  attachWsHandlers(ws);
}

function attachWsHandlers(ws) {
  ws.onopen = () => {
    wsReconnectDelay = 2000;
    binanceWsActive  = true;
    setWsStatus('live');
    const btn = document.getElementById('wsBtn');
    if (btn) btn.textContent = '⏹ Stop Stream';

    // Subscribe to ticker for all watched symbols
    const channels = WATCH_SYMBOLS.map(s => `ticker.${s}`);
    ws.send(JSON.stringify({
      id:     1,
      method: 'subscribe',
      params: { channels },
      nonce:  Date.now(),
    }));
    addLog('info', `Crypto.com WebSocket connected · Subscribed to ${channels.length} pairs`);

    // Send heartbeat every 30s to keep connection alive
    if (wsHeartbeatTimer) clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: 0, method: 'public/heartbeat', params: {} }));
      }
    }, 30000);
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);

      // Respond to server heartbeat requests
      if (msg.method === 'public/heartbeat') {
        ws.send(JSON.stringify({ id: msg.id, method: 'public/respond-heartbeat' }));
        return;
      }

      // Handle ticker updates
      if (msg.result?.channel?.startsWith('ticker.')) {
        const t     = msg.result.data?.[0];
        const sym   = msg.result.instrument_name;
        const price = parseFloat(t?.a || t?.k || 0); // ask price or last price

        if (sym && price > 0) {
          binanceLastPrices[sym] = price;

          // Update matching open positions in real time
          positions.filter(p => p.open).forEach(p => {
            const pSym = p.pair.replace('/', '_');
            if (pSym === sym) {
              p.current = price;
              p.pnl     = ((price - p.entry) / p.entry) * p.size * (p.dir === 'LONG' ? 1 : -1);
              p.toPct   = Math.min(100, Math.max(0, Math.abs(p.pnl) / (p.size * ENGINE.TP_PCT) * 100));
            }
          });

          updatePnlStats();
        }
      }
    } catch(err) { /* ignore parse errors */ }
  };

  ws.onerror = () => {
    addLog('warn', 'WebSocket error — will reconnect');
  };

  ws.onclose = () => {
    binanceWsActive = false;
    setWsStatus('offline');
    const btn = document.getElementById('wsBtn');
    if (btn) btn.textContent = '▶ Start Stream';
    if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }

    // Auto-reconnect with exponential backoff (max 32s)
    if (binanceConnected && wsReconnectDelay <= 32000) {
      addLog('info', `WS closed · Reconnecting in ${wsReconnectDelay / 1000}s…`);
      setTimeout(() => {
        if (binanceConnected) {
          wsReconnectDelay *= 2;
          startBinanceWebSocket();
        }
      }, wsReconnectDelay);
    } else if (wsReconnectDelay > 32000) {
      addLog('error', 'WebSocket reconnect exhausted · Click Start Stream to retry');
    }
  };
}

function stopBinanceWebSocket() {
  binanceWsActive = false;
  if (wsHeartbeatTimer) { clearInterval(wsHeartbeatTimer); wsHeartbeatTimer = null; }
  if (binanceWS) {
    try { binanceWS.close(); } catch(e) {}
    binanceWS = null;
  }
  setWsStatus('offline');
  const btn = document.getElementById('wsBtn');
  if (btn) btn.textContent = '▶ Start Stream';
}

// ══════════════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════════════

// Get live price for a pair — used by trading engine
function getBinancePrice(pair) {
  const sym = pair.replace('/', '_'); // BTC/USDT → BTC_USDT
  return binanceLastPrices[sym] || null;
}

// Get entry price — uses live price if connected, otherwise fallback estimate
function getEntryPrice(pair) {
  const live = getBinancePrice(pair);
  if (live) return live;
  // Fallback estimates when not connected (for DEMO simulation only)
  if (pair.includes('BTC'))  return 43200  + Math.random() * 200;
  if (pair.includes('ETH'))  return 2260   + Math.random() * 80;
  if (pair.includes('SOL'))  return 98     + Math.random() * 4;
  if (pair.includes('BNB'))  return 380    + Math.random() * 5;
  if (pair.includes('AVAX')) return 36     + Math.random() * 4;
  if (pair.includes('LINK')) return 14     + Math.random() * 2;
  if (pair.includes('ADA'))  return 0.44   + Math.random() * 0.02;
  if (pair.includes('XRP'))  return 0.58   + Math.random() * 0.02;
  if (pair.includes('DOT'))  return 7      + Math.random() * 0.5;
  if (pair.endsWith('/USDT')) return 0.5   + Math.random() * 50;
  return 10 + Math.random() * 90;
}

// Toggle API key visibility in input fields
function toggleKeyVisibility(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
  btn.textContent = el.type === 'password' ? '👁' : '🔒';
}

// ══════════════════════════════════════════════════════════════════════
//  UI STATUS HELPERS
// ══════════════════════════════════════════════════════════════════════

function setBinanceStatus(state) {
  const badge = document.getElementById('binanceStatusBadge');
  const setup = document.getElementById('binanceSetupBlock');
  const conn  = document.getElementById('binanceConnectedBlock');

  const cfg = {
    connecting:   { text: 'CONNECTING…',   bg: 'rgba(255,215,64,0.1)',  color: 'var(--gold)',  border: 'rgba(255,215,64,0.3)'  },
    connected:    { text: '● CONNECTED',   bg: 'rgba(0,230,118,0.1)',   color: 'var(--green)', border: 'rgba(0,230,118,0.3)'   },
    error:        { text: '✕ ERROR',        bg: 'rgba(176,58,46,0.1)',   color: 'var(--red)',   border: 'rgba(176,58,46,0.3)'   },
    disconnected: { text: 'NOT CONNECTED', bg: 'rgba(74,106,128,0.15)', color: 'var(--text3)', border: 'var(--border2)'        },
  };
  const c = cfg[state] || cfg.disconnected;

  if (badge) {
    badge.textContent       = c.text;
    badge.style.background  = c.bg;
    badge.style.color       = c.color;
    badge.style.borderColor = c.border;
  }
  if (setup) setup.style.display = state === 'connected' ? 'none'  : 'block';
  if (conn)  conn.style.display  = state === 'connected' ? 'block' : 'none';
}

function setBinancePriceBadge(state) {
  const el = document.getElementById('binancePriceBadge');
  if (!el) return;
  if (state === 'live') {
    el.textContent       = '● LIVE';
    el.style.background  = 'rgba(0,230,118,0.1)';
    el.style.color       = 'var(--green)';
    el.style.borderColor = 'rgba(0,230,118,0.3)';
  } else {
    el.textContent       = 'OFFLINE';
    el.style.background  = 'rgba(74,106,128,0.1)';
    el.style.color       = 'var(--text3)';
    el.style.borderColor = 'var(--border2)';
  }
}

function setWsStatus(state) {
  const dot    = document.getElementById('wsDot');
  const lbl    = document.getElementById('wsStatus');
  const colors = { live: 'var(--green)', connecting: 'var(--gold)', offline: 'var(--text3)' };
  const labels = { live: 'Connected · Live data', connecting: 'Connecting…', offline: 'Not connected' };
  if (dot) dot.style.background = colors[state] || colors.offline;
  if (lbl) lbl.textContent      = labels[state] || labels.offline;
}

function initBinance() {
  setBinanceStatus('disconnected');
  setWsStatus('offline');
  addLog('info', 'Crypto.com Exchange API ready · Go to Exchanges to connect');
}
