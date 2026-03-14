// ===== STORAGE SCHEMA =====
// localStorage['usl_lists']  → [{ id, name, createdAt }]
// localStorage['usl_items_<id>'] → [{ url, domain, addedAt }]
// localStorage['usl_active'] → listId

const LS_LISTS  = 'usl_lists';
const LS_ACTIVE = 'usl_active';
const itemsKey  = id => `usl_items_${id}`;

// ===== STATE =====
let lists      = [];   // [{id, name, createdAt}]
let activeId   = null; // currently selected list id
let modalMode  = null; // 'new' | 'rename'

// ===== DOM =====
const listsNav       = document.getElementById('listsNav');
const currentListName= document.getElementById('currentListName');
const mobileListName = document.getElementById('mobileListName');
const itemCountBadge = document.getElementById('itemCountBadge');
const clearAllBtn    = document.getElementById('clearAllBtn');
const urlInput       = document.getElementById('urlInput');
const feedbackMsg    = document.getElementById('feedbackMsg');
const productList    = document.getElementById('productList');
const emptyState     = document.getElementById('emptyState');
const modalBackdrop  = document.getElementById('modalBackdrop');
const modal          = document.getElementById('modal');
const modalTitle     = document.getElementById('modalTitle');
const modalInput     = document.getElementById('modalInput');
const sidebar        = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
  loadLists();

  if (lists.length === 0) {
    createList('My List', false);
  } else {
    const savedActive = localStorage.getItem(LS_ACTIVE);
    activeId = lists.find(l => l.id === savedActive) ? savedActive : lists[0].id;
  }

  renderSidebar();
  renderContent();

  urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') addItem(); });
  urlInput.addEventListener('input',   () => clearFeedback());
  modalInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmModal(); });
});

// ===== LIST STORAGE =====
function loadLists() {
  try { lists = JSON.parse(localStorage.getItem(LS_LISTS)) || []; }
  catch { lists = []; }
}

function saveLists() {
  localStorage.setItem(LS_LISTS, JSON.stringify(lists));
  localStorage.setItem(LS_ACTIVE, activeId);
}

function getItems(id) {
  try { return JSON.parse(localStorage.getItem(itemsKey(id))) || []; }
  catch { return []; }
}

function saveItems(id, items) {
  localStorage.setItem(itemsKey(id), JSON.stringify(items));
}

// ===== LIST ACTIONS =====
function createList(name, switchTo = true) {
  const id = 'list_' + Date.now();
  lists.push({ id, name, createdAt: Date.now() });
  saveItems(id, []);
  if (switchTo || lists.length === 1) {
    activeId = id;
  }
  saveLists();
  renderSidebar();
  if (switchTo) renderContent();
}

function switchList(id) {
  activeId = id;
  saveLists();
  renderSidebar();
  renderContent();
  clearFeedback();
  closeSidebar();
}

function deleteList(id, e) {
  if (e) e.stopPropagation();
  const list = lists.find(l => l.id === id);
  if (!list) return;

  const items = getItems(id);
  const msg = items.length > 0
    ? `Delete "${list.name}" and its ${items.length} item(s)?`
    : `Delete "${list.name}"?`;

  if (!confirm(msg)) return;

  localStorage.removeItem(itemsKey(id));
  lists = lists.filter(l => l.id !== id);
  saveLists();

  if (lists.length === 0) {
    createList('My List', true);
    return;
  }

  if (activeId === id) {
    activeId = lists[0].id;
    saveLists();
  }

  renderSidebar();
  renderContent();
}

function renameList(id, newName) {
  const list = lists.find(l => l.id === id);
  if (!list) return;
  list.name = newName.trim();
  saveLists();
  renderSidebar();
  renderContent();
}

// ===== ITEM ACTIONS =====
async function addItem() {
  const raw = urlInput.value.trim();
  if (!raw) { showFeedback('Please paste a product URL first.', 'error'); urlInput.focus(); return; }

  const url = raw.startsWith('http') ? raw : 'https://' + raw;
  if (!isValidUrl(url)) { showFeedback("That doesn't look like a valid URL.", 'error'); return; }

  const items = getItems(activeId);
  if (items.some(i => i.url === url)) { showFeedback('Item already in list.', 'error'); return; }

  // Optimistically add with loading title
  const domain = extractDomain(url);
  const newItem = { url, domain, title: null, addedAt: Date.now() };
  items.unshift(newItem);
  saveItems(activeId, items);
  renderContent();

  urlInput.value = '';
  showFeedback('Added! Fetching product name…', 'success');
  urlInput.focus();

  // Fetch product title in background
  const title = await fetchProductTitle(url);

  // Update stored item with title
  const stored = getItems(activeId);
  const target = stored.find(i => i.url === url);
  if (target) {
    target.title = title;
    saveItems(activeId, stored);
    renderContent();
  }

  showFeedback('Added to your list ✓', 'success');
}

// Ordered list of id/class patterns to try, most-specific first.
// Each entry: { attr: 'id'|'class', value: string }
const TITLE_SELECTORS = [
  // Amazon
  { attr: 'id',    value: 'productTitle' },
  // eBay
  { attr: 'class', value: 'x-item-title__mainTitle' },
  { attr: 'id',    value: 'itemTitle' },
  // Etsy
  { attr: 'class', value: 'wt-text-body-03' },
  // Walmart
  { attr: 'class', value: 'prod-ProductTitle' },
  { attr: 'itemprop', value: 'name' },
  // Best Buy
  { attr: 'class', value: 'heading-5' },
  // Generic schema / open graph / meta patterns (handled separately below)
];

async function fetchProductTitle(url) {
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const html = data.contents || '';

    // 1. Try known product title element selectors via regex on raw HTML
    for (const sel of TITLE_SELECTORS) {
      const pattern = new RegExp(
        `<[^>]+${sel.attr}=["'][^"']*${escapeRegex(sel.value)}[^"']*["'][^>]*>([\\s\\S]{1,600}?)<\\/`,
        'i'
      );
      const m = html.match(pattern);
      if (m) {
        const text = stripTags(m[1]).trim();
        if (text.length > 3) return text;
      }
    }

    // 2. Try Open Graph og:title meta tag
    const ogMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{3,300})["']/i)
                 || html.match(/<meta[^>]+content=["']([^"']{3,300})["'][^>]+property=["']og:title["']/i);
    if (ogMatch) return decodeEntities(ogMatch[1].trim());

    // 3. Fall back to <title> tag, stripping site name suffix
    const titleMatch = html.match(/<title[^>]*>([^<]{3,300})<\/title>/i);
    if (titleMatch) {
      let t = decodeEntities(titleMatch[1].trim());
      t = t.replace(/\s*[\|–—]\s*.{2,50}$/, '').trim();
      if (t.length > 3) return t;
    }

    return null;
  } catch {
    return null;
  }
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .trim();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeItem(url) {
  let items = getItems(activeId);
  items = items.filter(i => i.url !== url);
  saveItems(activeId, items);
  renderContent();
  clearFeedback();
}

function clearAll() {
  const items = getItems(activeId);
  if (items.length === 0) return;
  if (!confirm(`Remove all ${items.length} item(s) from this list?`)) return;
  saveItems(activeId, []);
  renderContent();
  showFeedback('List cleared.', 'success');
}

// exposed globally for delete button in list nav
function deleteCurrentList() {
  deleteList(activeId, null);
}

// ===== RENDER SIDEBAR =====
function renderSidebar() {
  listsNav.innerHTML = '';
  lists.forEach(list => {
    const items = getItems(list.id);
    const count = items.length;
    const isActive = list.id === activeId;

    const li = document.createElement('li');
    li.className = 'nav-item' + (isActive ? ' active' : '');

    li.innerHTML = `
      <button class="nav-item-btn" onclick="switchList('${list.id}')">
        <span class="nav-item-name" title="${escapeHtml(list.name)}">${escapeHtml(list.name)}</span>
        <span class="nav-item-count">${count} ${count === 1 ? 'item' : 'items'}</span>
      </button>
      <button class="nav-item-delete" title="Delete list" onclick="deleteList('${list.id}', event)">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 2l8 8M10 2L2 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
      </button>
    `;

    listsNav.appendChild(li);
  });
}

// ===== RENDER CONTENT =====
function renderContent() {
  const list  = lists.find(l => l.id === activeId);
  const items = getItems(activeId);
  const count = items.length;

  const name = list ? list.name : 'My List';
  currentListName.textContent = name;
  mobileListName.textContent  = name;
  itemCountBadge.textContent  = count === 1 ? '1 item' : `${count} items`;
  clearAllBtn.style.visibility = count > 0 ? 'visible' : 'hidden';

  productList.innerHTML = '';

  if (count === 0) {
    emptyState.classList.add('visible');
    return;
  }

  emptyState.classList.remove('visible');
  items.forEach(item => productList.appendChild(createListItem(item)));
}

function createListItem({ url, domain, title }) {
  const li = document.createElement('li');
  li.className = 'product-item';

  const displayUrl = url.length > 62 ? url.slice(0, 62) + '\u2026' : url;
  const initials   = domain.split('.')[0].slice(0, 2).toUpperCase();

  const titleHtml = title
    ? `<span class="item-title">${escapeHtml(title)}</span>`
    : `<span class="item-title item-title--loading">
        <span class="loading-dots"><span></span><span></span><span></span></span>
        Fetching name…
       </span>`;

  li.innerHTML = `
    <div class="favicon-wrap" title="${escapeHtml(domain)}">
      <img src="https://www.google.com/s2/favicons?sz=64&domain=${escapeHtml(domain)}"
           alt="${escapeHtml(domain)}"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
      <span class="favicon-fallback" style="display:none">${escapeHtml(initials)}</span>
    </div>
    <div class="item-info">
      ${titleHtml}
      <span class="item-domain">${escapeHtml(domain)}</span>
      <span class="item-url" title="${escapeHtml(url)}">${escapeHtml(displayUrl)}</span>
    </div>
    <div class="item-actions">
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="open-btn">
        Open
        <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
          <path d="M2 9L9 2M9 2H4M9 2v5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </a>
      <button class="remove-btn" title="Remove" onclick="removeItem('${escapeAttr(url)}')">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
  `;

  return li;
}

// ===== MODAL =====
function promptNewList() {
  modalMode = 'new';
  modalTitle.textContent = 'New List';
  modalInput.value = '';
  modalInput.placeholder = 'e.g. Birthday gifts';
  document.querySelector('.modal-confirm').textContent = 'Create';
  openModal();
}

function promptRenameList() {
  const list = lists.find(l => l.id === activeId);
  if (!list) return;
  modalMode = 'rename';
  modalTitle.textContent = 'Rename List';
  modalInput.value = list.name;
  modalInput.placeholder = 'List name';
  document.querySelector('.modal-confirm').textContent = 'Rename';
  openModal();
}

function openModal() {
  modalBackdrop.classList.add('open');
  modal.classList.add('open');
  setTimeout(() => modalInput.focus(), 50);
}

function closeModal() {
  modalBackdrop.classList.remove('open');
  modal.classList.remove('open');
  modalMode = null;
}

function confirmModal() {
  const name = modalInput.value.trim();
  if (!name) { modalInput.focus(); return; }

  if (modalMode === 'new') {
    createList(name, true);
  } else if (modalMode === 'rename') {
    renameList(activeId, name);
  }

  closeModal();
}

// ===== MOBILE SIDEBAR =====
function toggleSidebar() {
  sidebar.classList.toggle('open');
  sidebarOverlay.classList.toggle('open');
}

function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('open');
}

// ===== FEEDBACK =====
let feedbackTimer = null;

function showFeedback(msg, type = 'error') {
  clearTimeout(feedbackTimer);
  feedbackMsg.textContent = msg;
  feedbackMsg.className = 'feedback-msg ' + type;
  feedbackTimer = setTimeout(clearFeedback, 3500);
}

function clearFeedback() {
  feedbackMsg.textContent = '';
  feedbackMsg.className = 'feedback-msg';
}

// ===== URL UTILS =====
function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

function isValidUrl(url) {
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

// ===== SECURITY =====
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function escapeAttr(str) {
  return String(str).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
