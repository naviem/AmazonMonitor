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
  return symbol + (price || 0).toFixed(2);
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
  
  const submitBtn = e.target.querySelector('button[type="submit"]');
  const originalText = submitBtn.innerHTML;
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Adding...';
  
  const formData = {
    urlOrAsin: document.getElementById('f_url').value.trim(),
    label: document.getElementById('f_label').value.trim(),
    group: document.getElementById('f_group').value.trim(),
    threshold: document.getElementById('f_threshold').value ? Number(document.getElementById('f_threshold').value) : undefined,
    thresholdDrop: document.getElementById('f_drop').value ? Number(document.getElementById('f_drop').value) : undefined,
    baseline: document.getElementById('f_base').value || undefined,
    warehouse: document.getElementById('f_warehouse').value || undefined,
    alerts: document.getElementById('f_alerts').value || undefined
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

// Auto-refresh every 30 seconds
setInterval(loadData, 30000);

// Initial load
loadData();