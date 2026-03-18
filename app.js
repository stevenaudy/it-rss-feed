'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

// allorigins /raw returns XML directly (no JSON wrapper — faster).
// /get JSON endpoint used as fallback if /raw returns non-XML.
const PROXY_CONFIGS = [
  {
    name: 'allorigins-raw',
    buildUrl: (feedUrl) =>
      `https://api.allorigins.win/raw?url=${encodeURIComponent(feedUrl)}`,
    extractContent: (res) => res.text(),
  },
  {
    name: 'allorigins-json',
    buildUrl: (feedUrl) =>
      `https://api.allorigins.win/get?url=${encodeURIComponent(feedUrl)}`,
    extractContent: async (res) => {
      const json = await res.json();
      if (!json || typeof json.contents !== 'string')
        throw new Error('Invalid allorigins/get response');
      return json.contents;
    },
  },
];

const FETCH_TIMEOUT_MS      = 10000;         // 10s per proxy attempt
const LOCAL_JSON_TIMEOUT_MS = 5000;          // 5s for same-origin feeds/*.json
const ITEMS_PER_PAGE        = 10;
const FETCH_COUNT       = 20;                  // items fetched per feed
const REFRESH_INTERVAL  = 60 * 60 * 1000;      // 1 hour in ms

// RSS Feed configuration — all URLs must be HTTPS
const FEEDS = {
  global: [
    { url: 'https://thehackernews.com/feeds/posts/default',            name: 'The Hacker News',   category: 'Security' },
    { url: 'https://krebsonsecurity.com/feed/',                        name: 'Krebs on Security', category: 'Security' },
    { url: 'https://thenewstack.io/feed/',                             name: 'The New Stack',     category: 'DevOps'   },
    { url: 'https://devops.com/feed/',                                 name: 'DevOps.com',        category: 'DevOps'   },
    { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', name: 'Ars Technica',      category: 'Tech'     },
    { url: 'https://feed.infoq.com/',                                  name: 'InfoQ',             category: 'Engineering' },
  ],
  indonesia: [
    { url: 'https://tekno.kompas.com/rss/',            name: 'Kompas Tekno',    category: 'Tech' },
    { url: 'https://rss.detik.com/inet',               name: 'Detik iNet',      category: 'Tech' },
    { url: 'https://rss.tempo.co/tekno',               name: 'Tempo Tekno',     category: 'Tech' },
    { url: 'https://www.cnbcindonesia.com/tech/rss',   name: 'CNBC Indonesia',  category: 'Tech' },
  ],
};

// Map category names to CSS class suffixes
const BADGE_CLASS = {
  security:    'badge-security',
  devops:      'badge-devops',
  tech:        'badge-tech',
  engineering: 'badge-engineering',
  cloud:       'badge-cloud',
};

// ═══════════════════════════════════════════════════════════════════════════
// localStorage Feed Cache — persists articles across sessions / tab switches
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_MAX_AGE_MS = 2 * 60 * 60 * 1000; // serve stale data up to 2 h old

function saveToCache(tabName, items) {
  try {
    localStorage.setItem(`it-news-cache-${tabName}`, JSON.stringify({ ts: Date.now(), items }));
  } catch { /* localStorage quota — non-fatal */ }
}

function loadFromCache(tabName) {
  try {
    const raw = localStorage.getItem(`it-news-cache-${tabName}`);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.items) || data.items.length === 0) return null;
    if (Date.now() - (data.ts || 0) > CACHE_MAX_AGE_MS) return null;
    return data.items;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Application State
// ═══════════════════════════════════════════════════════════════════════════

const state = {
  activeTab: 'global',
  tabs: {
    global:    { items: [], displayCount: 0, loading: false, lastTopDate: null },
    indonesia: { items: [], displayCount: 0, loading: false, lastTopDate: null },
  },
  refreshTimer: null,
  toastTimer:   null,
};

// ═══════════════════════════════════════════════════════════════════════════
// Security Utilities
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract plain text from an HTML string using DOMParser.
 * This prevents XSS: we never write this back via innerHTML.
 */
function sanitizeText(html) {
  if (!html || typeof html !== 'string') return '';
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return (doc.body.textContent || '').trim().replace(/\s+/g, ' ');
  } catch {
    return '';
  }
}

/**
 * Validate that a URL uses HTTPS. Returns the URL string or null.
 * Prevents open-redirect and mixed-content issues.
 */
function validateHttpsUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// General Utilities
// ═══════════════════════════════════════════════════════════════════════════

function truncate(text, maxLen) {
  if (!text) return '';
  const t = text.trim();
  return t.length > maxLen ? t.slice(0, maxLen).trimEnd() + '…' : t;
}

function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '';
  const diffMs    = Date.now() - date.getTime();
  const diffMins  = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays  = Math.floor(diffMs / 86_400_000);
  if (diffMins  < 1)  return 'Baru saja';
  if (diffMins  < 60) return `${diffMins}m lalu`;
  if (diffHours < 24) return `${diffHours}j lalu`;
  if (diffDays  < 7)  return `${diffDays}h lalu`;
  return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function currentTimeString() {
  return new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

// ═══════════════════════════════════════════════════════════════════════════
// XML Feed Parser (RSS 2.0 + Atom)
// ═══════════════════════════════════════════════════════════════════════════

function parseXmlFeed(xmlText, feedConfig) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');

  if (doc.querySelector('parsererror')) {
    throw new Error(`XML parse error for ${feedConfig.name}`);
  }

  // Support RSS 2.0 <item> and Atom <entry>
  const items = Array.from(doc.querySelectorAll('item, entry'));

  return items.slice(0, FETCH_COUNT).map((item) => {
    const getText = (selector) => {
      const el = item.querySelector(selector);
      return el ? (el.textContent || '').trim() : '';
    };

    // Atom uses <link href="..."> | RSS uses <link>url</link>
    const linkEl = item.querySelector('link');
    const rawLink = linkEl
      ? (linkEl.getAttribute('href') || linkEl.textContent.trim())
      : '';

    return {
      title:    truncate(sanitizeText(getText('title')), 120),
      summary:  truncate(sanitizeText(
        getText('description') || getText('summary') || getText('content')
      ), 200),
      link:     validateHttpsUrl(rawLink),
      pubDate:  getText('pubDate') || getText('published') || getText('updated') || '',
      source:   feedConfig.name,
      category: feedConfig.category,
    };
  }).filter((item) => item.title && item.link);
}

// ═══════════════════════════════════════════════════════════════════════════
// RSS Fetching
// ═══════════════════════════════════════════════════════════════════════════

// Fetch with AbortController timeout so hung requests fail fast
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal:      controller.signal,
      credentials: 'omit',
      mode:        'cors',
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeed(feedConfig) {
  let lastError;

  // Try each proxy in order; move to next on any failure
  for (const proxy of PROXY_CONFIGS) {
    try {
      const proxyUrl = proxy.buildUrl(feedConfig.url);
      const response = await fetchWithTimeout(proxyUrl, FETCH_TIMEOUT_MS);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const xmlText = await proxy.extractContent(response);
      return parseXmlFeed(xmlText, feedConfig);
    } catch (err) {
      lastError = err;
      console.warn(`[RSS] ${proxy.name} failed for ${feedConfig.name}:`, err.message);
      // continue to next proxy
    }
  }

  throw new Error(`All proxies failed for ${feedConfig.name}: ${lastError?.message}`);
}

async function fetchAllFeeds(tabName) {
  // ── Primary: static JSON pre-built by GitHub Actions (same origin, no CORS) ──
  try {
    const res = await fetchWithTimeout(`./feeds/${tabName}.json`, LOCAL_JSON_TIMEOUT_MS);
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.items) && data.items.length > 0) {
        const valid = data.items.filter(
          (it) => it.title && it.link && it.link.startsWith('https://')
        );
        if (valid.length > 0) {
          console.log(`[RSS] Loaded ${valid.length} items from feeds/${tabName}.json`);
          return { items: valid, failCount: 0, total: 1 };
        }
      }
    }
  } catch (err) {
    console.warn('[RSS] Local JSON unavailable, falling back to proxy:', err.message);
  }

  // ── Fallback: CORS proxy (used only before first GitHub Actions run) ─────
  const feeds = FEEDS[tabName];
  const promises = feeds.map((feed, i) =>
    new Promise((resolve) => setTimeout(resolve, i * 500))
      .then(() => fetchFeed(feed))
  );
  const results = await Promise.allSettled(promises);

  const allItems = [];
  let failCount  = 0;

  results.forEach((result) => {
    if (result.status === 'fulfilled') {
      allItems.push(...result.value);
    } else {
      failCount++;
      console.warn('[RSS] Feed failed:', result.reason?.message);
    }
  });

  allItems.sort((a, b) => {
    const tA = new Date(a.pubDate).getTime() || 0;
    const tB = new Date(b.pubDate).getTime() || 0;
    return tB - tA;
  });

  return { items: allItems, failCount, total: feeds.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// Toast
// ═══════════════════════════════════════════════════════════════════════════

function showToast(message) {
  const toast = document.getElementById('toast');
  clearTimeout(state.toastTimer);

  // textContent prevents XSS — message is always an internal string
  toast.textContent = message;
  toast.classList.add('visible');

  state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 4000);
  toast.onclick = () => {
    clearTimeout(state.toastTimer);
    toast.classList.remove('visible');
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Rendering — all RSS data set via textContent, never innerHTML
// ═══════════════════════════════════════════════════════════════════════════

function createCard(item) {
  const article = document.createElement('article');
  article.className = 'news-card';

  // ── Meta row ──────────────────────────────────────────────────────────
  const meta = document.createElement('div');
  meta.className = 'card-meta';

  const badge = document.createElement('span');
  badge.className = `badge ${BADGE_CLASS[item.category.toLowerCase()] || 'badge-tech'}`;
  badge.textContent = item.category;  // textContent — safe

  const source = document.createElement('span');
  source.className = 'card-source';
  source.textContent = item.source;   // textContent — safe

  const dateEl = document.createElement('time');
  dateEl.className = 'card-date';
  dateEl.dateTime  = item.pubDate;    // ISO date string, safe as attribute
  dateEl.textContent = formatRelativeTime(item.pubDate);

  meta.appendChild(badge);
  meta.appendChild(source);
  meta.appendChild(dateEl);

  // ── Title link ─────────────────────────────────────────────────────────
  const titleLink = document.createElement('a');
  titleLink.className = 'card-title';
  titleLink.href      = item.link;    // validated HTTPS URL
  titleLink.textContent = item.title; // textContent — safe
  titleLink.target    = '_blank';
  titleLink.rel       = 'noopener noreferrer'; // prevent tab-napping

  // ── Summary ────────────────────────────────────────────────────────────
  const summary = document.createElement('p');
  summary.className   = 'card-summary';
  summary.textContent = item.summary || 'Klik judul untuk membaca artikel lengkap.';

  // ── Footer / read-more link ────────────────────────────────────────────
  const footer = document.createElement('div');
  footer.className = 'card-footer';

  const readMore = document.createElement('a');
  readMore.className  = 'card-read-more';
  readMore.href       = item.link;    // validated HTTPS URL
  readMore.textContent = 'Baca Selengkapnya →';
  readMore.target     = '_blank';
  readMore.rel        = 'noopener noreferrer'; // prevent tab-napping

  footer.appendChild(readMore);

  article.appendChild(meta);
  article.appendChild(titleLink);
  article.appendChild(summary);
  article.appendChild(footer);

  return article;
}

function showSkeleton() {
  const list = document.getElementById('cardList');
  // Safe: clearing our own content, not rendering external data
  list.innerHTML = '';

  const frag = document.createDocumentFragment();
  for (let i = 0; i < 5; i++) {
    const card = document.createElement('div');
    card.className = 'skeleton-card';
    ['skeleton-line skeleton-title', 'skeleton-line skeleton-text', 'skeleton-line skeleton-text short'].forEach((cls) => {
      const line = document.createElement('div');
      line.className = cls;
      card.appendChild(line);
    });
    frag.appendChild(card);
  }
  list.appendChild(frag);
  document.getElementById('pagination').style.display = 'none';
}

function showError(message) {
  const list = document.getElementById('cardList');
  list.innerHTML = ''; // safe: clearing own content

  const wrap = document.createElement('div');
  wrap.className = 'error-state';

  const icon = document.createElement('div');
  icon.className = 'error-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '⚠️';

  const msg = document.createElement('p');
  msg.className   = 'error-message';
  msg.textContent = message; // message is always an internal string

  const btn = document.createElement('button');
  btn.className   = 'retry-btn';
  btn.textContent = 'Coba Lagi';
  btn.addEventListener('click', () => loadTab(state.activeTab));

  wrap.appendChild(icon);
  wrap.appendChild(msg);
  wrap.appendChild(btn);
  list.appendChild(wrap);
  document.getElementById('pagination').style.display = 'none';
}

function renderInitialCards(tabName) {
  const ts   = state.tabs[tabName];
  const list = document.getElementById('cardList');
  list.innerHTML = ''; // safe: clearing own content

  if (ts.items.length === 0) {
    showError('Tidak ada berita yang tersedia saat ini.');
    return;
  }

  const frag = document.createDocumentFragment();
  ts.items.slice(0, ITEMS_PER_PAGE).forEach((item) => frag.appendChild(createCard(item)));
  list.appendChild(frag);

  ts.displayCount = Math.min(ITEMS_PER_PAGE, ts.items.length);
  updatePagination(tabName);
}

function appendCards(tabName) {
  const ts   = state.tabs[tabName];
  const next = ts.items.slice(ts.displayCount, ts.displayCount + ITEMS_PER_PAGE);
  if (next.length === 0) return;

  const list = document.getElementById('cardList');
  const frag = document.createDocumentFragment();
  next.forEach((item) => frag.appendChild(createCard(item)));
  list.appendChild(frag);

  ts.displayCount += next.length;
  updatePagination(tabName);
}

function updatePagination(tabName) {
  const ts  = state.tabs[tabName];
  const pag = document.getElementById('pagination');
  const btn = document.getElementById('loadMoreBtn');

  if (ts.displayCount < ts.items.length) {
    const remaining  = ts.items.length - ts.displayCount;
    // textContent — safe, counts are numbers
    btn.textContent = `Load More (${remaining} tersisa)`;
    pag.style.display = 'flex';
  } else {
    pag.style.display = 'none';
  }
}

function updateStatusBar(text) {
  // textContent — safe, text is always an internal string
  document.getElementById('lastUpdated').textContent = text;
}

// ═══════════════════════════════════════════════════════════════════════════
// Load Tab Data
// ═══════════════════════════════════════════════════════════════════════════

async function loadTab(tabName, isRefresh = false, isManual = false) {
  const ts = state.tabs[tabName];
  if (ts.loading) return;

  ts.loading = true;
  setRefreshLoading(true);

  // Restore from localStorage immediately — prevents blank screen on tab switch / return visit
  if (ts.items.length === 0) {
    const cached = loadFromCache(tabName);
    if (cached) {
      ts.items = cached;
      ts.displayCount = 0;
      renderInitialCards(tabName);
    }
  }

  // Show skeleton only when there is genuinely nothing to display yet
  if (ts.items.length === 0) {
    showSkeleton();
  }

  updateStatusBar('Memuat berita…');

  try {
    const { items, failCount, total } = await fetchAllFeeds(tabName);

    // Count new items compared to previous top item date
    let newCount = 0;
    if (isRefresh && ts.lastTopDate && items.length > 0) {
      const prevTime = new Date(ts.lastTopDate).getTime();
      newCount = items.filter((it) => new Date(it.pubDate).getTime() > prevTime).length;
    }

    ts.items        = items;
    ts.displayCount = 0;
    if (items.length > 0) {
      ts.lastTopDate = items[0].pubDate;
      saveToCache(tabName, items);
    }

    if (failCount === total) {
      // All feeds failed — keep showing cached data if available
      const stale = loadFromCache(tabName);
      if (stale && stale.length > 0) {
        ts.items = stale;
        ts.displayCount = 0;
        renderInitialCards(tabName);
        showToast('Gagal memperbarui. Menampilkan data tersimpan.');
        updateStatusBar('Tidak dapat memperbarui · data tersimpan');
      } else {
        showError('Gagal memuat semua feed. Periksa koneksi internet Anda.');
        updateStatusBar('Gagal memuat berita');
      }
    } else {
      renderInitialCards(tabName);
      const time   = currentTimeString();
      const suffix = failCount > 0
        ? ` · ${failCount} dari ${total} feed gagal`
        : ` · ${items.length} artikel`;
      updateStatusBar(`Diperbarui ${time}${suffix}`);

      // Show toast notification
      if (newCount > 0) {
        showToast(`${newCount} berita baru tersedia`);
      } else if (isManual) {
        showToast('Feed diperbarui');
      }
    }

  } catch (err) {
    console.error('[RSS] loadTab error:', err);
    if (ts.items.length > 0) {
      showToast('Gagal memperbarui. Menampilkan data tersimpan.');
      updateStatusBar('Tidak dapat memperbarui · data tersimpan');
    } else {
      showError('Gagal memuat berita. Periksa koneksi internet Anda.');
      updateStatusBar('Gagal memuat');
    }
  } finally {
    ts.loading = false;
    setRefreshLoading(false);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Refresh Button State
// ═══════════════════════════════════════════════════════════════════════════

function setRefreshLoading(loading) {
  const icon = document.getElementById('refreshIcon');
  const btn  = document.getElementById('refreshBtn');
  icon.classList.toggle('spinning', loading);
  btn.disabled = loading;
  if (loading) btn.setAttribute('aria-busy', 'true');
  else         btn.removeAttribute('aria-busy');
}

// ═══════════════════════════════════════════════════════════════════════════
// Auto-Refresh Timer
// ═══════════════════════════════════════════════════════════════════════════

function startAutoRefresh() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    loadTab(state.activeTab, true, false);
  }, REFRESH_INTERVAL);
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab Switching
// ═══════════════════════════════════════════════════════════════════════════

function switchTab(tabName) {
  // Validate tabName to prevent prototype pollution or unexpected keys
  if (tabName === state.activeTab || !Object.prototype.hasOwnProperty.call(FEEDS, tabName)) return;

  state.activeTab = tabName;
  localStorage.setItem('activeTab', tabName);

  // Update ARIA and visual state of tab buttons
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const isActive = btn.dataset.tab === tabName;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  const ts = state.tabs[tabName];
  if (ts.items.length === 0) {
    loadTab(tabName);
  } else {
    renderInitialCards(tabName);
    updateStatusBar(`Diperbarui ${currentTimeString()} · ${ts.items.length} artikel`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Service Worker Registration
// ═══════════════════════════════════════════════════════════════════════════

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch((err) => {
        // Non-fatal — app still works without SW (online mode)
        console.warn('[SW] Registration failed:', err);
      });
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Initialisation
// ═══════════════════════════════════════════════════════════════════════════

function init() {
  registerServiceWorker();

  // Restore and validate saved tab from localStorage
  const savedTab = localStorage.getItem('activeTab');
  if (savedTab && Object.prototype.hasOwnProperty.call(FEEDS, savedTab)) {
    state.activeTab = savedTab;
  }

  // Sync tab button visual state on startup
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    const isActive = btn.dataset.tab === state.activeTab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Manual refresh button
  document.getElementById('refreshBtn').addEventListener('click', () => {
    loadTab(state.activeTab, true, true);
    startAutoRefresh(); // reset the 1-hour timer on manual refresh
  });

  // Pagination: load next batch
  document.getElementById('loadMoreBtn').addEventListener('click', () => {
    appendCards(state.activeTab);
  });

  // Re-fetch when app returns to foreground (e.g. switching back from another app)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadTab(state.activeTab, true, false);
      startAutoRefresh(); // reset timer so next auto-refresh is 1h from now
    }
  });

  // Initial load
  loadTab(state.activeTab);
  startAutoRefresh();

  // Silently pre-load the background tab so switching tabs is instant
  const bgTab = Object.keys(FEEDS).find((t) => t !== state.activeTab);
  if (bgTab) {
    fetchAllFeeds(bgTab).then(({ items }) => {
      if (items.length > 0) {
        const bts = state.tabs[bgTab];
        bts.items        = items;
        bts.displayCount = 0;
        bts.lastTopDate  = items[0].pubDate || null;
        saveToCache(bgTab, items);
      }
    }).catch(() => {});
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
init();
