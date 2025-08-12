import fs from 'fs'
import { load } from 'cheerio'

const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)).toString())
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

const userAgents = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
]
// Keep a stable UA across runs to look less bot-like
const STABLE_UA = userAgents[Math.floor(Math.random() * userAgents.length)]
// Soft-ban cooldown end timestamp (ms since epoch); when > now, scans are skipped
let softBanUntil = 0

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

  const ua = STABLE_UA
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

  const res = await fetch(reqUrl, { headers, redirect: 'follow' })
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
    'User-Agent': STABLE_UA,
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
      const res = await fetch(url, { headers, redirect: 'follow' })
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
    let useWarehouse = null // null = use global default
    let allowStockAlerts = true
    let allowPriceAlerts = true
    let labelToken = null
    let notifyOnceToken = null
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
      }
    }
    const label = labelToken ? labelToken.replace(/^"|"$/g, '') : null
    const nv = (notifyOnceToken || '').toLowerCase()
    const notifyOnce = ['once', 'on', 'true', '1', 'yes', 'y'].includes(nv) ? true
      : ['repeat', 'off', 'false', '0', 'no', 'n'].includes(nv) ? false
      : false
    entries.push({ value, threshold: threshold ?? null, useWarehouse, allowStockAlerts, allowPriceAlerts, label, notifyOnce })
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
    useWarehouse: (e.useWarehouse === null || e.useWarehouse === undefined)
      ? DEFAULT_WAREHOUSE
      : e.useWarehouse,
    allowStockAlerts: e.allowStockAlerts,
    allowPriceAlerts: e.allowPriceAlerts,
    label: e.label || null,
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
        useWarehouse: useWarehouse,
        alerts: alertsMode,
        label: label || null,
        notifyOnce: !!notifyOnce,
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

      const passesThreshold = threshold ? (newPrice > 0 && newPrice <= threshold) : true
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
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})


