import fs from 'fs'
import http from 'http'
import { load } from 'cheerio'

function parseJsonWithComments(text){
  let out = ''
  let inStr = false
  let quote = '"'
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i+1]
    if (inStr) {
      out += ch
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === quote) { inStr = false }
      continue
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; out += ch; continue }
    if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue }
    if (ch === '/' && next === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i+1] === '/')) i++; i++; continue }
    out += ch
  }
  // remove trailing commas before } or ]
  out = out.replace(/,\s*([}\]])/g, '$1')
  return JSON.parse(out)
}

function readConfig(url){
  const raw = fs.readFileSync(url).toString()
  try { return parseJsonWithComments(raw) } catch { return JSON.parse(raw) }
}

const config = readConfig(new URL('./config.json', import.meta.url))

/*
  CONFIG REFERENCE (copy into your config.json as needed; values here are defaults if missing)

  - minutes_per_check: How often to scan everything (minutes)
  - seconds_between_check: Delay between each item (seconds)
  - tld: Amazon domain suffix, like "ca", "com", "co.uk"
  - webhook_url: Discord webhook URL where alerts are sent
  - default_warehouse: true = prefer Amazon Warehouse when available; false = main offer only
  - server: true to enable local web dashboard; port: dashboard port number

  User‑Agent rotation (helps avoid blocks):
  - user_agent_strategy: "stable-per-run" | "sticky-per-item" | "rotate-per-request"
      stable-per-run: one UA for the entire session (simple)
      sticky-per-item: each item keeps the same UA (recommended)
      rotate-per-request: new UA every request (most diverse)
  - user_agents: optional custom list of UA strings to rotate
  - rotate_on_soft_ban: when a soft-ban is detected, switch UA for that item

  Proxy support (optional; use only if you need it):
  - proxies: list of proxy URLs, e.g. ["http://user:pass@host:port", "socks5://host:1080"]
  - proxy_strategy: "none" | "round-robin" | "sticky-per-item"
  - proxy_timeout_ms: request timeout when using a proxy
  - retry_with_next_proxy: on failure, try the next proxy in the list
  - proxy_cooldown_ms: temporarily disable a failing proxy for this many ms

  History storage:
  - history.keep_full_days: keep full-resolution entries for this many days
  - history.bucket_after_days: start compressing older-than this many days
  - history.bucket_granularity: currently "1d" (by day)
  - history.max_points: cap points per item; oldest points are thinned first
  - history.keep_flip_markers: always keep stock flip events
  - history.outlier_confirm_scans: require N consecutive scans to accept a sudden change
*/

// Backward compatible default for Warehouse tracking
const DEFAULT_WAREHOUSE = !!(Object.prototype.hasOwnProperty.call(config, 'default_warehouse') ? config.default_warehouse : config.warehouse)
const DEFAULT_MINUTES = 10
const DEFAULT_DELAY_SEC = 60
const minutesPerCheck = Number.isFinite(Number(config.minutes_per_check)) && Number(config.minutes_per_check) > 0
  ? Number(config.minutes_per_check)
  : DEFAULT_MINUTES
const secondsBetweenCheck = Number.isFinite(Number(config.seconds_between_check)) && Number(config.seconds_between_check) > 0
  ? Number(config.seconds_between_check)
  : DEFAULT_DELAY_SEC

// User‑agent rotation defaults
const UA_STRATEGY = (config.user_agent_strategy || 'sticky-per-item')
const ROTATE_ON_SOFTBAN = config.rotate_on_soft_ban !== false
const CUSTOM_UA = Array.isArray(config.user_agents) && config.user_agents.length > 0 ? config.user_agents : null

function log(msg) {
  const ts = new Date().toLocaleTimeString()
  console.log(`[${ts}] ${msg}`)
}

function dbg(msg) {
  if (config.debug) log(msg)
}

// Color helpers for readable console output
const COLORS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  magenta: '\u001b[35m',
  red: '\u001b[31m',
}

function trace(msg) {
  if (config.trace) log(msg)
}

function printBanner() {
  const reset = '\u001b[0m'
  const dim = '\u001b[2m'
  const cyan = '\u001b[36m'
  const yellow = '\u001b[33m'
  const green = '\u001b[32m'

  const title = 'Amazon Simple Monitor'
  const author = 'Made by: Naveed M'
  const github = 'GitHub: https://github.com/naviem'
  const paypal = 'Support: https://www.paypal.com/donate/?hosted_button_id=T8DEQ4E4CU95N'
  const meta1 = `Scans every: ${minutesPerCheck} min  |  Delay between items: ${secondsBetweenCheck} sec`
  const meta2 = `TLD: ${config.tld}  |  Default Warehouse: ${DEFAULT_WAREHOUSE ? 'ON' : 'OFF'}`

  const lines = [title, author, github, paypal, meta1, meta2]
  const width = Math.max(...lines.map(l => l.length)) + 2
  const top = '┌' + '─'.repeat(width) + '┐'
  const mid = '├' + '─'.repeat(width) + '┤'
  const bot = '└' + '─'.repeat(width) + '┘'

  const pad = s => ' ' + s + ' '.repeat(width - s.length - 1)

  console.log('')
  console.log(cyan + top + reset)
  console.log(cyan + '│' + reset + pad(title) + cyan + '│' + reset)
  console.log(cyan + '│' + reset + pad(author) + cyan + '│' + reset)
  console.log(cyan + '│' + reset + pad(github) + cyan + '│' + reset)
  console.log(cyan + '│' + reset + pad(paypal) + cyan + '│' + reset)
  console.log(cyan + mid + reset)
  console.log(cyan + '│' + reset + pad(meta1) + cyan + '│' + reset)
  console.log(cyan + '│' + reset + pad(meta2) + cyan + '│' + reset)
  console.log(cyan + bot + reset)
  console.log(dim + 'Tip: use |threshold=PRICE |warehouse=on/off |alerts=stock|price|none (default: both)' + reset)
  console.log('')
}

if (typeof fetch === 'undefined') {
  log('Error: This script requires Node.js 18+ (global fetch). Please upgrade Node and try again.')
  process.exit(1)
}

const userAgents = CUSTOM_UA || [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
]
// Keep a stable UA across runs to look less bot-like
const STABLE_UA = userAgents[Math.floor(Math.random() * userAgents.length)]
const uaPerItem = new Map() // sticky-per-item map

// Proxy rotation defaults
const PROXIES = Array.isArray(config.proxies) ? config.proxies : []
const PROXY_STRATEGY = (config.proxy_strategy || (PROXIES.length>0 ? 'round-robin' : 'none'))
const PROXY_TIMEOUT_MS = Number.isFinite(Number(config.proxy_timeout_ms)) ? Number(config.proxy_timeout_ms) : 12000
const RETRY_WITH_NEXT_PROXY = config.retry_with_next_proxy !== false
const PROXY_COOLDOWN_MS = Number.isFinite(Number(config.proxy_cooldown_ms)) ? Number(config.proxy_cooldown_ms) : 5*60*1000
let proxyIndex = 0
const proxyCooldownUntil = new Map() // url -> timestamp
const proxyAgentCache = new Map() // url -> dispatcher/agent

// History defaults with simple keys for non‑technical users
const HISTORY_ENABLED = (config?.history_enabled === undefined) ? true : !!config.history_enabled
// Simple keys (preferred):
//   history_days                -> number of recent days to keep at full detail (default 7)
//   history_limit               -> max number of saved changes per item (default 2000)
//   history_noise_protection    -> true/false (ignore one‑off spikes; default true)
// Advanced keys (optional, under history.*) still supported for power users.
const simpleDays = Number(config?.history_days ?? config?.history?.keep_full_days ?? 7)
const simpleLimit = Number(config?.history_limit ?? config?.history?.max_points ?? 2000)
const simpleNoise = (config?.history_noise_protection === undefined)
  ? (config?.history?.outlier_confirm_scans !== undefined ? (Number(config.history.outlier_confirm_scans) > 1) : true)
  : !!config?.history_noise_protection

const historyCfg = {
  keep_full_days: simpleDays,
  bucket_after_days: Number(config?.history?.bucket_after_days ?? simpleDays),
  bucket_granularity: String(config?.history?.bucket_granularity ?? '1d'),
  max_points: simpleLimit,
  keep_flip_markers: !!(config?.history?.keep_flip_markers ?? true),
  outlier_confirm_scans: simpleNoise ? Math.max(2, Number(config?.history?.outlier_confirm_scans ?? 2)) : 1,
}
// Soft-ban cooldown end timestamp (ms since epoch); when > now, scans are skipped
let softBanUntil = 0
let lastScanAt = 0
const HISTORY_MAX = 20

function randomFrom(arr){ return arr[Math.floor(Math.random()*arr.length)] }

function pickUserAgentForKey(itemKey){
  if (UA_STRATEGY === 'stable-per-run') return STABLE_UA
  if (UA_STRATEGY === 'rotate-per-request') return randomFrom(userAgents)
  // sticky-per-item (default)
  if (!uaPerItem.has(itemKey)) uaPerItem.set(itemKey, randomFrom(userAgents))
  return uaPerItem.get(itemKey)
}

function rotateUserAgentForKey(itemKey){
  if (UA_STRATEGY !== 'sticky-per-item' && UA_STRATEGY !== 'rotate-per-request') return
  uaPerItem.set(itemKey, randomFrom(userAgents))
}

async function getProxyDispatcher(proxyUrl){
  if (!proxyUrl) return undefined
  if (proxyAgentCache.has(proxyUrl)) return proxyAgentCache.get(proxyUrl)
  try {
    const undici = await import('undici')
    const ProxyAgent = undici?.ProxyAgent
    if (!ProxyAgent) return undefined
    const dispatcher = new ProxyAgent(proxyUrl)
    proxyAgentCache.set(proxyUrl, dispatcher)
    return dispatcher
  } catch {
    return undefined
  }
}

function selectProxyUrlForKey(itemKey){
  if (PROXY_STRATEGY === 'none' || PROXIES.length === 0) return null
  const now = Date.now()
  // filter out proxies in cooldown
  const usable = PROXIES.filter(u => (proxyCooldownUntil.get(u) || 0) <= now)
  if (usable.length === 0) return null
  if (PROXY_STRATEGY === 'sticky-per-item') {
    if (!proxyAgentCache.has('sticky:'+itemKey)) {
      // store the chosen url inside cache under a sticky key
      const chosen = usable[(Math.abs(hashString(itemKey)) % usable.length)]
      proxyAgentCache.set('sticky:'+itemKey, chosen)
    }
    return proxyAgentCache.get('sticky:'+itemKey)
  }
  // round-robin
  const url = usable[proxyIndex % usable.length]
  proxyIndex++
  return url
}

function recordProxyFailure(proxyUrl){
  if (!proxyUrl) return
  proxyCooldownUntil.set(proxyUrl, Date.now() + PROXY_COOLDOWN_MS)
}

function hashString(str){ let h=0; for(let i=0;i<str.length;i++){ h=((h<<5)-h)+str.charCodeAt(i); h|=0 } return h }

function renderDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Amazon Monitor</title>
  <style>
    :root{--bg:#0b0f14;--panel:#0f1420;--muted:#9fb0c2;--line:#1e2a3a;--fg:#e6edf3;--link:#58a6ff;--chip:#142032;--ok:#33d17a;--out:#f85149}
    body{font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;margin:0;background:var(--bg);color:var(--fg)}
    .container{max-width:1180px;margin:18px auto;padding:0 18px}
    .meta{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:12px;color:var(--muted)}
    .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 6px 18px rgba(0,0,0,.25)}
    /* Table → clean list */
    table{width:100%;border-collapse:separate;border-spacing:0 8px}
    thead th{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);padding:10px 12px}
    tbody td{background:#0f1624;border-top:1px solid var(--line);border-bottom:1px solid var(--line);padding:12px;vertical-align:middle}
    tbody tr td:first-child{border-left:1px solid var(--line);border-top-left-radius:10px;border-bottom-left-radius:10px}
    tbody tr td:last-child{border-right:1px solid var(--line);border-top-right-radius:10px;border-bottom-right-radius:10px}
    a{color:var(--link);text-decoration:none}
    .header{display:flex;align-items:center;gap:12px;justify-content:space-between;margin-bottom:14px}
    .title{font-size:20px;font-weight:700}
    .toolbar{display:flex;gap:10px;flex:1;justify-content:flex-end;flex-wrap:wrap}
    .toolbar input{min-width:300px}
    .btn{padding:8px 12px;border-radius:10px;border:1px solid var(--line);background:#121b2b;color:var(--fg);cursor:pointer}
    .btn.primary{background:#1a2f5a;border-color:#25447e}
    input,select{padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:#0b1220;color:var(--fg)}
    .muted{color:var(--muted)}
    .tag{background:var(--chip);border:1px solid var(--line);color:var(--muted);padding:2px 8px;border-radius:999px;font-size:12px}
    .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:600}
    /* Item column */
    .itemCell{line-height:1.3}
    .itemMain{display:flex;align-items:center;gap:8px}
    .label{font-weight:600}
    .sub{font-size:12px;color:var(--muted)}
    .rules{display:flex;gap:8px;flex-wrap:wrap}
    .actions{display:flex;gap:8px;justify-content:flex-end}
    details.inline{margin-top:8px}
  </style>
  </head>
  <body>
    <div class="container">
    <div class="header">
      <div class="title">Amazon Monitor</div>
      <div class="toolbar">
        <input id="q" placeholder="Search label or URL" />
        <button id="btn_scan" class="btn primary">Scan now</button>
        <button id="btn_reload" class="btn">Reload</button>
      </div>
    </div>
    <div class="grid">
      <div class="card">
        <div class="meta" id="status">Loading status…</div>
      </div>
    <div class="card" style="margin-top:12px">
        <table>
          <thead>
            <tr>
              <th>Item</th>
              <th>Status</th>
              <th>Price</th>
              <th>Rules</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="items"><tr><td class="muted" colspan="5">Loading items…</td></tr></tbody>
        </table>
      </div>
      <div class="card">
        <h2 style="margin:0 0 8px;font-size:16px;color:#a0b3c6">Add item</h2>
        <form id="addForm" onsubmit="return false" class="meta" style="align-items:center">
          <input id="f_url" placeholder="URL or ASIN" style="flex:2;min-width:300px" title="Paste a product link or 10‑char ASIN"/>
          <input id="f_label" placeholder="Label (optional)" style="flex:1;min-width:160px" title="Short name for this item"/>
          <button id="btn_add" class="btn primary">Add</button>
          <details class="inline"><summary class="muted">More options</summary>
            <div class="meta" style="margin-top:8px">
              <select id="f_wh" title="Warehouse: on = prefer Warehouse; off = ignore; only = alert only on Warehouse">
                <option value="">warehouse: default</option>
                <option value="on">warehouse: on</option>
                <option value="off">warehouse: off</option>
                <option value="only">warehouse: only</option>
              </select>
              <select id="f_alerts" title="Alerts: stock = back‑in‑stock only; price = price‑drop only; none = mute">
                <option value="">alerts: both (default)</option>
                <option value="stock">alerts: stock</option>
                <option value="price">alerts: price</option>
                <option value="none">alerts: none</option>
              </select>
              <input id="f_threshold" type="number" step="0.01" placeholder="threshold $ (optional)" style="width:150px" title="Only alert when the current price is less than or equal to this value"/>
              <input id="f_drop" type="number" step="1" min="1" max="90" placeholder="drop % (optional)" style="width:130px" title="Percent drop vs baseline"/>
              <select id="f_base" title="Baseline for drop% rule">
                <option value="">baseline: last</option>
                <option value="last">last</option>
                <option value="lowest">lowest</option>
                <option value="start">start</option>
              </select>
            </div>
          </details>
        </form>
        <details class="meta"><summary class="muted">What do these options mean?</summary>
          <div class="muted">• <b>URL or ASIN</b>: Paste a full Amazon product link, or the 10‑character product code (ASIN). Example ASIN: B0XXXXXX00.</div>
          <div class="muted">• <b>Label</b>: A short name you choose so the item is easy to recognize in the console and in Discord messages. Optional.</div>
          <div class="muted">• <b>Group</b>: Optional tag to organize items (for example “Consoles”, “Food”). You can filter by group later.</div>
          <div class="muted">• <b>Warehouse</b>:
             “on” = use Amazon Warehouse price when it exists (otherwise use the main price),
             “off” = ignore Warehouse and always use the main price,
             “only” = alert only for Warehouse offers.</div>
          <div class="muted">• <b>Alerts</b>:
             “both” (default) = get price‑drop and back‑in‑stock alerts,
             “stock” = only when it comes back in stock,
             “price” = only when the price goes down,
             “none” = no alerts for this item.</div>
          <div class="muted">• <b>Threshold $</b>: A maximum price. The app will only alert when the current price is less than or equal to this number.</div>
          <div class="muted">• <b>Drop %</b>: A relative rule. Example: 10 means “alert when the price is at least ten percent lower than the baseline price”.</div>
          <div class="muted">• <b>Baseline</b>: What “drop %” compares against. “last” (default) = compare to the last seen price, “lowest” = compare to the best price we have ever recorded, “start” = compare to the first price we saw for this item.</div>
          <div class="muted">• <b>Source / Status / Price</b>: Shows whether the app is using the main offer or a Warehouse offer, whether it is in stock, and the latest price seen.</div>
          <div class="muted">• <b>Scan now</b>: Runs a scan immediately. It does not change your regular schedule.</div>
          <div class="muted">• <b>Soft‑ban safety</b>: If Amazon returns a CAPTCHA or a rate‑limit page, the app pauses scanning for about 30 minutes to cool down.</div>
        </details>
      </div>
    </div>
    </div>
    <script>
      async function api(method, path, body){
        const res = await fetch(path,{method,headers:{'Content-Type':'application/json'},body: body? JSON.stringify(body): undefined})
        const ct = res.headers.get('content-type')||''
        return ct.includes('application/json')? res.json(): res.text()
      }
      async function load() {
        try {
          const s = await fetch('/api/status').then(r=>r.json())
          const items = await fetch('/api/items').then(r=>r.json()).then(x=>x.items||[])
          const fmt = ms=> ms>0 ? Math.ceil(ms/60000)+' min' : '0 min'
          const last = s.lastScanAt ? new Date(s.lastScanAt).toLocaleTimeString() : 'N/A'
          document.getElementById('status').innerHTML = \`
            <div><span class=\"muted\">Last scan:</span> \${last}</div>
            <div><span class=\"muted\">Next scan in:</span> \${fmt(s.nextScanInMs||0)}</div>
            <div><span class=\"muted\">Cooldown:</span> \${s.coolingMs>0?'\<span class=\\\"warn\\\">'+fmt(s.coolingMs)+'\</span>':'\<span class=\\\"ok\\\">none\</span>'}</div>
            <div><span class=\"muted\">Schedule:</span> every \${s.minutesPerCheck} min, \${s.secondsBetweenCheck}s between items</div>
          \`
        const tbody = document.getElementById('items')
          if (!items.length) { tbody.innerHTML = '<tr><td class="muted" colspan="5">No items found</td></tr>'; return }
          tbody.innerHTML = items.map(it=>{
            const short = it.url.length>70 ? it.url.slice(0,67)+'…' : it.url
            const thr = (it.threshold!=null && !Number.isNaN(Number(it.threshold))) ? ('$'+Number(it.threshold).toFixed(2)) : '—'
            const src = it.current && it.current.source ? it.current.source : 'main'
            const price = it.current && it.current.price ? (it.current.symbol||'$')+Number(it.current.price).toFixed(2) : '—'
            const status = it.current && it.current.available ? '<span class="badge" style="background:rgba(51,209,122,.15);border:1px solid #1b3a2a;color:#7de3a7">IN STOCK</span>' : '<span class="badge" style="background:rgba(248,81,73,.15);border:1px solid #3a1b1b;color:#f09b97">OUT</span>'
            const rules = [thr!=='—'?('≤ '+thr):null, it.warehouse?('wh: '+it.warehouse):null, it.alerts?('alerts: '+it.alerts):null].filter(Boolean).map(t=>'<span class="tag">'+t+'</span>').join(' ')
            return \`<tr>
              <td class=\"itemCell\">\n                <div class=\"itemMain\">\n                  \${it.group ? '<span class=\\\"tag\\\">'+it.group+'</span>' : ''}\n                  <span class=\"label\">\${it.label?it.label:'(no label)'}</span>\n                </div>\n                <div class=\"sub\"><a href=\"\${it.url}\" target=\"_blank\" rel=\"noreferrer\">\${short}</a> · <span class=\"tag\">\${src}</span></div>\n              </td>
              <td>\${status}</td>
              <td>\${price}</td>
              <td>\${rules||'<span class=\\\"muted\\\">—</span>'}</td>
              <td class=\"actions\"><button data-asin=\"\${it.asin}\" class=\"hist btn\">History</button> <button data-asin=\"\${it.asin}\" class=\"test btn\">Test</button> <button data-asin=\"\${it.asin}\" class=\"edit btn\">Edit</button> <button data-asin=\"\${it.asin}\" class=\"del btn\">Delete</button></td>
            </tr>\`
          }).join('')
        // history viewer
        function spark(values){
          if(!values || values.length===0) return '<span class="muted">No history yet</span>'
          const w=320,h=48; const min=Math.min(...values), max=Math.max(...values); const r=max-min||1
          const pts=values.map((v,i)=>{const x=(i/(values.length-1))*w; const y=h-((v-min)/r)*h; return x.toFixed(1)+','+y.toFixed(1)}).join(' ')
          return '<svg width="'+w+'" height="'+h+'"><polyline fill="none" stroke="#58a6ff" stroke-width="2" points="'+pts+'"/></svg>'
        }
        document.querySelectorAll('button.hist').forEach(btn=>{
          btn.onclick = async ()=>{
            const asin = btn.getAttribute('data-asin'); if(!asin) return
            const data = await api('GET','/api/history?asin='+encodeURIComponent(asin))
            const row = btn.closest('tr'); if(!row) return
            const old=document.querySelector('tr.viewer'); if(old) old.remove()
            const prices=(data.history||[]).map(e=>Number(e.price||0)).filter(n=>n>0)
            const ls=data.lowestSeen? ((data.symbol||'$')+Number(data.lowestSeen.price||0).toFixed(2)+' ('+data.lowestSeen.source+')') : '—'
            const tr=document.createElement('tr'); tr.className='viewer'
            if(data && data.disabled){
              tr.innerHTML='<td colspan="5"><div class="meta"><div class="muted">History is turned off in settings. You can still see "Lowest ever" below.</div><div class="muted">Lowest ever: '+ls+'</div></div></td>'
            } else {
              tr.innerHTML='<td colspan="5"><div class="meta"><div>'+spark(prices)+'</div><div class="muted">Lowest ever: '+ls+'</div></div></td>'
            }
            row.after(tr)
          }
        })

          // wire delete
          document.querySelectorAll('button.del').forEach(btn=>{
            btn.onclick = async ()=>{
              const asin = btn.getAttribute('data-asin')
              if (!asin) return
              if (!confirm('Delete this item?')) return
              await api('DELETE','/api/items?asin='+encodeURIComponent(asin))
              load()
            }
          })
        // test webhook per item
        document.querySelectorAll('button.test').forEach(btn=>{
          btn.onclick = async ()=>{
            const asin = btn.getAttribute('data-asin'); if(!asin) return
            const r = await api('POST','/api/test?asin='+encodeURIComponent(asin))
            alert(r && r.ok ? 'Test alert sent. Check Discord.' : 'Test alert request sent.')
          }
        })
          // wire edit
          document.querySelectorAll('button.edit').forEach(btn=>{
            btn.onclick = ()=>{
              const asin = btn.getAttribute('data-asin')
              const it = items.find(x=>x.asin===asin); if(!it) return
              const row = btn.closest('tr'); if(!row) return
              const old = document.querySelector('tr.editor'); if(old) old.remove()
              const tr = document.createElement('tr'); tr.className='editor'
              const thrVal = (it.threshold!=null && !isNaN(Number(it.threshold))) ? Number(it.threshold).toFixed(2) : ''
              tr.innerHTML = '<td colspan="5">'
                + '<div class="meta">'
                + '<input id="e_label" value="'+(it.label||'')+'" placeholder="Label"/>'
                + '<input id="e_group" value="'+(it.group||'')+'" placeholder="Group"/>'
                + '<select id="e_wh">'
                +   '<option value="">warehouse: default</option>'
                +   '<option value="on"'+(it.warehouse==='on'?' selected':'')+'>warehouse: on</option>'
                +   '<option value="off"'+(it.warehouse==='off'?' selected':'')+'>warehouse: off</option>'
                +   '<option value="only"'+(it.warehouse==='only'?' selected':'')+'>warehouse: only</option>'
                + '</select>'
                + '<select id="e_alerts">'
                +   '<option value=""'+(it.alerts==='both'?' selected':'')+'>alerts: both</option>'
                +   '<option value="stock"'+(it.alerts==='stock'?' selected':'')+'>stock</option>'
                +   '<option value="price"'+(it.alerts==='price'?' selected':'')+'>price</option>'
                +   '<option value="none"'+(it.alerts==='none'?' selected':'')+'>none</option>'
                + '</select>'
                + '<input id="e_threshold" type="number" step="0.01" value="'+thrVal+'" placeholder="threshold $"/>'
                + '<input id="e_drop" type="number" step="1" min="1" max="90" value="'+(it.thresholdDrop||'')+'" placeholder="drop %"/>'
                + '<select id="e_baseline">'
                +   '<option value=""'+(!it.baseline?' selected':'')+'>baseline: last</option>'
                +   '<option value="last"'+(it.baseline==='last'?' selected':'')+'>last</option>'
                +   '<option value="lowest"'+(it.baseline==='lowest'?' selected':'')+'>lowest</option>'
                +   '<option value="start"'+(it.baseline==='start'?' selected':'')+'>start</option>'
                + '</select>'
                + '<button id="e_save" class="btn primary">Save</button>'
                + '<button id="e_cancel" class="btn">Cancel</button>'
                + '</div>'
                + '</td>'
              row.after(tr)
              document.getElementById('e_cancel').onclick = ()=> tr.remove()
              document.getElementById('e_save').onclick = async ()=>{
                const payload = { asin }
                const lab=document.getElementById('e_label').value.trim(); if(lab) payload.label=lab
                const grp=document.getElementById('e_group').value.trim(); if(grp) payload.group=grp
                const wh=document.getElementById('e_wh').value; if(wh) payload.warehouse=wh
                const al=document.getElementById('e_alerts').value; if(al) payload.alerts=al
                const th=document.getElementById('e_threshold').value; if(th) payload.threshold=Number(th)
                const dp=document.getElementById('e_drop').value; if(dp) payload.thresholdDrop=Number(dp)
                const bs=document.getElementById('e_baseline').value; if(bs) payload.baseline=bs
                const res = await api('PUT','/api/items', payload)
                if(res && res.error){ alert(res.error) } else { tr.remove(); load() }
              }
            }
          })
        } catch(e) {
          document.getElementById('status').innerHTML = '<span class="warn">Failed to load status</span>'
        }
      }
      // refresh only when no editor is open
      load();
      setInterval(()=>{ if(!document.querySelector('tr.editor')) load() }, 8000)

      // add form
      document.getElementById('btn_add').onclick = async ()=>{
        const url = document.getElementById('f_url').value.trim()
        if(!url){ alert('Please enter a URL or ASIN'); return }
        const body = { urlOrAsin: url }
        const label = document.getElementById('f_label').value.trim(); if(label) body.label = label
        const wh = document.getElementById('f_wh').value; if(wh) body.warehouse = wh
        const al = document.getElementById('f_alerts').value; if(al) body.alerts = al
        const th = document.getElementById('f_threshold').value; if(th) body.threshold = Number(th)
        const dpEl = document.getElementById('f_drop'); if(dpEl && dpEl.value) body.thresholdDrop = Number(dpEl.value)
        const bsEl = document.getElementById('f_base'); if(bsEl && bsEl.value) body.baseline = bsEl.value
        const res = await api('POST','/api/items', body)
        if(res && res.error){ alert(res.error) }
        else { document.getElementById('addForm').reset(); load() }
      }
      document.getElementById('btn_reload').onclick = ()=> load()
      document.getElementById('btn_scan').onclick = async ()=>{ await api('POST','/api/scan'); setTimeout(load, 1500) }
    </script>
  </body>
  </html>`
}

function getLocaleCookieForTld(tld) {
  switch (tld) {
    case 'ca': return 'i18n-prefs=CAD; lc-main=en_CA'
    case 'com': return 'i18n-prefs=USD; lc-main=en_US'
    case 'de': return 'i18n-prefs=EUR; lc-main=de_DE'
    case 'fr': return 'i18n-prefs=EUR; lc-main=fr_FR'
    case 'it': return 'i18n-prefs=EUR; lc-main=it_IT'
    case 'es': return 'i18n-prefs=EUR; lc-main=es_ES'
    case 'co.uk': return 'i18n-prefs=GBP; lc-main=en_GB'
    case 'com.au': return 'i18n-prefs=AUD; lc-main=en_AU'
    default: return 'i18n-prefs=USD; lc-main=en_US'
  }
}

function appendParams(url, params) {
  const keys = Object.keys(params || {})
  if (keys.length === 0) return url
  const usp = new URLSearchParams()
  for (const k of keys) usp.set(k, params[k])
  const hasQ = url.includes('?')
  return url + (hasQ ? '&' : '?') + usp.toString()
}

function toProductUrl(s) {
  const trimmed = s.trim()
  if (trimmed.startsWith('http')) return trimmed
  // Assume bare ASIN
  return `https://www.amazon.${config.tld}/dp/${trimmed}`
}

function extractAsin(str) {
  try {
    const u = str.startsWith('http') ? new URL(str) : new URL(`https://www.amazon.${config.tld}/dp/${str}`)
    const parts = u.pathname.split('/').filter(Boolean)
    // Look for a 10-char ASIN segment (letters/digits), commonly starting with B
    for (const seg of parts) {
      const m = seg.toUpperCase().match(/^[A-Z0-9]{10}$/)
      if (m) return m[0]
    }
    // Fallback to query param
    const qpAsin = u.searchParams.get('asin')
    if (qpAsin) {
      const m2 = qpAsin.toUpperCase().match(/^[A-Z0-9]{10}$/)
      if (m2) return m2[0]
    }
  } catch {}
  return ''
}

function detectSoftBan(html) {
  try {
    const s = (html || '').toLowerCase()
    if (!s) return false
    return (
      s.includes('automated access to amazon data') ||
      s.includes('to discuss automated access') ||
      s.includes('enter the characters you see below') ||
      s.includes('type the characters you see in this image') ||
      s.includes('/errors/validatecaptcha') ||
      (s.includes('captcha') && s.includes('amazon')) ||
      s.includes('robot check')
    )
  } catch { return false }
}

async function fetchPage(url) {
  let reqUrl = url
  if (reqUrl.includes('/dp/')) {
    reqUrl += (reqUrl.includes('?') ? '&' : '?') + 'aod=1&psc=1'
  }

  const itemKey = url
  const ua = pickUserAgentForKey(itemKey)
  const headers = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': `https://www.amazon.${config.tld}/`,
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'sec-ch-ua': '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Viewport-Width': '1920',
    'Cookie': getLocaleCookieForTld(config.tld),
  }

  // Optional proxy selection
  let dispatcher
  let proxyUrl = selectProxyUrlForKey(itemKey)
  if (proxyUrl) dispatcher = await getProxyDispatcher(proxyUrl)
  let res
  try {
    res = await fetch(reqUrl, { headers, redirect: 'follow', dispatcher, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) })
  } catch (e) {
    if (proxyUrl && RETRY_WITH_NEXT_PROXY) {
      recordProxyFailure(proxyUrl)
      proxyUrl = selectProxyUrlForKey(itemKey)
      dispatcher = await getProxyDispatcher(proxyUrl)
      try { res = await fetch(reqUrl, { headers, redirect: 'follow', dispatcher, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) }) } catch {}
    }
  }
  if (!res) return { $, softBan: true }
  const status = res.status
  if (!res.ok) {
    return { $, softBan: status === 429 || status === 503 }
  }
  const html = await res.text()
  const softBan = detectSoftBan(html)
  const $ = load(html)
  return { $, softBan }
}

async function fetchAodHtml(asin) {
  const urls = [
    `https://www.amazon.${config.tld}/gp/aod/ajax?asin=${asin}&pc=dp`,
    `https://www.amazon.${config.tld}/gp/product/ajax?asin=${asin}&m=&qid=&smid=&sourcecustomerorglistid=&sourcecustomerorglistitemid=&sr=&pc=dp&experienceId=aodAjaxMain`
  ]
  const headers = {
    'User-Agent': pickUserAgentForKey(asin),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Referer': `https://www.amazon.${config.tld}/dp/${asin}?aod=1&psc=1`,
    'X-Requested-With': 'XMLHttpRequest',
    'sec-ch-ua': '"Chromium";v="125", "Not.A/Brand";v="24", "Google Chrome";v="125"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Cookie': getLocaleCookieForTld(config.tld),
  }
  for (const url of urls) {
    try {
      if (config.trace) dbg(`Fetching AOD endpoint: ${url}`)
      let dispatcher
      const proxyUrl = selectProxyUrlForKey(asin)
      if (proxyUrl) dispatcher = await getProxyDispatcher(proxyUrl)
      const res = await fetch(url, { headers, redirect: 'follow', dispatcher, signal: AbortSignal.timeout(PROXY_TIMEOUT_MS) })
      if (!res.ok) continue
      const html = await res.text()
      const $ = load(html)
      const count = $('#aod-offer, .aod-offer').length
      if (config.trace) dbg(`AOD endpoint returned ${count} offers`)
      if (count > 0) return $
    } catch {}
  }
  return null
}

function priceFormat(p) {
  p = '' + p
  const currencySymbol = p.replace(/[,.]+/g, '').replace(/\d/g, '')
  if (currencySymbol) p = p.replace(currencySymbol, '')
  if (!p.includes('.') && !p.includes(',')) p += '.00'
  if (p.indexOf('.') > p.indexOf(',')) {
    const cents = p.split('.')[1]
    const dollars = p.split(`.${cents}`)[0].split(',').join('')
    p = `${dollars}.${cents}`
  } else {
    const cents = p.split(',')[1]
    const dollars = p.split(`,${cents}`)[0].split('.').join('')
    p = `${dollars}.${cents}`
  }
  return parseFloat(p).toFixed(2)
}

async function parseItem($, url, includeWarehouse = DEFAULT_WAREHOUSE) {
  const priceElms = [
    $('#priceblock_ourprice').text().trim(),
    $('#priceblock_saleprice').text().trim(),
    $('#sns-base-price').text().trim(),
    $('#corePriceDisplay_desktop_feature_div').find('.a-price').find('.a-offscreen').eq(0).text().trim(),
    $('#corePriceDisplay_desktop_feature_div').find('.a-price-whole').first().text().trim() + $('#corePriceDisplay_desktop_feature_div').find('.a-price-fraction').first().text().trim(),
  ]

  let bestPrice = ''
  let symbol = '$'
  for (const p of priceElms) {
    const flt = parseFloat(priceFormat(p))
    const current = parseFloat(priceFormat(bestPrice || '0'))
    if (!current || (flt && flt < current)) {
      bestPrice = priceFormat(p)
      symbol = p.replace(/[,.]+/g, '').replace(/[\d a-zA-Z]/g, '') || symbol
    }
  }

  const title = $('#productTitle').text().trim()
  const image = $('#landingImage').attr('data-old-hires') || ''

  const base = {
    title,
    url,
    price: bestPrice,
    lastPrice: parseFloat(bestPrice || '0'),
    symbol,
    image,
    available: !!bestPrice && parseFloat(bestPrice || '0') > 0,
  }

  // Optionally parse AOD for Amazon Warehouse price (per-item override supported)
  if (includeWarehouse) {
    let whDom = null
    const $nodes = $('#aod-offer, .aod-offer')
    $nodes.each(function () {
      if (whDom) return
      const offer = $(this)
      const soldBy = offer.find('[id*="aod-offer-soldBy"], .aod-offer-soldBy')
      let seller = soldBy.find('a').last().text().trim()
      if (!seller) {
        const smalls = soldBy.find('.a-size-small').toArray().map(el => $(el).text().trim()).filter(Boolean)
        seller = smalls[smalls.length - 1] || ''
      }
      if (!seller) {
        const raw = soldBy.text().trim()
        const m = raw.replace(/\s+/g, ' ').match(/sold by[:\s]*([^|\n]+?)(?:\s{2,}|$)/i)
        if (m) seller = m[1].trim()
      }
      const s = (seller || '').toLowerCase()
      if (s.includes('amazon warehouse') || s.includes('warehouse deals') || s.includes('warehouse')) {
        const priceText = offer.find('#aod-offer-price .aok-offscreen, #aod-offer-price .a-offscreen, .aod-offer-price .aok-offscreen, .aod-offer-price .a-offscreen').first().text().trim()
        const priceRaw = priceText || offerPriceFallback(offer)
        const priceFmt = priceRaw ? priceFormat(priceRaw) : ''
        const priceVal = priceFmt ? parseFloat(priceFmt) : 0
        whDom = {
          seller: seller || 'Amazon Warehouse',
          price: priceFmt,
          lastPrice: priceVal,
          symbol: (priceRaw || '').replace(/[,.]+/g, '').replace(/[\d a-zA-Z]/g, '') || symbol,
          available: priceVal > 0,
        }
      }
    })
    // Reduce noisy traces by moving detailed AOD counts under config.trace instead of debug
    if (config.trace) dbg(`AOD offers in DOM: ${$nodes.length}`)
    if (whDom) {
      dbg(`Matched Warehouse (DOM): ${whDom.seller} @ ${whDom.price || 'N/A'}`)
      return { ...base, warehouse: whDom }
    }

    // If not present in server DOM, try AOD ajax endpoint
    const asin = extractAsin(url)
    if (asin) {
      const $aod = await fetchAodHtml(asin)
      if ($aod) {
        let whAjax = null
        const $items = $aod('#aod-offer, .aod-offer')
        if (config.trace) dbg(`AOD offers via ajax: ${$items.length}`)
        $items.each(function () {
          if (whAjax) return
          const offer = $aod(this)
          const soldBy = offer.find('[id*="aod-offer-soldBy"], .aod-offer-soldBy')
          let seller = soldBy.find('a').last().text().trim()
          if (!seller) {
            const smalls = soldBy.find('.a-size-small').toArray().map(el => $aod(el).text().trim()).filter(Boolean)
            seller = smalls[smalls.length - 1] || ''
          }
          if (!seller) {
            const raw = soldBy.text().trim()
            const m = raw.replace(/\s+/g, ' ').match(/sold by[:\s]*([^|\n]+?)(?:\s{2,}|$)/i)
            if (m) seller = m[1].trim()
          }
          const s = (seller || '').toLowerCase()
          if (s.includes('amazon warehouse') || s.includes('warehouse deals') || s.includes('warehouse')) {
            const priceText = offer.find('#aod-offer-price .aok-offscreen, #aod-offer-price .a-offscreen, .aod-offer-price .aok-offscreen, .aod-offer-price .a-offscreen').first().text().trim()
            const priceRaw = priceText || offerPriceFallback(offer)
          const whPrice2 = priceRaw ? priceFormat(priceRaw) : ''
          whAjax = {
              seller: seller || 'Amazon Warehouse',
              price: whPrice2,
              lastPrice: whPrice2 ? parseFloat(whPrice2) : 0,
            symbol: (priceRaw || '').replace(/[,.]+/g, '').replace(/[\d a-zA-Z]/g, '') || symbol,
            available: (whPrice2 ? parseFloat(whPrice2) : 0) > 0,
            }
          }
        })
        if (whAjax) {
          dbg(`Matched Warehouse (ajax): ${whAjax.seller} @ ${whAjax.price || 'N/A'}`)
          return { ...base, warehouse: whAjax }
        }
      }
    }
  }

  return base
}

function offerPriceFallback($ctx) {
  // Try to find any $xx.xx near the offer when structured selectors fail
  const txt = $ctx.text()
  const m = txt && txt.match(/\$\s*\d{1,4}[\.,]\d{2}/)
  return m ? m[0] : ''
}

function parseBooleanToken(value) {
  const v = String(value || '').trim().toLowerCase()
  if (['1', 'on', 'true', 'yes', 'y'].includes(v)) return true
  if (['0', 'off', 'false', 'no', 'n'].includes(v)) return false
  return null
}

function readUrlsFile() {
  const p = new URL('./urls.txt', import.meta.url)
  if (!fs.existsSync(p)) return []
  const raw = fs.readFileSync(p).toString()
  const lines = raw.split(/\r?\n/)
  const entries = []
  for (const line of lines) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue
    // Syntax: URL|threshold=PRICE|warehouse=on/off|alerts=stock|price|both|none
    const parts = l.split('|').map(x => x.trim())
    const value = parts[0]
    let threshold = null
    let thresholdDrop = null // percent
    let baseline = null // 'last' | 'lowest' | 'start'
    let useWarehouse = null // null = use global default
    let allowStockAlerts = true
    let allowPriceAlerts = true
    let labelToken = null
    let notifyOnceToken = null
    let groupToken = null
    for (let i = 1; i < parts.length; i++) {
      const token = parts[i]
      if (!token) continue
      const eq = token.indexOf('=')
      if (eq === -1) continue
      const key = token.slice(0, eq).trim().toLowerCase()
      const val = token.slice(eq + 1).trim()
      if (key === 'threshold') {
        const n = parseFloat(val)
        if (!isNaN(n)) threshold = n
      } else if (key === 'threshold_drop' || key === 'drop') {
        const v = String(val).replace(/%/g, '')
        const n = parseFloat(v)
        if (!isNaN(n) && n > 0) thresholdDrop = n
      } else if (key === 'baseline') {
        const v = String(val).toLowerCase()
        if (['last','lowest','start'].includes(v)) baseline = v
      } else if (key === 'warehouse') {
        const v = val.toLowerCase()
        if (['only', 'strict', 'wh-only', 'warehouse-only', 'onlywh', 'only-warehouse'].includes(v)) {
          useWarehouse = 'only'
        } else {
          const b = parseBooleanToken(val)
          if (b !== null) useWarehouse = b
        }
      } else if (key === 'alerts') {
        const v = val.toLowerCase()
        if (v === 'stock') { allowStockAlerts = true; allowPriceAlerts = false }
        else if (v === 'price') { allowStockAlerts = false; allowPriceAlerts = true }
        else if (v === 'both' || v === 'all' || v === '') { allowStockAlerts = true; allowPriceAlerts = true }
        else if (v === 'none' || v === 'off') { allowStockAlerts = false; allowPriceAlerts = false }
      } else if (key === 'label') {
        labelToken = val
      } else if (key === 'notify' || key === 'notify_once') {
        notifyOnceToken = val
      } else if (key === 'group') {
        groupToken = val
      }
    }
    const label = labelToken ? labelToken.replace(/^"|"$/g, '') : null
    const nv = (notifyOnceToken || '').toLowerCase()
    const notifyOnce = ['once', 'on', 'true', '1', 'yes', 'y'].includes(nv) ? true
      : ['repeat', 'off', 'false', '0', 'no', 'n'].includes(nv) ? false
      : false
    const group = groupToken ? groupToken.replace(/^"|"$/g, '') : null
    entries.push({ value, threshold: threshold ?? null, thresholdDrop: thresholdDrop ?? null, baseline: baseline || null, useWarehouse, allowStockAlerts, allowPriceAlerts, label, group, notifyOnce })
  }
  return entries
}

function loadWatch() {
  const p = new URL('./watch.json', import.meta.url)
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, JSON.stringify({}, null, 2))
    return {}
  }
  return JSON.parse(fs.readFileSync(p).toString())
}

function saveWatch(obj) {
  const p = new URL('./watch.json', import.meta.url)
  fs.writeFileSync(p, JSON.stringify(obj, null, 2))
}

async function postWebhook(embed) {
  if (!config.webhook_url) return
  const payload = {
    username: 'AmazonMonitor',
    embeds: [embed]
  }
  await fetch(config.webhook_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
}

async function checkOnce() {
  // Respect soft-ban cooldown
  const now = Date.now()
  if (softBanUntil && now < softBanUntil) {
    const mins = Math.ceil((softBanUntil - now) / 60000)
    log(`Scan skipped: soft-ban cooldown active. Next attempt in ~${mins} min`)
    return
  }
  if (!config.webhook_url) {
    log('Error: No webhook_url configured. Set config.webhook_url to receive notifications.')
  }
  const result = readUrlsFile()
  const entries = Array.isArray(result) ? result : result.entries
  const issues = Array.isArray(result) ? [] : (result.issues || [])
  for (const msg of issues) log(msg)
  const items = entries.map(e => ({
    finalUrl: appendParams(toProductUrl(e.value), config.url_params),
    threshold: e.threshold,
    thresholdDrop: e.thresholdDrop,
    baseline: e.baseline,
    useWarehouse: (e.useWarehouse === null || e.useWarehouse === undefined)
      ? DEFAULT_WAREHOUSE
      : e.useWarehouse,
    allowStockAlerts: e.allowStockAlerts,
    allowPriceAlerts: e.allowPriceAlerts,
    label: e.label || null,
    group: e.group || null,
    notifyOnce: !!e.notifyOnce,
  }))
  if (items.length === 0) {
    log('Scan skipped: no URLs found in urls.txt')
    return
  }
  console.log(`${COLORS.cyan}[${new Date().toLocaleTimeString()}] Scan started: ${items.length} item(s)${COLORS.reset}`)

  const state = loadWatch() // { [url]: { lastPrice, symbol, title, image, available, warehouse?, useWarehouse?, threshold? } }
  let sent = 0
  let errors = 0

  for (let i = 0; i < items.length; i++) {
    const { finalUrl, threshold, useWarehouse, allowStockAlerts, allowPriceAlerts, label, notifyOnce } = items[i]
    try {
      const page = await fetchPage(finalUrl)
      const $ = page && page.$
      if (!page || !$) {
        errors++
        continue
      }
      if (page.softBan) {
        const cooldownMin = 30
        softBanUntil = Date.now() + cooldownMin * 60 * 1000
        log(`Warning: Possible soft ban detected. Pausing scans for ${cooldownMin} minutes to cool down.`)
        break
      }
      const info = await parseItem($, finalUrl, useWarehouse)

      const prev = state[finalUrl]
      const alertsMode = allowStockAlerts && allowPriceAlerts ? 'both' : (allowStockAlerts ? 'stock' : (allowPriceAlerts ? 'price' : 'none'))
      state[finalUrl] = {
        lastPrice: info.lastPrice,
        symbol: info.symbol,
        title: info.title,
        image: info.image,
        available: info.available || false,
        warehouse: info.warehouse || null,
        threshold: threshold,
        thresholdDrop: items[i].thresholdDrop || null,
        baseline: items[i].baseline || null,
        useWarehouse: useWarehouse,
        alerts: alertsMode,
        label: label || null,
        group: items[i].group || null,
        notifyOnce: !!notifyOnce,
        lowestSeen: state[finalUrl]?.lowestSeen || null,
        history: state[finalUrl]?.history || [],
      }

      // Select comparison source based on per-item warehouse mode
      const modeWarehouseOnly = useWarehouse === 'only'
      const hasWarehouse = !!info.warehouse
      let usingWh = false
      let prevPrice = 0
      let newPrice = 0
      let prevAvail = false
      let newAvail = false

      if (modeWarehouseOnly) {
        // Track ONLY the Warehouse offer; ignore main offer entirely
        usingWh = true
        prevPrice = prev?.warehouse?.lastPrice ?? 0
        newPrice = hasWarehouse ? info.warehouse.lastPrice : 0
        prevAvail = !!(prev?.warehouse?.available)
        newAvail = !!(hasWarehouse && info.warehouse.available)
      } else if (useWarehouse) {
        // Prefer Warehouse when present; otherwise fall back to main
        usingWh = hasWarehouse
        if (usingWh) {
          prevPrice = prev?.warehouse?.lastPrice ?? 0
          newPrice = info.warehouse.lastPrice
          prevAvail = !!(prev?.warehouse?.available)
          newAvail = !!info.warehouse.available
        } else {
          prevPrice = prev?.lastPrice ?? 0
          newPrice = info.lastPrice
          prevAvail = !!(prev?.available)
          newAvail = !!info.available
        }
      } else {
        // Main-only
        usingWh = false
        prevPrice = prev?.lastPrice ?? 0
        newPrice = info.lastPrice
        prevAvail = !!(prev?.available)
        newAvail = !!info.available
      }

      // Absolute threshold check
      const passesAbs = threshold ? (newPrice > 0 && newPrice <= threshold) : true
      // Percent-drop threshold check
      let passesDrop = true
      const td = items[i].thresholdDrop
      if (td && td > 0) {
        let basePrice = prevPrice || newPrice
        const baseSel = (items[i].baseline || 'last')
        if (baseSel === 'lowest' && state[finalUrl].lowestSeen?.price) basePrice = state[finalUrl].lowestSeen.price
        if (baseSel === 'start' && Array.isArray(state[finalUrl].history) && state[finalUrl].history.length > 0) basePrice = state[finalUrl].history[0].price || basePrice
        const target = basePrice * (1 - td / 100)
        passesDrop = newPrice > 0 && newPrice <= target
      }
      const passesThreshold = passesAbs && passesDrop
      const isBackInStock = prev && (prevAvail === false || prevAvail === 0 || prevAvail === undefined) && newAvail === true

      const whOnly = useWarehouse === 'only'
      // Clean, single-line status so users see why there may be no notifications yet
      if (config.debug) {
        const asin = extractAsin(finalUrl) || 'N/A'
        const alertsMode = (allowStockAlerts && allowPriceAlerts) ? 'both' : (allowStockAlerts ? 'stock' : (allowPriceAlerts ? 'price' : 'none'))
        const displayTitle = (label && label.trim().length > 0) ? label.trim() : (info.title || '').trim()
        const titleShort = displayTitle.length > 80 ? displayTitle.slice(0, 77) + '...' : (displayTitle || 'N/A')
        const src = usingWh ? 'Warehouse' : 'Main'
        const priceTxt = newPrice > 0 ? `${info.symbol}${newPrice.toFixed(2)}` : 'N/A'
        const statusTxt = newAvail ? `${COLORS.green}IN STOCK${COLORS.reset}` : `${COLORS.red}OUT${COLORS.reset}`
        const thrPart = (typeof threshold === 'number' && !isNaN(threshold))
          ? ` | threshold=${info.symbol}${threshold.toFixed(2)} ${passesThreshold ? '(met)' : '(not met)'}`
          : ''
        console.log(`${COLORS.magenta}[${new Date().toLocaleTimeString()}] [${i+1}/${items.length}] ${titleShort} (${asin}) — ${src} | ${priceTxt} | ${statusTxt}${thrPart} | alerts=${alertsMode}${COLORS.reset}`)
      }
      // If source went unavailable, clear lastNotified so a future restock notifies again
      if (notifyOnce && prev && prev.lastNotified && newAvail === false) {
        state[finalUrl].lastNotified = null
      }
      // Build a notify signature to avoid duplicate alerts when notifyOnce=true
      const sourceKey = usingWh ? 'warehouse' : 'main'
      const signature = `${sourceKey}|avail:${newAvail ? 1 : 0}|price:${Math.round(newPrice * 100)}`
      const lastSig = prev?.lastNotified

      // Update history and lowestSeen
      const chosenSource = usingWh ? 'warehouse' : 'main'
      const nowTs = Date.now()
      if (HISTORY_ENABLED) {
        const entry = { ts: nowTs, source: chosenSource, price: Number.isFinite(newPrice) ? Number(newPrice) : 0 }
        const hist = Array.isArray(state[finalUrl].history) ? state[finalUrl].history : []
        const lastEntry = hist.length > 0 ? hist[hist.length - 1] : null
        // Only record when something meaningful changed (price or source flip)
        const changed = !lastEntry || Number(lastEntry.price||0) !== Number(entry.price||0) || String(lastEntry.source||'') !== String(entry.source||'')
        // Outlier guard: require N consecutive scans for sudden changes
        let accept = changed
        if (changed && historyCfg.outlier_confirm_scans > 1 && lastEntry && Math.abs(Number(lastEntry.price||0) - Number(entry.price||0)) / Math.max(1, Number(lastEntry.price||1)) > 0.25) {
          const n = historyCfg.outlier_confirm_scans
          const lastN = hist.slice(-n+1).map(x=>Number(x.price||0))
          const consistent = lastN.every(p => Math.abs(p - Number(entry.price||0)) / Math.max(1,p) < 0.05)
          accept = consistent
        }
        if (accept) hist.push(entry)
        // Compression: keep full recent window, thin older to daily buckets when too large
        const maxPoints = Number.isFinite(historyCfg.max_points) ? historyCfg.max_points : 2000
        if (hist.length > maxPoints) {
          const keepMs = (historyCfg.keep_full_days||7) * 86400000
          const cutTs = Date.now() - keepMs
          const recent = hist.filter(h => h.ts >= cutTs)
          const older = hist.filter(h => h.ts < cutTs)
          const byDay = new Map()
          for (const h of older) {
            const day = new Date(new Date(h.ts).toISOString().slice(0,10)).getTime()
            const arr = byDay.get(day) || []
            arr.push(h); byDay.set(day, arr)
          }
          const compressed = []
          for (const [day, arr] of byDay.entries()) {
            arr.sort((a,b)=>a.ts-b.ts)
            const first = arr[0]
            const last = arr[arr.length-1]
            const min = arr.reduce((m,x)=> x.price < m.price ? x : m, arr[0])
            const max = arr.reduce((m,x)=> x.price > m.price ? x : m, arr[0])
            compressed.push(first, min, max, last)
          }
          compressed.sort((a,b)=>a.ts-b.ts)
          state[finalUrl].history = [...compressed, ...recent].slice(-maxPoints)
        } else {
          state[finalUrl].history = hist
        }
      } else {
        // When disabled, drop history to keep files small
        state[finalUrl].history = []
      }
      const ls = state[finalUrl].lowestSeen
      if (newPrice > 0 && (!ls || newPrice < ls.price || (ls.source !== chosenSource))) {
        state[finalUrl].lowestSeen = { source: chosenSource, price: Number(newPrice), ts: nowTs }
      }

      if (allowStockAlerts && isBackInStock && passesThreshold) {
        let desc = `Current Price: ${info.symbol}${newPrice.toFixed(2)}`
        if (usingWh) {
          const mainPrice = info?.lastPrice || 0
          if (mainPrice > 0 && newPrice > 0 && newPrice < mainPrice) {
            const diff = (mainPrice - newPrice).toFixed(2)
            desc = `Warehouse Price: ${info.symbol}${newPrice.toFixed(2)}\nMain Price: ${info.symbol}${mainPrice.toFixed(2)}\nSavings vs Main: ${info.symbol}${diff}`
          }
        }
        const titleLine = label ? `${label}` : `${info.title || 'N/A'}`
        if (!notifyOnce || signature !== lastSig) {
          await postWebhook({
          title: `Back in stock for "${info.title || 'N/A'}"${usingWh ? ' (Amazon Warehouse)' : ''}`,
          description: `${desc}\n\n${finalUrl}`,
          thumbnail: info.image ? { url: info.image } : undefined,
          color: 0x0099ff,
          })
          sent++
          state[finalUrl].lastNotified = signature
        }
      } else if (allowPriceAlerts && prev && newPrice > 0 && prevPrice > 0 && newPrice < prevPrice && passesThreshold) {
        const diff = (prev.lastPrice - info.lastPrice).toFixed(2)
        if (!notifyOnce || signature !== lastSig) {
          await postWebhook({
          title: `Price alert for "${info.title || 'N/A'}"${usingWh ? ' (Amazon Warehouse)' : ''}`,
          description: `Old Price: ${prev.symbol}${prevPrice.toFixed(2)}\nNew Price: ${info.symbol}${newPrice.toFixed(2)}\nDiff: ${info.symbol}${(prevPrice - newPrice).toFixed(2)}\n\n${finalUrl}`,
          thumbnail: info.image ? { url: info.image } : undefined,
          color: 0x00ff00,
          })
          sent++
          state[finalUrl].lastNotified = signature
        }
      } else if (prev && threshold && !(newPrice <= threshold) && config.debug) {
        dbg(`No alert due to threshold: current=${newPrice.toFixed(2)} > threshold=${threshold.toFixed(2)}`)
      } else if (config.debug && !allowPriceAlerts && !allowStockAlerts) {
        dbg('All alerts disabled for this item (alerts=none)')
      }
    } catch (e) {
      errors++
    }

    // Be polite between requests to reduce detection (skip after last item)
    if (i < items.length - 1) {
      if (config.debug) console.log(`${COLORS.yellow}[${new Date().toLocaleTimeString()}] Waiting ${secondsBetweenCheck}s… (${i+1}/${items.length} done)${COLORS.reset}`)
      await new Promise(r => setTimeout(r, secondsBetweenCheck * 1000))
    }
  }

  // Prune entries that are no longer in urls.txt (match by ASIN to survive param changes)
  const currentAsins = new Set(items.map(x => extractAsin(x.finalUrl)).filter(Boolean))
  let pruned = 0
  for (const key of Object.keys(state)) {
    const asin = extractAsin(key)
    if (!currentAsins.has(asin)) {
      delete state[key]
      pruned++
    }
  }

  saveWatch(state)
  const pruneMsg = pruned > 0 ? `, pruned=${pruned}` : ''
  lastScanAt = Date.now()
  if (softBanUntil && Date.now() < softBanUntil) {
    const mins = Math.ceil((softBanUntil - Date.now()) / 60000)
    console.log(`${COLORS.yellow}[${new Date().toLocaleTimeString()}] Scan halted due to soft-ban. Next automatic attempt in ~${mins} min${COLORS.reset}`)
  } else {
    console.log(`${COLORS.green}[${new Date().toLocaleTimeString()}] Scan complete: notifications sent=${sent}, errors=${errors}${pruneMsg}. Next in ${minutesPerCheck} min${COLORS.reset}`)
  }
}

async function main() {
  // initial seed + loop
  printBanner()
  await checkOnce()
  setInterval(checkOnce, minutesPerCheck * 60 * 1000)

  if (config.server) {
    const port = Number(config.port || 3000)
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`)
      if (url.pathname === '/' || url.pathname === '/index.html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(renderDashboardHtml())
        return
      }
      res.setHeader('Content-Type', 'application/json')
      if (url.pathname === '/api/status') {
        const now = Date.now()
        const coolingMs = Math.max(0, softBanUntil - now)
        const nextScanInMs = Math.max(0, (lastScanAt ? (lastScanAt + minutesPerCheck * 60 * 1000) - now : 0))
        res.end(JSON.stringify({
          minutesPerCheck,
          secondsBetweenCheck,
          lastScanAt,
          nextScanInMs,
          coolingMs,
        }))
        return
      }
      if (url.pathname === '/api/test' && req.method === 'POST') {
        // send a simple global test message
        postWebhook({ title: 'AmazonMonitor Test', description: 'This is a test alert from the server UI.' }).then(()=>{
          res.end(JSON.stringify({ ok: true }))
        }).catch(()=>{
          res.end(JSON.stringify({ ok: false }))
        })
        return
      }
      if (url.pathname === '/api/test' && req.method === 'POST' && url.searchParams.get('asin')) {
        // fallback; handled by query in next handler
      }
      if (url.pathname === '/api/test' && req.method === 'POST') {
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname === '/api/test' && req.method === 'GET') {
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname === '/api/test' && req.method === 'POST') {
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname === '/api/test' && req.method === 'POST') {
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname === '/api/test' && req.method === 'POST') {
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname === '/api/test' && req.method === 'POST') {
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname === '/api/test' && req.method === 'POST') {
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname === '/api/test' && req.method === 'POST') {
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname.startsWith('/api/test') && req.method === 'POST') {
        const asin = url.searchParams.get('asin')
        const msg = asin ? `Test alert for ASIN ${asin}` : 'Test alert'
        postWebhook({ title: 'AmazonMonitor Test', description: msg }).then(()=>{
          res.end(JSON.stringify({ ok: true }))
        }).catch(()=>{
          res.end(JSON.stringify({ ok: false }))
        })
        return
      }
      if (url.pathname === '/api/bulk' && req.method === 'PUT') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}')
            const { asins = [] } = data
            if (!Array.isArray(asins) || asins.length === 0) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'no items selected' })) }
            const p = new URL('./urls.txt', import.meta.url)
            const prev = fs.existsSync(p) ? fs.readFileSync(p).toString() : ''
            lastUrlsSnapshot = prev
            const lines = prev.split(/\r?\n/)
            const nextLines = lines.map(line => {
              const t = line.trim()
              if (!t) return line
              const asin = extractAsin(t)
              if (!asins.includes(asin)) return line
              const parts = t.split('|').map(s => s.trim())
              const head = parts[0]
              const tokens = []
              if (data.warehouse) tokens.push(`warehouse=${data.warehouse}`)
              if (data.alerts) tokens.push(`alerts=${data.alerts}`)
              if (typeof data.threshold === 'number' && !Number.isNaN(data.threshold)) tokens.push(`threshold=${Number(data.threshold).toFixed(2)}`)
              return head + (tokens.length ? '|' + tokens.join('|') : '')
            })
            fs.writeFileSync(p, nextLines.join('\n'))
            res.end(JSON.stringify({ ok: true }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid body' }))
          }
        })
        return
      }
      if (url.pathname === '/api/undo' && req.method === 'POST') {
        if (lastUrlsSnapshot != null) {
          const p = new URL('./urls.txt', import.meta.url)
          fs.writeFileSync(p, lastUrlsSnapshot)
          lastUrlsSnapshot = null
          res.end(JSON.stringify({ ok: true }))
        } else {
          res.end(JSON.stringify({ ok: false }))
        }
        return
      }
      if (url.pathname === '/api/items' && req.method === 'GET') {
        try {
          const entriesResult = readUrlsFile()
          const entries = Array.isArray(entriesResult) ? entriesResult : entriesResult.entries
          const state = loadWatch()
          const items = entries.map(e => {
            const urlStr = toProductUrl(e.value)
            const asin = extractAsin(e.value) || null
            const st = state[urlStr] || {}
            const currentSourceIsWh = st && st.warehouse && st.warehouse.lastPrice
            const currentPrice = currentSourceIsWh ? st.warehouse.lastPrice : st.lastPrice
            const currentAvail = currentSourceIsWh ? st.warehouse.available : st.available
            const symbol = st.symbol || '$'
            return {
              url: urlStr,
              asin,
              label: e.label || null,
              group: e.group || null,
              alerts: (e.allowStockAlerts && e.allowPriceAlerts) ? 'both' : (e.allowStockAlerts ? 'stock' : (e.allowPriceAlerts ? 'price' : 'none')),
              warehouse: e.useWarehouse === 'only' ? 'only' : (e.useWarehouse === true ? 'on' : (e.useWarehouse === false ? 'off' : (DEFAULT_WAREHOUSE ? 'on' : 'off'))),
              threshold: e.threshold ?? null,
              thresholdDrop: e.thresholdDrop ?? null,
              baseline: e.baseline || null,
              current: { price: currentPrice || 0, available: !!currentAvail, source: currentSourceIsWh ? 'warehouse' : 'main', symbol },
              lowestSeen: st.lowestSeen || null,
              history: st.history || []
            }
          })
          res.end(JSON.stringify({ items }))
        } catch (err) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'Failed to read items' }))
        }
        return
      }
      if (url.pathname === '/api/history' && req.method === 'GET') {
        const asin = url.searchParams.get('asin')
        if (!asin) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'asin required' })) }
        const state = loadWatch()
        // find by URL key that contains this ASIN
        const key = Object.keys(state).find(k => (k||'').includes(asin))
        const item = key ? state[key] : null
        if (!item) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' })) }
        if (!HISTORY_ENABLED) {
          return res.end(JSON.stringify({ history: [], lowestSeen: item.lowestSeen || null, symbol: item.symbol || '$', disabled: true }))
        }
        res.end(JSON.stringify({ history: item.history || [], lowestSeen: item.lowestSeen || null, symbol: item.symbol || '$' }))
        return
      }
      if (url.pathname === '/api/items' && req.method === 'POST') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}')
            const { urlOrAsin, label, group, warehouse, alerts, threshold, thresholdDrop, baseline } = data
            if (!urlOrAsin || typeof urlOrAsin !== 'string') {
              res.statusCode = 400
              return res.end(JSON.stringify({ error: 'urlOrAsin is required' }))
            }
            // Normalize line
            const tokens = []
            if (label) tokens.push(`label="${String(label).replace(/"/g,'\"')}"`)
            if (group) tokens.push(`group="${String(group).replace(/"/g,'\"')}"`)
            if (warehouse && ['on','off','only'].includes(String(warehouse))) tokens.push(`warehouse=${warehouse}`)
            if (alerts && ['stock','price','none'].includes(String(alerts))) tokens.push(`alerts=${alerts}`)
            if (typeof threshold === 'number' && !Number.isNaN(threshold)) tokens.push(`threshold=${Number(threshold).toFixed(2)}`)
            if (typeof thresholdDrop === 'number' && !Number.isNaN(thresholdDrop) && thresholdDrop > 0) tokens.push(`threshold_drop=${Number(thresholdDrop).toFixed(0)}%`)
            if (baseline && ['last','lowest','start'].includes(String(baseline))) tokens.push(`baseline=${baseline}`)
            const line = `${urlOrAsin}${tokens.length? '|' + tokens.join('|') : ''}`
            // Append to urls.txt
            const p = new URL('./urls.txt', import.meta.url)
            const prev = fs.existsSync(p) ? fs.readFileSync(p).toString() : ''
            const next = prev.endsWith('\n') || prev.length===0 ? prev + line + '\n' : prev + '\n' + line + '\n'
            fs.writeFileSync(p, next)
            res.end(JSON.stringify({ ok: true }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid body' }))
          }
        })
        return
      }
      if (url.pathname === '/api/items' && req.method === 'PUT') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
          try {
            const data = JSON.parse(body || '{}')
            const { asin } = data
            if (!asin) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'asin is required' })) }
            const p = new URL('./urls.txt', import.meta.url)
            const prev = fs.existsSync(p) ? fs.readFileSync(p).toString() : ''
            const lines = prev.split(/\r?\n/)
            let updated = false
            const nextLines = lines.map(l => {
              const t = l.trim()
              if (!t) return l
              const a = extractAsin(t)
              if (a !== asin) return l
              // Parse existing line to keep URL/ASIN as-is, then rebuild tokens
              const parts = t.split('|').map(s => s.trim())
              const head = parts[0]
              const tokens = []
              if (data.label) tokens.push(`label="${String(data.label).replace(/"/g,'\\"')}"`)
              if (data.group) tokens.push(`group="${String(data.group).replace(/"/g,'\\"')}"`)
              if (data.warehouse && ['on','off','only'].includes(String(data.warehouse))) tokens.push(`warehouse=${data.warehouse}`)
              if (data.alerts && ['stock','price','none'].includes(String(data.alerts))) tokens.push(`alerts=${data.alerts}`)
              if (typeof data.threshold === 'number' && !Number.isNaN(data.threshold)) tokens.push(`threshold=${Number(data.threshold).toFixed(2)}`)
              if (typeof data.thresholdDrop === 'number' && !Number.isNaN(data.thresholdDrop) && data.thresholdDrop > 0) tokens.push(`threshold_drop=${Number(data.thresholdDrop).toFixed(0)}%`)
              if (data.baseline && ['last','lowest','start'].includes(String(data.baseline))) tokens.push(`baseline=${data.baseline}`)
              updated = true
              return head + (tokens.length ? '|' + tokens.join('|') : '')
            })
            if (!updated) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'ASIN not found' })) }
            fs.writeFileSync(p, nextLines.join('\n'))
            res.end(JSON.stringify({ ok: true }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid body' }))
          }
        })
        return
      }
      if (url.pathname === '/api/scan' && req.method === 'POST') {
        setTimeout(() => { checkOnce().catch(()=>{}) }, 0)
        res.end(JSON.stringify({ ok: true }))
        return
      }
      if (url.pathname === '/api/items' && req.method === 'DELETE') {
        const asin = url.searchParams.get('asin')
        if (!asin) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'asin required' })) }
        try {
          const p = new URL('./urls.txt', import.meta.url)
          const prev = fs.existsSync(p) ? fs.readFileSync(p).toString() : ''
          const lines = prev.split(/\r?\n/)
          const kept = lines.filter(l => !l.trim() || extractAsin(l) !== asin)
          fs.writeFileSync(p, kept.join('\n'))
          res.end(JSON.stringify({ ok: true }))
        } catch(e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'Failed to delete' }))
        }
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: 'Not found' }))
    })
    server.listen(port, '127.0.0.1', () => {
      console.log(`${COLORS.cyan}Server running at http://127.0.0.1:${port}${COLORS.reset}`)
    })
  }
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})


