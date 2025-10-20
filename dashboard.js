let isLoading = false;

const showNotification = (message, type = 'info') => {
  const notification = document.createElement('div');
  notification.className = 'notification ' + type;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => notification.classList.add('show'), 100);
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => document.body.removeChild(notification), 300);
  }, 3000);
};

const api = async (method, path, body = null) => {
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : null
    });
    return res.ok ? await res.json() : { error: 'HTTP ' + res.status };
  } catch (error) {
    return { error: error.message };
  }
};

const formatPrice = (price, symbol = '$') => {
  return symbol + (Number(price) || 0).toFixed(2);
};

const formatTimeAgo = (timestamp) => {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  
  if (days > 0) return days + 'd ago';
  if (hours > 0) return hours + 'h ago';
  if (minutes > 0) return minutes + 'm ago';
  return 'Just now';
};

const searchAmazon = async (query) => {
  if (!query.trim()) return;
  
  const searchResults = document.getElementById('searchResults');
  searchResults.style.display = 'block';
  searchResults.innerHTML = '<div class="loading"><div class="spinner"></div> Searching Amazon...</div>';
  
  try {
    const response = await api('POST', '/api/search', { query });
    if (response.error) {
      searchResults.innerHTML = '<div style="color: var(--danger);">Search failed: ' + response.error + '</div>';
      return;
    }
    
    if (!response.results || response.results.length === 0) {
      searchResults.innerHTML = '<div>No products found. Try a different search term.</div>';
      return;
    }
    
    searchResults.innerHTML = response.results.map(item => 
      '<div style="border: 1px solid rgba(255,255,255,0.2); border-radius: 8px; padding: 15px; margin: 10px 0; display: flex; gap: 15px; align-items: center;">' +
        (item.image ? '<img src="' + item.image + '" style="width: 60px; height: 60px; object-fit: cover; border-radius: 6px;">' : '') +
        '<div style="flex: 1;">' +
          '<div style="font-weight: 600; margin-bottom: 5px;">' + item.title + '</div>' +
          '<div style="opacity: 0.8;">' + (item.price || 'Price unavailable') + '</div>' +
        '</div>' +
        '<button onclick="addFromSearch(\'' + item.asin + '\', \'' + item.title.replace(/'/g, "\\'") + '\')" ' +
                'class="btn btn-sm" style="background: rgba(255,255,255,0.2); color: white;">' +
          '<i class="fas fa-plus"></i> Add' +
        '</button>' +
      '</div>'
    ).join('');
  } catch (error) {
    searchResults.innerHTML = '<div style="color: var(--danger);">Search error: ' + error.message + '</div>';
  }
};

const addFromSearch = (asin, title) => {
  document.getElementById('f_url').value = asin;
  document.getElementById('f_label').value = title;
  document.getElementById('searchResults').style.display = 'none';
  document.getElementById('f_url').focus();
};

const updateStatus = (status) => {
  if (!status) return;
  
  document.getElementById('scanInterval').textContent = status.minutesPerCheck + 'm';
  document.getElementById('nextScan').textContent = 
    status.nextScanInMs > 0 ? Math.ceil(status.nextScanInMs / 60000) + 'm' : 'Now';
  document.getElementById('systemStatus').textContent = 
    status.coolingMs > 0 ? 'Cooling' : 'Active';
};

const renderItems = (items) => {
  const container = document.getElementById('items');
  document.getElementById('totalItems').textContent = items.length;
  
  if (!items.length) {
    container.innerHTML = 
      '<div class="empty-state">' +
        '<i class="fas fa-inbox"></i>' +
        '<h3>No Products Tracked</h3>' +
        '<p>Add your first product using the search form above!</p>' +
      '</div>';
    return;
  }
  
  container.innerHTML = 
    '<div class="item-grid">' +
      items.map(item => {
        const priceChange = item.oldPrice && item.oldPrice !== item.currentPrice 
          ? (item.currentPrice - item.oldPrice) : 0;
        const priceChangeClass = priceChange > 0 ? 'positive' : 'negative';
        const priceChangeText = priceChange !== 0 
          ? '<span class="price-change ' + priceChangeClass + '">' + (priceChange > 0 ? '+' : '') + formatPrice(Math.abs(priceChange), item.symbol) + '</span>' 
          : '';
        
        return '<div class="item-card">' +
            '<div class="item-header">' +
              (item.image ? '<img src="' + item.image + '" alt="Product" class="item-image" onerror="this.style.display=\'none\'">' : 
                '<div class="item-image" style="background: var(--border); display: flex; align-items: center; justify-content: center;"><i class="fas fa-image" style="color: var(--text-secondary);"></i></div>') +
              '<div class="item-details">' +
                '<div class="item-title">' + (item.label || item.title || '<span style="color: var(--text-muted); font-style: italic;">⏳ Fetching product details...</span>') + '</div>' +
                '<div class="item-meta">' +
                  '<span class="badge ' + (item.available ? 'badge-success' : 'badge-danger') + '">' +
                    '<i class="fas ' + (item.available ? 'fa-check' : 'fa-times') + '"></i>' +
                    (item.available ? 'In Stock' : 'Out of Stock') +
                  '</span>' +
                  (item.useWarehouse ? '<span class="badge badge-info"><i class="fas fa-warehouse"></i> Warehouse</span>' : '') +
                  (item.group ? '<span class="badge badge-warning">' + item.group + '</span>' : '') +
                  (item.threshold ? '<span class="badge badge-info">Max: ' + formatPrice(item.threshold, item.symbol) + '</span>' : '') +
                '</div>' +
              '</div>' +
            '</div>' +
            
            '<div class="price-info">' +
              '<span class="current-price">' + formatPrice(item.currentPrice, item.symbol) + '</span>' +
              (item.oldPrice && item.oldPrice !== item.currentPrice ? '<span class="old-price">' + formatPrice(item.oldPrice, item.symbol) + '</span>' : '') +
              priceChangeText +
            '</div>' +
            
            (item.lowestSeen ? '<div style="font-size: 0.9rem; color: var(--text-secondary); margin-bottom: 15px;">' +
              '<i class="fas fa-chart-line"></i> Lowest seen: ' + formatPrice(item.lowestSeen.price, item.symbol) + ' ' +
              '(' + formatTimeAgo(item.lowestSeen.ts) + ')' +
            '</div>' : '') +
            
            '<div class="item-actions">' +
              '<button class="btn btn-sm btn-primary history-btn" data-asin="' + item.asin + '" data-title="' + (item.label || item.title || 'Product').replace(/"/g, '&quot;') + '">' +
                '<i class="fas fa-chart-line"></i> History' +
              '</button>' +
              '<button class="btn btn-sm btn-outline edit-btn" data-asin="' + item.asin + '">' +
                '<i class="fas fa-edit"></i> Edit' +
              '</button>' +
              '<button class="btn btn-sm btn-success test-btn" data-asin="' + item.asin + '">' +
                '<i class="fas fa-paper-plane"></i> Test' +
              '</button>' +
              '<a href="https://amazon.' + (window.amazonTld || 'com') + '/dp/' + item.asin + '" target="_blank" class="btn btn-sm btn-outline">' +
                '<i class="fas fa-external-link-alt"></i> View' +
              '</a>' +
              '<button class="btn btn-sm btn-danger delete-btn" data-asin="' + item.asin + '">' +
                '<i class="fas fa-trash"></i> Delete' +
              '</button>' +
            '</div>' +
          '</div>';
      }).join('') +
    '</div>';
  
  bindItemEvents();
};

const bindItemEvents = () => {
  document.querySelectorAll('.history-btn').forEach(btn => {
    btn.onclick = () => {
      const asin = btn.dataset.asin;
      const title = btn.dataset.title;
      showHistoryModal(asin, title);
    };
  });

  document.querySelectorAll('.edit-btn').forEach(btn => {
    btn.onclick = async () => {
      const asin = btn.dataset.asin;

      // Find the item data
      const itemsResult = await api('GET', '/api/items');
      if (itemsResult.error) {
        showNotification('Failed to load item data', 'error');
        return;
      }

      const items = itemsResult.items || itemsResult;
      const item = items.find(i => i.asin === asin);

      if (!item) {
        showNotification('Item not found', 'error');
        return;
      }

      // Show edit modal
      showEditModal(item);
    };
  });

  document.querySelectorAll('.delete-btn').forEach(btn => {
    btn.onclick = async () => {
      const asin = btn.dataset.asin;
      if (!confirm('Are you sure you want to delete this item?')) return;

      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Deleting...';

      const result = await api('DELETE', '/api/items?asin=' + encodeURIComponent(asin));
      if (result.error) {
        showNotification('Failed to delete item: ' + result.error, 'error');
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-trash"></i> Delete';
      } else {
        showNotification('Item deleted successfully', 'success');
        loadData();
      }
    };
  });

  document.querySelectorAll('.test-btn').forEach(btn => {
    btn.onclick = async () => {
      const asin = btn.dataset.asin;
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Testing...';

      const result = await api('POST', '/api/test?asin=' + encodeURIComponent(asin));
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-paper-plane"></i> Test';

      if (result.error) {
        showNotification('Test failed: ' + result.error, 'error');
      } else {
        showNotification('Test notification sent!', 'success');
      }
    };
  });
};

const loadData = async () => {
  if (isLoading) return;
  isLoading = true;
  
  try {
    const [statusResult, itemsResult] = await Promise.all([
      api('GET', '/api/status'),
      api('GET', '/api/items')
    ]);
    
    if (statusResult && !statusResult.error) {
      updateStatus(statusResult);
      window.amazonTld = statusResult.tld || 'com';
    }
    
    if (itemsResult && !itemsResult.error) {
      renderItems(itemsResult.items || itemsResult);
    } else {
      document.getElementById('items').innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>Failed to load items</h3><p>' + (itemsResult?.error || 'Unknown error') + '</p></div>';
    }
  } catch (error) {
    document.getElementById('items').innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>Connection Error</h3><p>' + error.message + '</p></div>';
  } finally {
    isLoading = false;
  }
};

// Event Listeners
document.getElementById('searchBtn').onclick = () => {
  const query = document.getElementById('searchInput').value.trim();
  searchAmazon(query);
};

document.getElementById('searchInput').onkeypress = (e) => {
  if (e.key === 'Enter') {
    document.getElementById('searchBtn').click();
  }
};

document.getElementById('addForm').onsubmit = async (e) => {
  e.preventDefault();
  if (isLoading) return;

  // Check if webhooks are configured
  const webhookId = document.getElementById('f_webhook').value;
  const webhookSelect = document.getElementById('f_webhook');

  if (!webhookId || webhookSelect.options[0]?.textContent === 'No webhooks configured') {
    showNotification('Please add a webhook in the Webhooks tab before adding products', 'error');
    // Switch to webhooks tab
    document.querySelector('[data-tab="webhooks"]').click();
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalText = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';

  // Get notification mode
  const notifyMode = document.querySelector('input[name="notify_mode"]:checked').value;

  const formData = {
    urlOrAsin: document.getElementById('f_url').value.trim(),
    label: document.getElementById('f_label').value.trim(),
    group: document.getElementById('f_group').value.trim(),
    threshold: document.getElementById('f_threshold').value ? Number(document.getElementById('f_threshold').value) : undefined,
    thresholdDrop: document.getElementById('f_drop').value ? Number(document.getElementById('f_drop').value) : undefined,
    baseline: document.getElementById('f_base').value || undefined,
    warehouse: document.getElementById('f_warehouse').value,
    alerts: document.getElementById('f_alerts').value || undefined,
    repeatAlerts: notifyMode === 'repeat' ? 'on' : undefined,
    webhookId: webhookId
  };

  // Remove undefined values
  Object.keys(formData).forEach(key => formData[key] === undefined && delete formData[key]);

  const result = await api('POST', '/api/items', formData);

  submitBtn.disabled = false;
  submitBtn.innerHTML = originalText;

  if (result.error) {
    showNotification('Failed to add product: ' + result.error, 'error');
  } else {
    document.getElementById('addForm').reset();
    document.getElementById('searchResults').style.display = 'none';
    showNotification('Product added! Fetching details...', 'success');

    // Repopulate webhook dropdown after reset
    populateWebhookDropdown();

    // Immediately reload to show the new product
    loadData();

    // Auto-refresh a few more times to catch the product details being populated
    setTimeout(loadData, 2000);  // After 2 seconds
    setTimeout(loadData, 5000);  // After 5 seconds
  }
};

document.getElementById('btn_reload').onclick = () => loadData();

document.getElementById('btn_scan').onclick = async () => {
  const btn = document.getElementById('btn_scan');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Scanning...';
  
  const result = await api('POST', '/api/scan');
  
  setTimeout(() => {
    btn.disabled = false;
    btn.innerHTML = originalText;
    if (result.error) {
      showNotification('Scan failed: ' + result.error, 'error');
    } else {
      showNotification('Scan started successfully!', 'success');
      setTimeout(loadData, 2000);
    }
  }, 1000);
};

// Tab Switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    const targetTab = tab.dataset.tab;

    // Update active tab
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    // Update active content
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    document.getElementById('tab-' + targetTab).classList.add('active');

    // Load tab-specific data
    if (targetTab === 'webhooks') {
      loadWebhooks();
    } else if (targetTab === 'settings') {
      loadSettings();
    }
  };
});

// Webhooks Management
const loadWebhooks = async () => {
  const container = document.getElementById('webhooks_list');
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading webhooks...</div>';

  const result = await api('GET', '/api/webhooks');
  if (result.error) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>Failed to load webhooks</h3><p>' + result.error + '</p></div>';
    return;
  }

  const webhooks = result.webhooks || [];
  if (webhooks.length === 0) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-bell-slash"></i><h3>No Webhooks Configured</h3><p>Add a Discord webhook to start receiving notifications</p></div>';
    return;
  }

  container.innerHTML = webhooks.map((wh, idx) =>
    '<div class="webhook-card">' +
      '<div class="webhook-info">' +
        '<div class="webhook-name">' + wh.name + (wh.isDefault ? ' <span class="badge badge-success">Default</span>' : '') + '</div>' +
        '<div class="webhook-url">' + wh.url + '</div>' +
      '</div>' +
      '<div class="webhook-actions">' +
        (!wh.isDefault ? '<button class="btn btn-sm btn-outline" onclick="setDefaultWebhook(\'' + wh.id + '\')"><i class="fas fa-star"></i> Set Default</button>' : '') +
        '<button class="btn btn-sm btn-danger" onclick="deleteWebhook(\'' + wh.id + '\')"><i class="fas fa-trash"></i></button>' +
      '</div>' +
    '</div>'
  ).join('');
};

window.setDefaultWebhook = async (id) => {
  const result = await api('PUT', '/api/webhooks/' + id + '/default');
  if (result.error) {
    showNotification('Failed to set default: ' + result.error, 'error');
  } else {
    showNotification('Default webhook updated', 'success');
    loadWebhooks();
    // Update webhook dropdown in product form
    populateWebhookDropdown();
  }
};

window.deleteWebhook = async (id) => {
  if (!confirm('Are you sure you want to delete this webhook?')) return;

  const result = await api('DELETE', '/api/webhooks/' + id);
  if (result.error) {
    showNotification('Failed to delete webhook: ' + result.error, 'error');
  } else {
    showNotification('Webhook deleted', 'success');
    loadWebhooks();
    // Update webhook dropdown in product form
    populateWebhookDropdown();
  }
};

document.getElementById('btn_add_webhook').onclick = () => {
  document.getElementById('webhook_form').style.display = 'block';
  document.getElementById('wh_name').focus();
};

document.getElementById('btn_cancel_webhook').onclick = () => {
  document.getElementById('addWebhookForm').reset();
  document.getElementById('webhook_form').style.display = 'none';
};

document.getElementById('addWebhookForm').onsubmit = async (e) => {
  e.preventDefault();

  const formData = {
    name: document.getElementById('wh_name').value.trim(),
    url: document.getElementById('wh_url').value.trim()
  };

  const result = await api('POST', '/api/webhooks', formData);
  if (result.error) {
    showNotification('Failed to add webhook: ' + result.error, 'error');
  } else {
    showNotification('Webhook added successfully', 'success');
    document.getElementById('addWebhookForm').reset();
    document.getElementById('webhook_form').style.display = 'none';
    loadWebhooks();
    // Update webhook dropdown in product form
    populateWebhookDropdown();
  }
};

// Settings Management
const loadSettings = async () => {
  const container = document.getElementById('settings_content');
  const form = document.getElementById('settingsForm');

  container.style.display = 'block';
  form.style.display = 'none';
  container.innerHTML = '<div class="loading"><div class="spinner"></div> Loading settings...</div>';

  const result = await api('GET', '/api/settings');
  if (result.error) {
    container.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-triangle"></i><h3>Failed to load settings</h3><p>' + result.error + '</p></div>';
    return;
  }

  // Populate form
  document.getElementById('s_minutes').value = result.minutes_per_check || 10;
  document.getElementById('s_seconds').value = result.seconds_between_check || 60;
  document.getElementById('s_tld').value = result.tld || 'com';
  document.getElementById('s_telegram_token').value = result.telegram_bot_token || '';
  document.getElementById('s_telegram_chat').value = result.telegram_chat_id || '';
  document.getElementById('s_history_days').value = result.history_days || 7;
  document.getElementById('s_history_limit').value = result.history_limit || 2000;
  document.getElementById('s_history_noise').checked = result.history_noise_protection !== false;
  document.getElementById('s_ua_strategy').value = result.user_agent_strategy || 'sticky-per-item';
  document.getElementById('s_debug').checked = !!result.debug;

  container.style.display = 'none';
  form.style.display = 'block';
};

document.getElementById('btn_save_settings').onclick = async () => {
  const btn = document.getElementById('btn_save_settings');
  const originalText = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

  const formData = {
    minutes_per_check: Number(document.getElementById('s_minutes').value),
    seconds_between_check: Number(document.getElementById('s_seconds').value),
    tld: document.getElementById('s_tld').value,
    telegram_bot_token: document.getElementById('s_telegram_token').value || undefined,
    telegram_chat_id: document.getElementById('s_telegram_chat').value || undefined,
    history_days: Number(document.getElementById('s_history_days').value),
    history_limit: Number(document.getElementById('s_history_limit').value),
    history_noise_protection: document.getElementById('s_history_noise').checked,
    user_agent_strategy: document.getElementById('s_ua_strategy').value,
    debug: document.getElementById('s_debug').checked
  };

  Object.keys(formData).forEach(key => formData[key] === undefined && delete formData[key]);

  const result = await api('PUT', '/api/settings', formData);

  btn.disabled = false;
  btn.innerHTML = originalText;

  if (result.error) {
    showNotification('Failed to save settings: ' + result.error, 'error');
  } else {
    showNotification('Settings saved! Restart monitor for changes to take effect.', 'success');
  }
};

// Populate webhook dropdown
const populateWebhookDropdown = async () => {
  const select = document.getElementById('f_webhook');
  if (!select) return;

  const result = await api('GET', '/api/webhooks');
  if (result.error || !result.webhooks) {
    select.innerHTML = '<option value="">No webhooks configured</option>';
    return;
  }

  if (result.webhooks.length === 0) {
    select.innerHTML = '<option value="">No webhooks configured</option>';
    return;
  }

  // Clear existing options
  select.innerHTML = '';

  // Add each webhook as an option
  result.webhooks.forEach((wh, index) => {
    const option = document.createElement('option');
    option.value = wh.id;
    option.textContent = wh.name + (wh.isDefault ? ' (Default)' : '');
    // Select the first (or default) webhook by default
    if (wh.isDefault || index === 0) {
      option.selected = true;
    }
    select.appendChild(option);
  });
};

// Price History Modal
const showHistoryModal = async (asin, title) => {
  const modal = document.getElementById('historyModal');
  const modalTitle = document.getElementById('modalTitle');
  const statsContainer = document.getElementById('historyStats');
  const chartContainer = document.getElementById('chartContainer');

  // Set title
  modalTitle.textContent = 'Price History: ' + title;

  // Show modal
  modal.classList.add('active');

  // Reset content
  statsContainer.innerHTML = '';
  chartContainer.innerHTML = '<div class="chart-loading"><div class="spinner"></div> Loading price history...</div>';

  // Fetch history data
  const result = await api('GET', '/api/history?asin=' + encodeURIComponent(asin));

  if (result.error) {
    chartContainer.innerHTML = '<div class="chart-empty"><i class="fas fa-exclamation-triangle"></i><p>Failed to load price history</p><p style="font-size: 0.875rem; margin-top: 0.5rem;">' + result.error + '</p></div>';
    return;
  }

  const { history, lowestSeen, symbol } = result;

  if (!history || history.length === 0) {
    chartContainer.innerHTML = '<div class="chart-empty"><i class="fas fa-chart-line"></i><p>No price history available</p><p style="font-size: 0.875rem; margin-top: 0.5rem;">Price history will be recorded as the monitor runs</p></div>';
    return;
  }

  // Calculate stats
  const prices = history.map(h => h.price);
  const currentPrice = prices[prices.length - 1];
  const highestPrice = Math.max(...prices);
  const lowestPrice = Math.min(...prices);
  const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

  // Render stats
  statsContainer.innerHTML =
    '<div class="history-stat"><div class="history-stat-value">' + formatPrice(currentPrice, symbol) + '</div><div class="history-stat-label">Current Price</div></div>' +
    '<div class="history-stat"><div class="history-stat-value">' + formatPrice(lowestPrice, symbol) + '</div><div class="history-stat-label">Lowest Price</div></div>' +
    '<div class="history-stat"><div class="history-stat-value">' + formatPrice(highestPrice, symbol) + '</div><div class="history-stat-label">Highest Price</div></div>' +
    '<div class="history-stat"><div class="history-stat-value">' + formatPrice(avgPrice, symbol) + '</div><div class="history-stat-label">Average Price</div></div>' +
    '<div class="history-stat"><div class="history-stat-value">' + history.length + '</div><div class="history-stat-label">Data Points</div></div>';

  // Render chart
  renderPriceChart(chartContainer, history, symbol);
};

const renderPriceChart = (container, history, symbol) => {
  const width = container.clientWidth - 48; // Account for padding
  const height = 400;
  const padding = { top: 20, right: 20, bottom: 60, left: 60 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  // Separate data by source
  const mainData = history.filter(h => h.source === 'main');
  const warehouseData = history.filter(h => h.source === 'warehouse');

  // Get min/max values
  const allPrices = history.map(h => h.price);
  const minPrice = Math.min(...allPrices);
  const maxPrice = Math.max(...allPrices);
  const priceRange = maxPrice - minPrice;
  const pricePadding = priceRange * 0.1;

  const minTs = Math.min(...history.map(h => h.ts));
  const maxTs = Math.max(...history.map(h => h.ts));

  // Scale functions
  const scaleX = (ts) => padding.left + ((ts - minTs) / (maxTs - minTs)) * chartWidth;
  const scaleY = (price) => padding.top + chartHeight - ((price - minPrice + pricePadding) / (priceRange + pricePadding * 2)) * chartHeight;

  // Create SVG
  let svg = '<svg width="' + width + '" height="' + height + '" style="background: var(--bg-tertiary);">';

  // Grid lines
  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (chartHeight / gridLines) * i;
    const price = maxPrice + pricePadding - ((priceRange + pricePadding * 2) / gridLines) * i;
    svg += '<line x1="' + padding.left + '" y1="' + y + '" x2="' + (width - padding.right) + '" y2="' + y + '" stroke="var(--border)" stroke-width="1" stroke-dasharray="5,5"/>';
    svg += '<text x="' + (padding.left - 10) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="var(--text-secondary)">' + symbol + price.toFixed(2) + '</text>';
  }

  // Draw lines
  const drawLine = (data, color) => {
    if (data.length < 2) return '';
    let path = 'M';
    data.forEach((point, i) => {
      const x = scaleX(point.ts);
      const y = scaleY(point.price);
      path += (i === 0 ? '' : ' L') + x + ',' + y;
    });
    return '<path d="' + path + '" stroke="' + color + '" stroke-width="2" fill="none"/>';
  };

  if (mainData.length > 0) {
    svg += drawLine(mainData, '#4ec9b0'); // Success color for main
  }

  if (warehouseData.length > 0) {
    svg += drawLine(warehouseData, '#007acc'); // Primary color for warehouse
  }

  // Draw points
  const drawPoints = (data, color) => {
    return data.map(point => {
      const x = scaleX(point.ts);
      const y = scaleY(point.price);
      return '<circle cx="' + x + '" cy="' + y + '" r="4" fill="' + color + '" stroke="var(--bg-tertiary)" stroke-width="2"/>';
    }).join('');
  };

  if (mainData.length > 0) {
    svg += drawPoints(mainData, '#4ec9b0');
  }

  if (warehouseData.length > 0) {
    svg += drawPoints(warehouseData, '#007acc');
  }

  // X-axis labels (dates)
  const dateLabels = 5;
  for (let i = 0; i <= dateLabels; i++) {
    const ts = minTs + ((maxTs - minTs) / dateLabels) * i;
    const x = scaleX(ts);
    const date = new Date(ts);
    const label = (date.getMonth() + 1) + '/' + date.getDate();
    svg += '<text x="' + x + '" y="' + (height - padding.bottom + 20) + '" text-anchor="middle" font-size="11" fill="var(--text-secondary)">' + label + '</text>';
  }

  // Axes
  svg += '<line x1="' + padding.left + '" y1="' + padding.top + '" x2="' + padding.left + '" y2="' + (height - padding.bottom) + '" stroke="var(--text-secondary)" stroke-width="1"/>';
  svg += '<line x1="' + padding.left + '" y1="' + (height - padding.bottom) + '" x2="' + (width - padding.right) + '" y2="' + (height - padding.bottom) + '" stroke="var(--text-secondary)" stroke-width="1"/>';

  svg += '</svg>';

  // Legend
  let legend = '<div class="chart-legend">';
  if (mainData.length > 0) {
    legend += '<div class="legend-item"><div class="legend-color" style="background: #4ec9b0;"></div><span>Main Price</span></div>';
  }
  if (warehouseData.length > 0) {
    legend += '<div class="legend-item"><div class="legend-color" style="background: #007acc;"></div><span>Warehouse Price</span></div>';
  }
  legend += '</div>';

  container.innerHTML = legend + svg;
};

// Edit Item Modal
const showEditModal = async (item) => {
  const modal = document.getElementById('editModal');

  // Populate webhooks dropdown in edit modal
  const webhookSelect = document.getElementById('edit_webhook');
  const webhooksResult = await api('GET', '/api/webhooks');
  if (!webhooksResult.error && webhooksResult.webhooks && webhooksResult.webhooks.length > 0) {
    webhookSelect.innerHTML = '';
    webhooksResult.webhooks.forEach(wh => {
      const option = document.createElement('option');
      option.value = wh.id;
      option.textContent = wh.name + (wh.isDefault ? ' (Default)' : '');
      webhookSelect.appendChild(option);
    });
  } else {
    webhookSelect.innerHTML = '<option value="">No webhooks configured</option>';
  }

  // Populate form with current values
  document.getElementById('edit_asin').value = item.asin;
  document.getElementById('edit_label').value = item.label || '';
  document.getElementById('edit_group').value = item.group || '';
  document.getElementById('edit_threshold').value = item.threshold || '';
  document.getElementById('edit_drop').value = item.thresholdDrop || '';
  document.getElementById('edit_base').value = item.baseline || '';
  document.getElementById('edit_warehouse').value = item.warehouse || 'on';
  document.getElementById('edit_alerts').value = item.alerts === 'both' ? '' : (item.alerts || '');

  // Set webhook dropdown - need to wait for it to be populated
  setTimeout(() => {
    document.getElementById('edit_webhook').value = item.webhookId || '';
  }, 100);

  // Set notification mode
  if (item.repeatAlerts === true || item.repeatAlerts === 'on') {
    document.getElementById('edit_repeat_alerts').checked = true;
  } else {
    document.getElementById('edit_notify_normal').checked = true;
  }

  // Show modal
  modal.classList.add('active');
};

// Edit form submission
document.getElementById('editForm').onsubmit = async (e) => {
  e.preventDefault();

  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalText = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

  const asin = document.getElementById('edit_asin').value;
  const notifyMode = document.querySelector('input[name="edit_notify_mode"]:checked').value;

  const formData = {
    asin: asin,
    label: document.getElementById('edit_label').value.trim() || '',
    group: document.getElementById('edit_group').value.trim() || '',
    threshold: document.getElementById('edit_threshold').value ? Number(document.getElementById('edit_threshold').value) : null,
    thresholdDrop: document.getElementById('edit_drop').value ? Number(document.getElementById('edit_drop').value) : null,
    baseline: document.getElementById('edit_base').value || '',
    warehouse: document.getElementById('edit_warehouse').value || 'on',
    alerts: document.getElementById('edit_alerts').value || '',
    repeatAlerts: notifyMode === 'repeat' ? 'on' : 'off',
    notifyOnce: false,
    webhookId: document.getElementById('edit_webhook').value || ''
  };

  const result = await api('PUT', '/api/items', formData);

  submitBtn.disabled = false;
  submitBtn.innerHTML = originalText;

  if (result.error) {
    showNotification('Failed to update product: ' + result.error, 'error');
  } else {
    showNotification('Product updated successfully!', 'success');
    document.getElementById('editModal').classList.remove('active');
    loadData();
  }
};

// Modal close handlers
document.getElementById('closeModal').onclick = () => {
  document.getElementById('historyModal').classList.remove('active');
};

document.getElementById('historyModal').onclick = (e) => {
  if (e.target.id === 'historyModal') {
    document.getElementById('historyModal').classList.remove('active');
  }
};

document.getElementById('closeEditModal').onclick = () => {
  document.getElementById('editModal').classList.remove('active');
};

document.getElementById('cancelEdit').onclick = () => {
  document.getElementById('editModal').classList.remove('active');
};

document.getElementById('editModal').onclick = (e) => {
  if (e.target.id === 'editModal') {
    document.getElementById('editModal').classList.remove('active');
  }
};

// Auto-refresh every 30 seconds
setInterval(loadData, 30000);

// Initial load
loadData();
populateWebhookDropdown();