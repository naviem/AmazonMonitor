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
    let repeatAlertsToken = null
    let webhookIdToken = null
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
      } else if (key === 'repeat_alerts' || key === 'repeat') {
        repeatAlertsToken = val
      } else if (key === 'webhook' || key === 'webhook_id') {
        webhookIdToken = val
      }
    }
    const label = labelToken ? labelToken.replace(/^"|"$/g, '') : null
    const nv = (notifyOnceToken || '').toLowerCase()
    const notifyOnce = ['once', 'on', 'true', '1', 'yes', 'y'].includes(nv) ? true
      : ['repeat', 'off', 'false', '0', 'no', 'n'].includes(nv) ? false
      : false
    const group = groupToken ? groupToken.replace(/^"|"$/g, '') : null
    const rv = (repeatAlertsToken || '').toLowerCase()
    const repeatAlerts = ['on', 'true', '1', 'yes', 'y'].includes(rv) ? true
      : ['off', 'false', '0', 'no', 'n'].includes(rv) ? false
      : false
    const webhookId = webhookIdToken ? String(webhookIdToken).replace(/^"|"$/g, '') : null
    entries.push({ value, threshold: threshold ?? null, thresholdDrop: thresholdDrop ?? null, baseline: baseline || null, useWarehouse, allowStockAlerts, allowPriceAlerts, label, group, notifyOnce, repeatAlerts, webhookId })
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

function loadWebhooks() {
  const p = new URL('./webhooks.json', import.meta.url)
  if (!fs.existsSync(p)) {
    // Initialize with default webhook from config if present
    const initial = { webhooks: [], nextId: 1 }
    if (config.webhook_url) {
      initial.webhooks.push({
        id: 'default',
        name: 'Default Webhook',
        url: config.webhook_url,
        isDefault: true
      })
    }
    fs.writeFileSync(p, JSON.stringify(initial, null, 2))
    return initial
  }
  return JSON.parse(fs.readFileSync(p).toString())
}

function saveWebhooks(obj) {
  const p = new URL('./webhooks.json', import.meta.url)
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

async function postTelegram(message, imageUrl = null) {
  if (!config.telegram_bot_token || !config.telegram_chat_id) return
  
  const baseUrl = `https://api.telegram.org/bot${config.telegram_bot_token}`
  
  try {
    if (imageUrl) {
      // Send photo with caption
      await fetch(`${baseUrl}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegram_chat_id,
          photo: imageUrl,
          caption: message,
          parse_mode: 'HTML'
        })
      })
    } else {
      // Send text message
      await fetch(`${baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.telegram_chat_id,
          text: message,
          parse_mode: 'HTML'
        })
      })
    }
  } catch (error) {
    dbg(`Telegram notification failed: ${error.message}`)
  }
}

async function searchAmazonProducts(query) {
  const searchUrl = `https://www.amazon.${config.tld}/s?k=${encodeURIComponent(query)}&ref=sr_pg_1`
  
  try {
    const { $, softBan } = await fetchPage(searchUrl)
    if (softBan) return { error: 'Amazon search blocked (rate limited)' }
    
    const results = []
    const productElements = $('[data-component-type="s-search-result"]').slice(0, 10) // Limit to 10 results
    
    productElements.each((i, elem) => {
      const $product = $(elem)
      const titleElement = $product.find('h2 a span')
      const title = titleElement.first().text().trim()
      
      const priceElement = $product.find('.a-price .a-offscreen').first()
      const price = priceElement.text().trim()
      
      const linkElement = $product.find('h2 a')
      const href = linkElement.attr('href')
      const asin = href ? extractAsin(`https://www.amazon.${config.tld}${href}`) : null
      
      const imageElement = $product.find('img').first()
      const image = imageElement.attr('src') || imageElement.attr('data-src')
      
      if (title && asin) {
        results.push({
          asin,
          title,
          price: price || 'Price not available',
          image: image || null,
          url: `https://www.amazon.${config.tld}/dp/${asin}`
        })
      }
    })
    
    return { results }
  } catch (error) {
    return { error: `Search failed: ${error.message}` }
  }
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
    repeatAlerts: !!e.repeatAlerts,
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
    const { finalUrl, threshold, useWarehouse, allowStockAlerts, allowPriceAlerts, label, notifyOnce, repeatAlerts } = items[i]
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
        repeatAlerts: !!repeatAlerts,
        lowestSeen: state[finalUrl]?.lowestSeen || null,
        history: state[finalUrl]?.history || [],
      }

      // Prepare data for both sources when warehouse tracking is enabled
      const modeWarehouseOnly = useWarehouse === 'only'
      const modeWarehouseOff = useWarehouse === false || useWarehouse === 'off'
      const hasWarehouse = !!info.warehouse

      // Main source data
      const mainPrevPrice = prev?.lastPrice ?? 0
      const mainNewPrice = info.lastPrice ?? 0
      const mainPrevAvail = !!(prev?.available)
      const mainNewAvail = !!info.available

      // Warehouse source data
      const whPrevPrice = prev?.warehouse?.lastPrice ?? 0
      const whNewPrice = hasWarehouse ? (info.warehouse.lastPrice ?? 0) : 0
      const whPrevAvail = !!(prev?.warehouse?.available)
      const whNewAvail = !!(hasWarehouse && info.warehouse.available)

      // Determine which sources to check for alerts
      const checkMain = !modeWarehouseOnly
      const checkWarehouse = !modeWarehouseOff && hasWarehouse

      // Helper function to check if price passes thresholds
      const passesThresholds = (price, prevPrice) => {
        const passesAbs = threshold ? (price > 0 && price <= threshold) : true
        let passesDrop = true
        const td = items[i].thresholdDrop
        if (td && td > 0) {
          let basePrice = prevPrice || price
          const baseSel = (items[i].baseline || 'last')
          if (baseSel === 'lowest' && state[finalUrl].lowestSeen?.price) basePrice = state[finalUrl].lowestSeen.price
          if (baseSel === 'start' && Array.isArray(state[finalUrl].history) && state[finalUrl].history.length > 0) basePrice = state[finalUrl].history[0].price || basePrice
          const target = basePrice * (1 - td / 100)
          passesDrop = price > 0 && price <= target
        }
        return passesAbs && passesDrop
      }

      // Debug logging - show best available price
      if (config.debug) {
        const asin = extractAsin(finalUrl) || 'N/A'
        const alertsMode = (allowStockAlerts && allowPriceAlerts) ? 'both' : (allowStockAlerts ? 'stock' : (allowPriceAlerts ? 'price' : 'none'))
        const displayTitle = (label && label.trim().length > 0) ? label.trim() : (info.title || '').trim()
        const titleShort = displayTitle.length > 80 ? displayTitle.slice(0, 77) + '...' : (displayTitle || 'N/A')

        // Show best price (warehouse if available and cheaper, otherwise main)
        let src = 'Main'
        let priceTxt = mainNewPrice > 0 ? `${info.symbol}${mainNewPrice.toFixed(2)}` : 'N/A'
        let statusTxt = mainNewAvail ? `${COLORS.green}IN STOCK${COLORS.reset}` : `${COLORS.red}OUT${COLORS.reset}`
        let bestPrice = mainNewPrice

        if (hasWarehouse && whNewPrice > 0) {
          if (!modeWarehouseOff) {
            src = 'Warehouse'
            priceTxt = `${info.symbol}${whNewPrice.toFixed(2)}`
            statusTxt = whNewAvail ? `${COLORS.green}IN STOCK${COLORS.reset}` : `${COLORS.red}OUT${COLORS.reset}`
            bestPrice = whNewPrice
          }
        }

        const passesThreshold = passesThresholds(bestPrice, src === 'Warehouse' ? whPrevPrice : mainPrevPrice)
        const thrPart = (typeof threshold === 'number' && !isNaN(threshold))
          ? ` | threshold=${info.symbol}${threshold.toFixed(2)} ${passesThreshold ? '(met)' : '(not met)'}`
          : ''
        console.log(`${COLORS.magenta}[${new Date().toLocaleTimeString()}] [${i+1}/${items.length}] ${titleShort} (${asin}) — ${src} | ${priceTxt} | ${statusTxt}${thrPart} | alerts=${alertsMode}${COLORS.reset}`)
      }

      // Tracking for notifyOnce - separate for each source
      const mainSig = `main|avail:${mainNewAvail ? 1 : 0}|price:${Math.round(mainNewPrice * 100)}`
      const whSig = `warehouse|avail:${whNewAvail ? 1 : 0}|price:${Math.round(whNewPrice * 100)}`
      const lastMainSig = prev?.lastNotifiedMain
      const lastWhSig = prev?.lastNotifiedWarehouse

      // Update history and lowestSeen - track best available price
      const nowTs = Date.now()
      if (HISTORY_ENABLED) {
        const hist = Array.isArray(state[finalUrl].history) ? state[finalUrl].history : []
        const lastEntry = hist.length > 0 ? hist[hist.length - 1] : null

        // Determine which source to record (best available price)
        let recordSource = 'main'
        let recordPrice = mainNewPrice
        if (checkWarehouse && whNewPrice > 0 && (whNewPrice < mainNewPrice || mainNewPrice === 0)) {
          recordSource = 'warehouse'
          recordPrice = whNewPrice
        }

        const entry = { ts: nowTs, source: recordSource, price: Number.isFinite(recordPrice) ? Number(recordPrice) : 0 }
        const changed = !lastEntry || Number(lastEntry.price||0) !== Number(entry.price||0) || String(lastEntry.source||'') !== String(entry.source||'')

        let accept = changed
        if (changed && historyCfg.outlier_confirm_scans > 1 && lastEntry && Math.abs(Number(lastEntry.price||0) - Number(entry.price||0)) / Math.max(1, Number(lastEntry.price||1)) > 0.25) {
          const n = historyCfg.outlier_confirm_scans
          const lastN = hist.slice(-n+1).map(x=>Number(x.price||0))
          const consistent = lastN.every(p => Math.abs(p - Number(entry.price||0)) / Math.max(1,p) < 0.05)
          accept = consistent
        }
        if (accept) hist.push(entry)

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
        state[finalUrl].history = []
      }

      // Update lowestSeen for both sources
      const ls = state[finalUrl].lowestSeen
      if (checkMain && mainNewPrice > 0 && (!ls || mainNewPrice < ls.price)) {
        state[finalUrl].lowestSeen = { source: 'main', price: Number(mainNewPrice), ts: nowTs }
      }
      if (checkWarehouse && whNewPrice > 0 && (!ls || whNewPrice < ls.price)) {
        state[finalUrl].lowestSeen = { source: 'warehouse', price: Number(whNewPrice), ts: nowTs }
      }

      // Build offer listing URL (aod=1 opens All Offers Display on mobile & desktop)
      const asin = extractAsin(finalUrl)
      const offerListingUrl = asin ? `https://www.amazon.${config.tld}/dp/${asin}?aod=1&psc=1` : null

      // Check MAIN source for alerts
      if (checkMain) {
        const mainPassesThreshold = passesThresholds(mainNewPrice, mainPrevPrice)
        const mainIsBackInStock = prev && !mainPrevAvail && mainNewAvail

        // Stock alert for main
        if (allowStockAlerts && mainIsBackInStock && mainPassesThreshold) {
          if (!notifyOnce || mainSig !== lastMainSig || (repeatAlerts && mainNewAvail && mainPassesThreshold)) {
            const offerLink = offerListingUrl ? `\n\n[View All Offers](${offerListingUrl})` : ''
            const embed = {
              title: `Back in stock for "${info.title || 'N/A'}"`,
              description: `Current Price: ${info.symbol}${mainNewPrice.toFixed(2)}\n\n[View Product](${finalUrl})${offerLink}`,
              thumbnail: info.image ? { url: info.image } : undefined,
              color: 0x0099ff,
            }
            await postWebhook(embed)
            const offerLinkTg = offerListingUrl ? `\n🛍️ <a href="${offerListingUrl}">View All Offers</a>` : ''
            const telegramMessage = `🛒 <b>Back in Stock!</b>\n\n<b>${info.title || 'N/A'}</b>\n\n💰 <b>Price:</b> ${info.symbol}${mainNewPrice.toFixed(2)}\n🔗 <a href="${finalUrl}">View Product</a>${offerLinkTg}`
            await postTelegram(telegramMessage, info.image)
            sent++
            state[finalUrl].lastNotifiedMain = mainSig
          }
        }
        // Price alert for main
        else if (allowPriceAlerts && mainNewPrice > 0 && mainPassesThreshold && (!prev || mainPrevPrice === 0 || (mainPrevPrice > 0 && mainNewPrice < mainPrevPrice))) {
          if (!notifyOnce || mainSig !== lastMainSig || (repeatAlerts && mainNewAvail && mainPassesThreshold)) {
            const isFirstDetection = !prev || mainPrevPrice === 0
            const diff = isFirstDetection ? '0.00' : (mainPrevPrice - mainNewPrice).toFixed(2)
            const offerLink = offerListingUrl ? `\n\n[View All Offers](${offerListingUrl})` : ''
            const embed = {
              title: `Price alert for "${info.title || 'N/A'}"`,
              description: isFirstDetection
                ? `Current Price: ${info.symbol}${mainNewPrice.toFixed(2)}\n\n[View Product](${finalUrl})${offerLink}`
                : `Old Price: ${info.symbol}${mainPrevPrice.toFixed(2)}\nNew Price: ${info.symbol}${mainNewPrice.toFixed(2)}\nDiff: ${info.symbol}${diff}\n\n[View Product](${finalUrl})${offerLink}`,
              thumbnail: info.image ? { url: info.image } : undefined,
              color: 0x00ff00,
            }
            await postWebhook(embed)
            const offerLinkTg = offerListingUrl ? `\n🛍️ <a href="${offerListingUrl}">View All Offers</a>` : ''
            const telegramMessage = isFirstDetection
              ? `💰 <b>Price Alert!</b>\n\n<b>${info.title || 'N/A'}</b>\n\n💸 <b>Current Price:</b> ${info.symbol}${mainNewPrice.toFixed(2)}\n🔗 <a href="${finalUrl}">Buy Now</a>${offerLinkTg}`
              : (() => {
                  const discount = ((mainPrevPrice - mainNewPrice) / mainPrevPrice * 100).toFixed(1)
                  return `📉 <b>Price Drop Alert!</b>\n\n<b>${info.title || 'N/A'}</b>\n\n💰 <b>Old Price:</b> ${info.symbol}${mainPrevPrice.toFixed(2)}\n💸 <b>New Price:</b> ${info.symbol}${mainNewPrice.toFixed(2)}\n🔥 <b>Savings:</b> ${info.symbol}${diff} (${discount}% off)\n🔗 <a href="${finalUrl}">Buy Now</a>${offerLinkTg}`
                })()
            await postTelegram(telegramMessage, info.image)
            sent++
            state[finalUrl].lastNotifiedMain = mainSig
          }
        }
      }

      // Check WAREHOUSE source for alerts
      if (checkWarehouse) {
        const whPassesThreshold = passesThresholds(whNewPrice, whPrevPrice)
        const whIsBackInStock = prev && !whPrevAvail && whNewAvail

        // Stock alert for warehouse
        if (allowStockAlerts && whIsBackInStock && whPassesThreshold) {
          if (!notifyOnce || whSig !== lastWhSig || (repeatAlerts && whNewAvail && whPassesThreshold)) {
            let desc = `Warehouse Price: ${info.symbol}${whNewPrice.toFixed(2)}`
            if (mainNewPrice > 0 && whNewPrice < mainNewPrice) {
              const diff = (mainNewPrice - whNewPrice).toFixed(2)
              desc = `Warehouse Price: ${info.symbol}${whNewPrice.toFixed(2)}\nMain Price: ${info.symbol}${mainNewPrice.toFixed(2)}\nSavings vs Main: ${info.symbol}${diff}`
            }
            const offerLink = offerListingUrl ? `\n\n[View All Offers](${offerListingUrl})` : ''
            const embed = {
              title: `Back in stock for "${info.title || 'N/A'}" (Amazon Warehouse)`,
              description: `${desc}\n\n[View Product](${finalUrl})${offerLink}`,
              thumbnail: info.image ? { url: info.image } : undefined,
              color: 0x0099ff,
            }
            await postWebhook(embed)
            const offerLinkTg = offerListingUrl ? `\n🛍️ <a href="${offerListingUrl}">View All Offers</a>` : ''
            const telegramMessage = `🛒 <b>Back in Stock!</b>\n\n<b>${info.title || 'N/A'}</b> (Amazon Warehouse)\n\n💰 <b>Price:</b> ${info.symbol}${whNewPrice.toFixed(2)}\n🔗 <a href="${finalUrl}">View Product</a>${offerLinkTg}`
            await postTelegram(telegramMessage, info.image)
            sent++
            state[finalUrl].lastNotifiedWarehouse = whSig
          }
        }
        // Price alert for warehouse
        else if (allowPriceAlerts && whNewPrice > 0 && whPassesThreshold && (!prev || whPrevPrice === 0 || (whPrevPrice > 0 && whNewPrice < whPrevPrice))) {
          if (!notifyOnce || whSig !== lastWhSig || (repeatAlerts && whNewAvail && whPassesThreshold)) {
            const isFirstDetection = !prev || whPrevPrice === 0
            const diff = isFirstDetection ? '0.00' : (whPrevPrice - whNewPrice).toFixed(2)
            const offerLink = offerListingUrl ? `\n\n[View All Offers](${offerListingUrl})` : ''
            const embed = {
              title: `Price alert for "${info.title || 'N/A'}" (Amazon Warehouse)`,
              description: isFirstDetection
                ? `Current Price: ${info.symbol}${whNewPrice.toFixed(2)}\n\n[View Product](${finalUrl})${offerLink}`
                : `Old Price: ${info.symbol}${whPrevPrice.toFixed(2)}\nNew Price: ${info.symbol}${whNewPrice.toFixed(2)}\nDiff: ${info.symbol}${diff}\n\n[View Product](${finalUrl})${offerLink}`,
              thumbnail: info.image ? { url: info.image } : undefined,
              color: 0x00ff00,
            }
            await postWebhook(embed)
            const offerLinkTg = offerListingUrl ? `\n🛍️ <a href="${offerListingUrl}">View All Offers</a>` : ''
            const telegramMessage = isFirstDetection
              ? `💰 <b>Price Alert!</b>\n\n<b>${info.title || 'N/A'}</b> (Amazon Warehouse)\n\n💸 <b>Current Price:</b> ${info.symbol}${whNewPrice.toFixed(2)}\n🔗 <a href="${finalUrl}">Buy Now</a>${offerLinkTg}`
              : (() => {
                  const discount = ((whPrevPrice - whNewPrice) / whPrevPrice * 100).toFixed(1)
                  return `📉 <b>Price Drop Alert!</b>\n\n<b>${info.title || 'N/A'}</b> (Amazon Warehouse)\n\n💰 <b>Old Price:</b> ${info.symbol}${whPrevPrice.toFixed(2)}\n💸 <b>New Price:</b> ${info.symbol}${whNewPrice.toFixed(2)}\n🔥 <b>Savings:</b> ${info.symbol}${diff} (${discount}% off)\n🔗 <a href="${finalUrl}">Buy Now</a>${offerLinkTg}`
                })()
            await postTelegram(telegramMessage, info.image)
            sent++
            state[finalUrl].lastNotifiedWarehouse = whSig
          }
        }
      }

      // Debug logging for threshold failures
      if (config.debug && threshold && !allowPriceAlerts && !allowStockAlerts) {
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
        const dashboardPath = new URL('./dashboard.html', import.meta.url)
        const html = fs.readFileSync(dashboardPath, 'utf-8')
        res.end(html)
        return
      }
      if (url.pathname === '/dashboard.js') {
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        const jsPath = new URL('./dashboard.js', import.meta.url)
        const js = fs.readFileSync(jsPath, 'utf-8')
        res.end(js)
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
          tld: config.tld || 'com',
        }))
        return
      }
      // Webhooks API
      if (url.pathname === '/api/webhooks' && req.method === 'GET') {
        try {
          const data = loadWebhooks()
          res.end(JSON.stringify({ webhooks: data.webhooks || [] }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'Failed to load webhooks' }))
        }
        return
      }
      if (url.pathname === '/api/webhooks' && req.method === 'POST') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
          try {
            const { name, url: webhookUrl } = JSON.parse(body || '{}')
            if (!name || !webhookUrl) {
              res.statusCode = 400
              return res.end(JSON.stringify({ error: 'name and url are required' }))
            }
            const data = loadWebhooks()
            const newId = String(data.nextId || 1)
            const isFirstWebhook = data.webhooks.length === 0
            data.webhooks.push({
              id: newId,
              name: String(name),
              url: String(webhookUrl),
              isDefault: isFirstWebhook
            })
            data.nextId = (data.nextId || 1) + 1
            saveWebhooks(data)
            res.end(JSON.stringify({ ok: true, id: newId }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid request' }))
          }
        })
        return
      }
      if (url.pathname.startsWith('/api/webhooks/') && url.pathname.endsWith('/default') && req.method === 'PUT') {
        try {
          const id = url.pathname.split('/')[3]
          const data = loadWebhooks()
          const found = data.webhooks.find(w => w.id === id)
          if (!found) {
            res.statusCode = 404
            return res.end(JSON.stringify({ error: 'Webhook not found' }))
          }
          data.webhooks.forEach(w => { w.isDefault = false })
          found.isDefault = true
          saveWebhooks(data)
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'Failed to set default' }))
        }
        return
      }
      if (url.pathname.startsWith('/api/webhooks/') && req.method === 'DELETE') {
        try {
          const id = url.pathname.split('/')[3]
          const data = loadWebhooks()
          const index = data.webhooks.findIndex(w => w.id === id)
          if (index === -1) {
            res.statusCode = 404
            return res.end(JSON.stringify({ error: 'Webhook not found' }))
          }
          const wasDefault = data.webhooks[index].isDefault
          data.webhooks.splice(index, 1)
          // If deleted webhook was default, make first remaining webhook default
          if (wasDefault && data.webhooks.length > 0) {
            data.webhooks[0].isDefault = true
          }
          saveWebhooks(data)
          res.end(JSON.stringify({ ok: true }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'Failed to delete webhook' }))
        }
        return
      }
      // Settings API
      if (url.pathname === '/api/settings' && req.method === 'GET') {
        try {
          res.end(JSON.stringify({
            minutes_per_check: minutesPerCheck,
            seconds_between_check: secondsBetweenCheck,
            tld: config.tld || 'com',
            telegram_bot_token: config.telegram_bot_token || '',
            telegram_chat_id: config.telegram_chat_id || '',
            history_enabled: HISTORY_ENABLED,
            history_days: historyCfg.keep_full_days,
            history_limit: historyCfg.max_points,
            history_noise_protection: historyCfg.outlier_confirm_scans > 1,
            user_agent_strategy: UA_STRATEGY,
            debug: !!config.debug
          }))
        } catch (e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'Failed to load settings' }))
        }
        return
      }
      if (url.pathname === '/api/settings' && req.method === 'PUT') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
          try {
            const updates = JSON.parse(body || '{}')
            const configPath = new URL('./config.json', import.meta.url)
            const currentConfig = readConfig(configPath)

            // Update allowed fields
            if (typeof updates.minutes_per_check === 'number' && updates.minutes_per_check >= 10) {
              currentConfig.minutes_per_check = updates.minutes_per_check
            }
            if (typeof updates.seconds_between_check === 'number' && updates.seconds_between_check >= 60) {
              currentConfig.seconds_between_check = updates.seconds_between_check
            }
            if (typeof updates.tld === 'string' && updates.tld.length > 0) {
              currentConfig.tld = updates.tld
            }
            if (updates.telegram_bot_token !== undefined) {
              currentConfig.telegram_bot_token = updates.telegram_bot_token || ''
            }
            if (updates.telegram_chat_id !== undefined) {
              currentConfig.telegram_chat_id = updates.telegram_chat_id || ''
            }
            if (typeof updates.history_days === 'number' && updates.history_days >= 0) {
              currentConfig.history_days = updates.history_days
            }
            if (typeof updates.history_limit === 'number' && updates.history_limit > 0) {
              currentConfig.history_limit = updates.history_limit
            }
            if (typeof updates.history_noise_protection === 'boolean') {
              currentConfig.history_noise_protection = updates.history_noise_protection
            }
            if (typeof updates.user_agent_strategy === 'string') {
              currentConfig.user_agent_strategy = updates.user_agent_strategy
            }
            if (typeof updates.debug === 'boolean') {
              currentConfig.debug = updates.debug
            }

            // Write updated config back to file
            fs.writeFileSync(configPath, JSON.stringify(currentConfig, null, 2))
            res.end(JSON.stringify({ ok: true }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid request: ' + e.message }))
          }
        })
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
              title: st.title || null,
              label: e.label || null,
              group: e.group || null,
              image: st.image || null,
              alerts: (e.allowStockAlerts && e.allowPriceAlerts) ? 'both' : (e.allowStockAlerts ? 'stock' : (e.allowPriceAlerts ? 'price' : 'none')),
              warehouse: e.useWarehouse === 'only' ? 'only' : (e.useWarehouse === true ? 'on' : (e.useWarehouse === false ? 'off' : (DEFAULT_WAREHOUSE ? 'on' : 'off'))),
              useWarehouse: currentSourceIsWh,
              threshold: e.threshold ?? null,
              thresholdDrop: e.thresholdDrop ?? null,
              baseline: e.baseline || null,
              currentPrice: currentPrice || 0,
              oldPrice: st.lastPrice || 0,
              available: !!currentAvail,
              symbol: symbol,
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
            const { urlOrAsin, label, group, warehouse, alerts, threshold, thresholdDrop, baseline, repeatAlerts, notifyOnce } = data
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
            if (repeatAlerts === true || repeatAlerts === 'on') tokens.push(`repeat_alerts=on`)
            if (notifyOnce === true || notifyOnce === 'once') tokens.push(`notify=once`)
            const line = `${urlOrAsin}${tokens.length? '|' + tokens.join('|') : ''}`
            // Append to urls.txt
            const p = new URL('./urls.txt', import.meta.url)
            const prev = fs.existsSync(p) ? fs.readFileSync(p).toString() : ''
            const next = prev.endsWith('\n') || prev.length===0 ? prev + line + '\n' : prev + '\n' + line + '\n'
            fs.writeFileSync(p, next)
            
            // Immediately fetch product info for better UX
            const asin = extractAsin(urlOrAsin)
            if (asin) {
              // Trigger immediate scan for this product in the background
              setImmediate(async () => {
                try {
                  const productUrl = `https://www.amazon.${config.tld}/dp/${asin}`
                  const { $, softBan } = await fetchPage(productUrl)
                  if (!softBan && $) {
                    const info = await parseItem($, productUrl, false)
                    if (info.title) {
                      // Store in watch.json immediately
                      const state = loadWatch()
                      if (!state[productUrl]) {
                        state[productUrl] = {
                          lastPrice: info.price,
                          symbol: info.symbol,
                          title: info.title,
                          image: info.image,
                          available: info.available,
                          warehouse: info.warehouse || null,
                          threshold: null,
                          thresholdDrop: null,
                          baseline: null,
                          useWarehouse: config.default_warehouse,
                          alerts: 'both',
                          label: label || null,
                          group: group || null,
                          notifyOnce: false,
                          lowestSeen: { source: 'main', price: info.price, ts: Date.now() },
                          history: [{ ts: Date.now(), source: 'main', price: info.price }]
                        }
                        saveWatch(state)
                        log(`✓ Immediately fetched info for new product: ${info.title}`)
                      }
                    }
                  }
                } catch (e) {
                  log(`Failed to immediately fetch product info: ${e.message}`)
                }
              })
            }
            
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
              if (data.repeatAlerts === true || data.repeatAlerts === 'on') tokens.push(`repeat_alerts=on`)
              if (data.notifyOnce === true || data.notifyOnce === 'once') tokens.push(`notify=once`)
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
          const kept = lines.filter(l => {
            if (!l.trim()) return true
            const parts = l.split('|').map(x => x.trim())
            const lineAsin = extractAsin(parts[0])
            return lineAsin !== asin
          })
          fs.writeFileSync(p, kept.join('\n'))
          res.end(JSON.stringify({ ok: true }))
        } catch(e) {
          res.statusCode = 500
          res.end(JSON.stringify({ error: 'Failed to delete' }))
        }
        return
      }
      if (url.pathname === '/api/search' && req.method === 'POST') {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', async () => {
          try {
            const data = JSON.parse(body || '{}')
            const { query } = data
            if (!query || typeof query !== 'string') {
              res.statusCode = 400
              return res.end(JSON.stringify({ error: 'query is required' }))
            }
            
            // Check if it's a URL or ASIN first
            const asin = extractAsin(query)
            if (asin) {
              try {
                const productUrl = `https://www.amazon.${config.tld}/dp/${asin}`
                const { $, softBan } = await fetchPage(productUrl)
                if (!softBan) {
                  const info = await parseItem($, productUrl, false)
                  if (info.title) {
                    res.end(JSON.stringify({ 
                      results: [{
                        asin,
                        title: info.title,
                        price: info.price ? `${info.symbol}${parseFloat(info.price).toFixed(2)}` : 'Price unavailable',
                        image: info.image,
                        url: productUrl
                      }]
                    }))
                    return
                  }
                }
              } catch {}
            }
            
            // Otherwise perform Amazon search
            const searchResult = await searchAmazonProducts(query)
            res.end(JSON.stringify(searchResult))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid request' }))
          }
        })
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


