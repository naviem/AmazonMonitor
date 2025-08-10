import fs from 'fs'
import { load } from 'cheerio'

const config = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url)).toString())
const MIN_MINUTES = 10
const MIN_DELAY_SEC = 60
const minutesPerCheck = Math.max(Number(config.minutes_per_check || MIN_MINUTES), MIN_MINUTES)
const secondsBetweenCheck = Math.max(Number(config.seconds_between_check || MIN_DELAY_SEC), MIN_DELAY_SEC)

function log(msg) {
  const ts = new Date().toLocaleTimeString()
  console.log(`[${ts}] ${msg}`)
}

function dbg(msg) {
  if (config.debug) log(msg)
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
  const meta2 = `TLD: ${config.tld}  |  Warehouse tracking: ${config.warehouse ? 'ON' : 'OFF'}`

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
  console.log(dim + 'Tip: add |PRICE after a URL/ASIN in urls.txt to set a per-item threshold.' + reset)
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
  if (!res.ok) return null
  const html = await res.text()
  return load(html)
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
      dbg(`Fetching AOD endpoint: ${url}`)
      const res = await fetch(url, { headers, redirect: 'follow' })
      if (!res.ok) continue
      const html = await res.text()
      const $ = load(html)
      const count = $('#aod-offer, .aod-offer').length
      dbg(`AOD endpoint returned ${count} offers`)
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

async function parseItem($, url) {
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
  }

  // Optionally parse AOD for Amazon Warehouse price
  if (config.warehouse) {
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
        }
      }
    })
    dbg(`AOD offers in DOM: ${$nodes.length}`)
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
        dbg(`AOD offers via ajax: ${$items.length}`)
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

function readUrlsFile() {
  const p = new URL('./urls.txt', import.meta.url)
  if (!fs.existsSync(p)) return []
  const raw = fs.readFileSync(p).toString()
  const lines = raw.split(/\r?\n/)
  const entries = []
  for (const line of lines) {
    const l = line.trim()
    if (!l || l.startsWith('#')) continue
    // Support threshold via pipe: URL|299.99 or ASIN|299.99
    const parts = l.split('|').map(x => x.trim())
    const value = parts[0]
    const threshold = parts[1] ? parseFloat(parts[1]) : null
    entries.push({ value, threshold: isNaN(threshold) ? null : threshold })
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
  const entries = readUrlsFile()
  const items = entries.map(e => ({
    finalUrl: appendParams(toProductUrl(e.value), config.url_params),
    threshold: e.threshold,
  }))
  if (items.length === 0) {
    log('Scan skipped: no URLs found in urls.txt')
    return
  }
  log(`Scan started: ${items.length} item(s)`) 

  const state = loadWatch() // { [url]: { lastPrice, symbol, title, image } }
  let sent = 0
  let errors = 0

  for (let i = 0; i < items.length; i++) {
    const { finalUrl, threshold } = items[i]
    try {
      const $ = await fetchPage(finalUrl)
      if (!$) {
        errors++
        continue
      }
      const info = await parseItem($, finalUrl)
      if (config.debug) dbg(`ASIN detected: ${extractAsin(finalUrl) || 'N/A'}`)

      const prev = state[finalUrl]
      state[finalUrl] = {
        lastPrice: info.lastPrice,
        symbol: info.symbol,
        title: info.title,
        image: info.image,
        warehouse: info.warehouse || null,
        threshold: threshold,
      }

      const prevPrice = prev?.warehouse && info.warehouse ? prev.warehouse.lastPrice : prev?.lastPrice
      const newPrice = info?.warehouse ? info.warehouse.lastPrice : info.lastPrice

      const passesThreshold = threshold ? newPrice <= threshold : true
      if (prev && newPrice > 0 && prevPrice > 0 && newPrice < prevPrice && passesThreshold) {
        const diff = (prev.lastPrice - info.lastPrice).toFixed(2)
        await postWebhook({
          title: `Price alert for "${info.title || 'N/A'}"${info.warehouse ? ' (Amazon Warehouse)' : ''}`,
          description: `Old Price: ${prev.symbol}${prevPrice.toFixed(2)}\nNew Price: ${info.symbol}${newPrice.toFixed(2)}\nDiff: ${info.symbol}${(prevPrice - newPrice).toFixed(2)}\n\n${finalUrl}`,
          thumbnail: info.image ? { url: info.image } : undefined,
          color: 0x00ff00,
        })
        sent++
      } else if (prev && threshold && !(newPrice <= threshold) && config.debug) {
        dbg(`No alert due to threshold: current=${newPrice.toFixed(2)} > threshold=${threshold.toFixed(2)}`)
      }
    } catch (e) {
      errors++
    }

    // Be polite between requests to reduce detection (skip after last item)
    if (i < items.length - 1) {
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
  log(`Scan complete: notifications sent=${sent}, errors=${errors}${pruneMsg}. Next in ${minutesPerCheck} min`)
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


