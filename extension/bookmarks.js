const $ = (id) => document.getElementById(id);
let state = { tweets: {}, serverDown: false, syncStatus: null, xApi: null };
let notice = '';

const send = (msg) => chrome.runtime.sendMessage(msg);

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c);
  return e;
}

const LINK = 'text-[#2563eb] hover:underline break-all';
const URL_RE = /https?:\/\/[^\s]+/g;

// Text with URLs rendered as links showing the URL without the scheme.
function linkify(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    out.push(text.slice(last, m.index));
    out.push(el('a', { href: m[0], target: '_blank', class: LINK }, m[0].replace(/^https?:\/\//, '')));
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

const shortDate = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

function avatar(t) {
  if (t.avatar) {
    return el('div', { class: 'avatar shrink-0' }, el('div', { class: 'w-10 rounded-full' }, el('img', { src: t.avatar, alt: '' })));
  }
  const letter = (t.author || t.handle || '?').replace(/^@/, '').charAt(0).toUpperCase() || '?';
  return el('div', { class: 'avatar avatar-placeholder shrink-0' },
    el('div', { class: 'w-10 rounded-full bg-neutral-200 text-neutral-600' }, el('span', { class: 'text-sm' }, letter)));
}

function menuItem(label, onclick) {
  return el('li', {}, el('button', { onclick: (e) => { document.activeElement?.blur(); onclick(e); } }, label));
}

async function fetchThread(id) {
  const res = await send({ type: 'fetchThread', id });
  notice = res?.error || '';
  render();
}

function statusLabel(t) {
  if (t.summarizing) return el('span', { class: 'flex items-center gap-1 text-xs text-neutral-500' }, el('span', { class: 'loading loading-spinner loading-xs' }), 'Summarizing');
  const label = t.needsFetch ? 'content not captured' : t.status === 'summarized' ? null : t.status;
  return label && el('span', { class: 'badge badge-ghost badge-sm text-neutral-500' }, label);
}

function card(t) {
  const handle = (t.handle || '').replace(/^@/, '');
  const text = t.needsFetch ? el('em', { class: 'text-neutral-500' }, 'content not captured') : linkify(t.text || '');
  const images = (t.media || []).filter((u) => !/\.mp4(\?|$)/.test(u));
  return el('article', { class: 'card bg-base-100 border border-[#e5e5e5] rounded-xl' },
    el('div', { class: 'card-body p-4 gap-3' },
      el('div', { class: 'flex items-start gap-3' },
        avatar(t),
        el('div', { class: 'flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5 leading-5' },
          handle
            ? el('a', { href: `https://x.com/${handle}`, target: '_blank', class: 'font-bold hover:underline truncate' }, t.author || handle)
            : el('span', { class: 'font-bold' }, 'Unknown'),
          handle && el('span', { class: 'text-neutral-500 text-sm' }, '@' + handle),
          el('span', { class: 'text-neutral-400 text-sm' }, '·'),
          el('a', { href: t.url, target: '_blank', class: 'text-neutral-500 text-sm hover:underline' }, shortDate(t.createdAt)),
          el('span', { class: 'ml-1' }, statusLabel(t)),
        ),
        el('div', { class: 'dropdown dropdown-end' },
          el('div', { tabindex: '0', role: 'button', class: 'btn btn-ghost btn-sm btn-circle text-neutral-500', 'aria-label': 'Actions' }, '⋯'),
          el('ul', { tabindex: '0', class: 'dropdown-content menu menu-sm z-10 w-40 rounded-box border border-base-300 bg-base-100 p-1 shadow-sm' },
            !t.needsFetch && menuItem('Summarize', () => send({ type: 'summarize', id: t.id })),
            menuItem(t.needsFetch ? 'Fetch content' : t.thread ? 'Refetch thread' : 'Fetch thread', () => fetchThread(t.id)),
            menuItem('Open on X', () => window.open(t.url, '_blank')),
            menuItem('Delete', () => confirm('Delete this bookmark?') && send({ type: 'delete', id: t.id })),
          ),
        ),
      ),
      el('div', { class: 'text-[15px] leading-[1.45] text-[#171717] whitespace-pre-wrap break-words' }, text),
      t.thread && el('details', { class: 'text-[15px] leading-[1.45] text-[#171717]' },
        el('summary', { class: 'cursor-pointer text-sm text-neutral-500' }, 'Show thread'),
        el('div', { class: 'whitespace-pre-wrap break-words mt-2' }, linkify(t.thread))),
      images.length > 0 && el('div', { class: 'grid grid-cols-2 gap-1.5' },
        images.map((src) => el('a', { href: src, target: '_blank' }, el('img', { src, loading: 'lazy', class: 'w-full h-40 object-cover rounded-lg border border-[#e5e5e5]' })))),
      t.quoted && el('div', { class: 'border border-[#e5e5e5] rounded-lg p-3 text-sm text-neutral-600 whitespace-pre-wrap break-words' }, linkify(t.quoted)),
      t.tldr && el('div', { class: 'bg-[#fafafa] border-l-2 border-[#d4d4d4] rounded-r-md px-3 py-2' },
        el('p', { class: 'text-sm text-[#404040]' }, t.tldr)),
      t.error && el('p', { class: 'text-xs text-neutral-500 whitespace-pre-wrap' }, t.error),
    ),
  );
}

function render() {
  const all = Object.values(state.tweets).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  const q = $('search').value.trim().toLowerCase();
  const shown = all.filter((t) => {
    if (q && ![t.text, t.thread, t.author, t.handle, t.tldr].some((f) => f?.toLowerCase().includes(q))) return false;
    return true;
  });

  $('count').textContent = shown.length === all.length ? String(all.length) : `${shown.length} of ${all.length}`;
  $('pending').textContent = `Summarize pending (${all.filter((t) => t.status !== 'summarized').length})`;
  $('banner').hidden = !state.serverDown;
  $('needApi').hidden = !!state.xApi?.Bookmarks;

  const s = state.syncStatus;
  const running = s?.running && Date.now() - (s.startedAt || 0) < 10 * 60 * 1000;
  $('sync').disabled = !!running;
  $('sync').replaceChildren(...(running ? [el('span', { class: 'loading loading-spinner loading-xs' }), `Syncing ${s.count}`] : ['Sync']));
  const syncLine = !s || running ? '' : s.error ? `Last sync failed: ${s.error}` : `Last sync ${new Date(s.finishedAt).toLocaleString()}: ${s.count} seen, ${s.added} new`;
  $('notice').textContent = [notice, syncLine].filter(Boolean).join(' · ');


  $('list').replaceChildren(...(shown.length ? shown.map(card) : [el('p', { class: 'text-center text-sm text-neutral-500 py-10' }, 'No bookmarks.')]));
}

async function load() {
  state = { tweets: {}, serverDown: false, syncStatus: null, xApi: null, ...(await chrome.storage.local.get(['tweets', 'serverDown', 'syncStatus', 'xApi'])) };
  render();
}

async function download(format) {
  document.activeElement?.blur();
  const { content } = await send({ type: 'export', format });
  const blob = new Blob([content], { type: format === 'markdown' ? 'text/markdown' : 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `bookmarks.${format === 'markdown' ? 'md' : 'json'}` });
  a.click();
  URL.revokeObjectURL(a.href);
}

$('search').addEventListener('input', render);
$('sync').addEventListener('click', () => send({ type: 'syncBookmarks' })); // result lands in syncStatus
$('pending').addEventListener('click', () => send({ type: 'summarizePending' }));
$('retry').addEventListener('click', () => send({ type: 'summarizePending' }));
$('exportJson').addEventListener('click', () => download('json'));
$('exportMd').addEventListener('click', () => download('markdown'));
chrome.storage.onChanged.addListener((_, area) => area === 'local' && load());
load();
