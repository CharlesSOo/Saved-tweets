const $ = (id) => document.getElementById(id);
let state = { tweets: {}, serverDown: false, syncStatus: null, loggedOut: false, detailProgress: null };

const send = (msg) => chrome.runtime.sendMessage(msg);
const SERVER = 'http://127.0.0.1:7391';
const md = (text) => {
  const div = el('div', { class: 'md' });
  div.innerHTML = globalThis.BookmarkSyncMarkdown.render(text); // escaped + limited subset, see md.js
  return div;
};

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

const LINK = 'text-[#60a5fa] hover:underline break-all';
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
    el('div', { class: 'w-10 rounded-full bg-base-300 text-muted' }, el('span', { class: 'text-sm' }, letter)));
}

function menuItem(label, onclick) {
  return el('li', {}, el('button', { onclick: (e) => { document.activeElement?.blur(); onclick(e); } }, label));
}

function summaryBlock(t) {
  let body;
  if (t.summarizing) {
    body = el('div', { class: 'flex items-center gap-2 text-muted text-sm' }, el('span', { class: 'loading loading-spinner loading-xs' }), 'Summarizing…');
  } else if (t.summary && t.status === 'summarized') {
    body = el('div', { class: 'text-[15px] leading-[1.45] text-base-content' }, md(t.summary));
  } else if (t.status === 'failed') {
    body = el('div', { class: 'text-sm text-muted space-y-1' },
      el('p', {}, 'Summary failed.'),
      t.error && el('p', { class: 'text-xs whitespace-pre-wrap break-words' }, t.error),
      el('button', { class: 'btn btn-xs mt-1', onclick: () => send({ type: 'summarize', id: t.id }) }, 'Retry'));
  } else {
    const why = t.needsFetch ? 'Waiting for the tweet content.' : !t.threadChecked ? 'Fetching thread, then summarizing…' : state.serverDown ? 'Pending: summarizer server not reachable.' : 'Pending.';
    body = el('p', { class: 'text-sm text-muted' }, why);
  }
  return el('section', { class: 'rounded-r-lg border-l-2 border-[#7c8cff] bg-[#1e2230] px-3 py-2.5 space-y-1.5' },
    el('div', { class: 'flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#a5b0ff]' }, el('span', { 'aria-hidden': 'true' }, '✦'), 'Summary'),
    body);
}

function card(t) {
  const handle = (t.handle || '').replace(/^@/, '');
  const text = t.needsFetch ? el('em', { class: 'text-muted' }, 'content not captured') : linkify(t.text || '');
  const images = (t.media || []).filter((u) => !/\.mp4(\?|$)/.test(u));
  return el('article', { id: `card-${t.id}`, class: 'card bg-base-100 border border-base-300 rounded-xl transition-shadow' },
    el('div', { class: 'card-body p-4 gap-3' },
      el('div', { class: 'flex items-start gap-3' },
        avatar(t),
        el('div', { class: 'flex-1 min-w-0 flex flex-wrap items-baseline gap-x-1.5 leading-5' },
          handle
            ? el('a', { href: `https://x.com/${handle}`, target: '_blank', class: 'font-bold hover:underline truncate' }, t.author || handle)
            : el('span', { class: 'font-bold' }, 'Unknown'),
          handle && el('span', { class: 'text-muted text-sm' }, '@' + handle),
          el('span', { class: 'text-muted text-sm' }, '·'),
          el('a', { href: t.url, target: '_blank', class: 'text-muted text-sm hover:underline' }, shortDate(t.createdAt)),
        ),
        el('div', { class: 'dropdown dropdown-end' },
          el('div', { tabindex: '0', role: 'button', class: 'btn btn-ghost btn-sm btn-circle text-muted', 'aria-label': 'Actions' }, '⋯'),
          el('ul', { tabindex: '0', class: 'dropdown-content menu menu-sm z-10 w-40 rounded-box border border-base-300 bg-base-100 p-1 shadow-sm' },
            !t.needsFetch && menuItem('Summarize', () => send({ type: 'summarize', id: t.id })),
            menuItem('Open on X', () => window.open(t.url, '_blank')),
            menuItem('Delete', () => confirm('Delete this bookmark?') && send({ type: 'delete', id: t.id })),
          ),
        ),
      ),
      el('div', { class: 'text-[15px] leading-[1.45] text-base-content whitespace-pre-wrap break-words' }, text),
      summaryBlock(t),
      t.thread && el('details', { class: 'text-[15px] leading-[1.45] text-base-content' },
        el('summary', { class: 'cursor-pointer text-sm text-muted' }, 'Show thread'),
        el('div', { class: 'whitespace-pre-wrap break-words mt-2' }, linkify(t.thread))),
      images.length > 0 && el('div', { class: 'grid grid-cols-2 gap-1.5' },
        images.map((src) => el('a', { href: src, target: '_blank' }, el('img', { src, loading: 'lazy', class: 'w-full h-40 object-cover rounded-lg border border-base-300' })))),
      t.quoted && el('div', { class: 'border border-base-300 rounded-lg p-3 text-sm text-muted whitespace-pre-wrap break-words' }, linkify(t.quoted)),
      t.detailError && el('p', { class: 'text-xs text-muted' }, t.detailError),
    ),
  );
}

function render() {
  const all = Object.values(state.tweets).sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  const q = $('search').value.trim().toLowerCase();
  const shown = all.filter((t) => {
    if (q && ![t.text, t.thread, t.author, t.handle, t.summary].some((f) => f?.toLowerCase().includes(q))) return false;
    return true;
  });

  $('count').textContent = shown.length === all.length ? String(all.length) : `${shown.length} of ${all.length}`;
  $('pending').textContent = `Summarize pending (${all.filter((t) => t.status !== 'summarized').length})`;
  $('banner').hidden = !state.serverDown;
  $('chatDown').hidden = !state.serverDown;
  $('loggedOut').hidden = !state.loggedOut;

  const s = state.syncStatus;
  const running = s?.running && Date.now() - (s.startedAt || 0) < 10 * 60 * 1000;
  $('sync').disabled = !!running;
  $('sync').replaceChildren(...(running ? [el('span', { class: 'loading loading-spinner loading-xs' }), `Syncing ${s.count}`] : ['Sync']));
  const syncLine = !s || running ? '' : s.error ? `Last sync failed: ${s.error}` : `Last sync ${new Date(s.finishedAt).toLocaleString()}: ${s.count} seen, ${s.added} new`;
  const d = state.detailProgress;
  const detailLine = d?.running ? `Fetching threads ${d.done}/${d.total}` : '';
  $('notice').textContent = [detailLine, syncLine].filter(Boolean).join(' · ');


  $('list').replaceChildren(...(shown.length ? shown.map(card) : [el('p', { class: 'text-center text-sm text-muted py-10' }, 'No bookmarks.')]));
}

async function load() {
  state = { tweets: {}, serverDown: false, syncStatus: null, loggedOut: false, detailProgress: null, ...(await chrome.storage.local.get(['tweets', 'serverDown', 'syncStatus', 'loggedOut', 'detailProgress'])) };
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
// ---------- Summary instructions ----------
$('openSettings').addEventListener('click', async () => {
  $('instructions').value = (await chrome.storage.local.get('summaryInstructions')).summaryInstructions || '';
  $('settings').showModal();
});
$('saveInstructions').addEventListener('click', async () => {
  await chrome.storage.local.set({ summaryInstructions: $('instructions').value.trim() });
  $('settings').close();
});
$('resummarizeAll').addEventListener('click', async () => {
  await chrome.storage.local.set({ summaryInstructions: $('instructions').value.trim() });
  if (!confirm('Re-summarize every bookmark with these instructions?')) return;
  $('settings').close();
  send({ type: 'resummarizeAll' });
});

// ---------- Chat ----------
let chatSession = crypto.randomUUID();
let chatBusy = false;

function miniCard(id) {
  const t = state.tweets[id];
  if (!t) return el('span', { class: 'text-xs text-muted' }, `[tweet ${id}]`);
  const snippet = (t.text || '').replace(/\s+/g, ' ').slice(0, 80) + ((t.text || '').length > 80 ? '…' : '');
  const pic = t.avatar
    ? el('img', { src: t.avatar, alt: '', class: 'w-4 h-4 rounded-full shrink-0' })
    : el('span', { class: 'w-4 h-4 rounded-full bg-base-300 text-[9px] text-muted flex items-center justify-center shrink-0' }, (t.author || '?').charAt(0).toUpperCase());
  return el('button', {
    type: 'button',
    class: 'inline-flex items-center gap-1.5 max-w-full align-middle my-0.5 px-2 py-0.5 rounded-lg border border-base-300 bg-base-100 hover:bg-[#1e2230] text-left text-xs',
    onclick: () => focusCard(id),
  }, pic, el('span', { class: 'font-semibold text-base-content shrink-0' }, t.handle), el('span', { class: 'text-muted truncate' }, snippet));
}

function renderAnswer(container, text) {
  const node = md(text);
  for (const ph of node.querySelectorAll('span[data-tweet]')) ph.replaceWith(miniCard(ph.dataset.tweet));
  container.replaceChildren(node);
}

function focusCard(id) {
  $('chatToggle').checked = false;
  if (!document.getElementById(`card-${id}`)) { $('search').value = ''; render(); }
  const c = document.getElementById(`card-${id}`);
  if (!c) return;
  c.scrollIntoView({ behavior: 'smooth', block: 'center' });
  c.classList.add('ring-2', 'ring-[#7c8cff]');
  setTimeout(() => c.classList.remove('ring-2', 'ring-[#7c8cff]'), 2000);
}

function bubble(side, content) {
  const body = el('div', { class: side === 'end' ? 'chat-bubble bg-[#2b3350] text-base-content text-sm' : 'chat-bubble bg-base-300 text-base-content text-sm max-w-[95%]' }, content);
  $('chatLog').append(el('div', { class: `chat chat-${side}` }, body));
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  return body;
}

$('chatForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const message = $('chatInput').value.trim();
  if (!message || chatBusy) return;
  chatBusy = true;
  $('chatSend').disabled = true;
  $('chatEmpty')?.remove();
  $('chatInput').value = '';
  bubble('end', message);
  const out = bubble('start', el('span', { class: 'loading loading-dots loading-sm' }));
  let text = '';
  try {
    const { summaryInstructions } = await chrome.storage.local.get('summaryInstructions');
    const res = await fetch(`${SERVER}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId: chatSession, instructions: summaryInstructions || '' }),
    });
    if (!res.ok) throw new Error(await res.text());
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      renderAnswer(out, text);
      $('chatLog').scrollTop = $('chatLog').scrollHeight;
    }
    if (!text.trim()) renderAnswer(out, '_No answer._');
  } catch (err) {
    if (err instanceof TypeError) { // network: server down
      await chrome.storage.local.set({ serverDown: true });
      out.replaceChildren('Server not reachable.');
    } else {
      out.replaceChildren(`Error: ${err.message}`);
    }
  } finally {
    chatBusy = false;
    $('chatSend').disabled = false;
  }
});

$('newChat').addEventListener('click', () => {
  if (chatBusy) return;
  chatSession = crypto.randomUUID();
  $('chatLog').replaceChildren(el('p', { id: 'chatEmpty', class: 'text-sm text-muted px-1' }, 'New chat. Ask about your bookmarks.'));
});

chrome.storage.onChanged.addListener((_, area) => area === 'local' && load());
load();
send({ type: 'syncIfStale' });
