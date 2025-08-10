Amazon Simple Monitor (HTTP + Cheerio + Discord Webhook)
=======================================================

A lightweight, browserless Amazon price monitor. Tracks exact products you list, optionally targets Amazon Warehouse offers, and sends alerts to a Discord webhook.

Features
- HTTP-only scraping (no Puppeteer)
- Exact product monitoring via `/dp/ASIN` or bare ASINs
- Optional Warehouse tracking (detects "Amazon Warehouse" / "Warehouse Deals")
- Per-item price thresholds via `urls.txt`
- Safe default timings (min 10 min between scans, 60s between items)
- Minimal console logs with timestamps
- Auto-prunes removed items from `watch.json`

Requirements
- Node.js 18+ (uses the global `fetch` API)

Install
```
cd simple-monitor
npm install
```

Configure
Edit `config.json`:
- `minutes_per_check`: How often to scan all items (enforced minimum 10 minutes)
- `seconds_between_check`: Delay between items in a scan (enforced minimum 60 seconds)
- `tld`: Amazon TLD (e.g., `com`, `ca`, `co.uk`)
- `url_params`: Optional key/value query params appended to every request
- `webhook_url`: Your Discord webhook URL (required to receive alerts)
- `default_warehouse`: `true` to use Amazon Warehouse offers by default when available (can be overridden per-item via `|wh`/`|nowh`)
- `debug`: `true` for extra console detail

Note: For backward compatibility, if `default_warehouse` is not set, the older `warehouse` key will be used as the default.

Add products
Edit `urls.txt`. One entry per line.
- Supports full product URLs or bare ASINs
- Lines starting with `#` are comments
- Use readable key=value tokens after the URL, in any order:
  - `threshold=PRICE` (alert only when current price <= PRICE)
  - `warehouse=on|off` (override default Warehouse for this item)
  - `alerts=stock|price|none` (default: both)

Examples:
```
# Bare ASIN
B0XXXXX123

# Clean dp link
https://www.amazon.com/dp/B0XXXXX123

# Only alert when price <= 299.99
https://www.amazon.com/dp/B0XXXXX123|threshold=299.99

# ASIN with threshold
B0XXXXX123|250

# Include Warehouse for this item (overrides global config)
https://www.amazon.com/dp/B0XXXXX123|warehouse=on

# Combine threshold + Warehouse
https://www.amazon.com/dp/B0XXXXX123|threshold=299.99|warehouse=on

# Explicitly ignore Warehouse for this item
https://www.amazon.com/dp/B0XXXXX123|warehouse=off

# Stock-only (only back-in-stock alerts, no price-drop alerts)
https://www.amazon.com/dp/B0XXXXX123|alerts=stock
https://www.amazon.com/dp/B0XXXXX123|threshold=299.99|alerts=stock
```

Run
```
node index.js
```
Console will show a banner, then minimal logs:
- Scan started (timestamp)
- Scan complete summary (notifications, errors, pruned, next scan)

How Warehouse tracking works
- For `/dp/ASIN` pages, the script requests with `aod=1` and parses offers
- If the All Offers panel isn’t server-rendered, it makes one lightweight AOD ajax request for the same ASIN
- When Warehouse is enabled (globally or via per-item `|wh`), comparisons and availability tracking use the Warehouse price if detected; otherwise they use the main price

Back-in-stock notifications
- The monitor tracks availability. If an item was previously unavailable and becomes available, it sends a "Back in stock" alert.
- Availability is tracked per the active source (Warehouse vs main). Thresholds still apply to back-in-stock alerts.

What’s stored in `watch.json`
For each tracked URL (including applied params):
```
{
  "https://www.amazon.tld/dp/ASIN?aod=1&psc=1": {
    "lastPrice": 123.45,
    "symbol": "$",
    "title": "Product Title",
    "image": "https://...jpg",
    "available": true,
    "warehouse": {
      "seller": "Warehouse Deals",
      "price": "119.99",
      "lastPrice": 119.99,
      "symbol": "$",
      "available": true
    },
    "threshold": 120,
    "useWarehouse": true
  }
}
```
- Remove an item from `urls.txt` and it will be pruned from `watch.json` on the next scan

Tips to reduce bot detection
- Keep default timings (>= 10 min scans, >= 60s between items)
- Avoid excessive parallelism; this script is sequential on purpose
- Prefer clean `/dp/ASIN` links over `/gp/` routes
- Use consistent TLD and locale

Credits
- Made by: Naveed M
- GitHub: https://github.com/naviem
- Support: https://www.paypal.com/donate/?hosted_button_id=T8DEQ4E4CU95N

Disclaimer
Use responsibly and in accordance with Amazon’s Terms of Service and local laws.


