# 🛒 Amazon Monitor By NavieM


> **Lightweight, ultra-fast, and stealthy Amazon price & stock monitoring bot.**  
> Simply run `amazonmonitor.exe` on Windows to launch your personal dark-mode dashboard and get instant **Discord & Telegram** alerts for price drops and back-in-stock items.

---

## ⚡ Why the New Go Edition?

- **Zero Installation**: Download and double-click `amazonmonitor.exe` to extract.
- **Ultra Lightweight**: Runs smoothly in the background using less than **25 MB of RAM**.
- **Advanced Stealth**: Uses Chrome browser TLS fingerprinting (`uTLS`) to bypass Amazon anti-bot blocks without needing heavy browsers.
- **Instant Web Dashboard**: Built-in web dashboard to easily add products, view price charts, and configure alerts.
- **Rich Notifications**: Custom Discord Webhooks and Telegram Bot alerts complete with product photos, price drop percentages, and direct buy links.

---

## 🚀 How to Run

1. **Download `amazonmonitor.exe`** from the [Releases](https://github.com/naviem/AmazonMonitor/releases) page.
2. **Double-click `amazonmonitor.exe`** to start the monitor.
3. **Open your browser** and go to:
   ```text
   http://localhost:3005
   ```
4. Paste any Amazon product link or ASIN into the dashboard to start tracking!

---

## ✨ Features Overview

- **📊 Modern Web Dashboard**: Search and track Amazon items, pause/resume monitors, and view live price statuses.
- **📈 Price History Analytics**: Interactive price graphs showing lowest price ever, highest price, and price drop trends.
- **🔔 Discord & Telegram Alerts**:
- **🏷️ Amazon Warehouse Deals**: Track used, refurbished, and open-box warehouse deals alongside regular listings.
- **⚙️ Custom Alert Rules**: Set custom scan intervals, minimum price drop thresholds, and per-item notifications.

---

## 🔔 Quick Webhook Setup

### 💬 Discord Webhooks
1. In Discord, go to **Server Settings** ➔ **Integrations** ➔ **Webhooks**.
2. Click **New Webhook**, select your channel, and copy the **Webhook URL**.
3. Open the Amazon Monitor dashboard at `http://localhost:3005`.
4. Click **Webhooks** ➔ **Add Webhook**, paste your Discord URL, and click **Save**.

### ✈️ Telegram Bot Alerts
1. Open Telegram and message [@BotFather](https://t.me/BotFather) to create a bot and get your **Bot Token**.
2. Send a message to your bot, then get your **Chat ID** (using [@userinfobot](https://t.me/userinfobot)).
3. In the Amazon Monitor dashboard, click **Webhooks** ➔ **Add Webhook**.
4. Select **Telegram**, enter your Bot Token & Chat ID, and click **Save**.
