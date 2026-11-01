// Minimal, safe Markdown -> HTML: HTML is escaped first, then a limited subset is rendered
// (headings, paragraphs, bullet/numbered/task lists, **bold**, *italic*, `code`, http(s) links).
// [[tweet:<id>]] becomes <span data-tweet="<id>"></span> for the caller to fill in.
(() => {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function inline(s) {
    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
    s = s
      .replace(/\[\[tweet:(\d+)\]\]/g, '<span data-tweet="$1"></span>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
  }

  function render(src) {
    const lines = esc(String(src || '')).replace(/\r/g, '').split('\n');
    const out = [];
    let para = [];
    let list = null; // 'ul' | 'ol'
    const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`); para = []; };
    const closeList = () => { if (list) out.push(`</${list}>`); list = null; };
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flushPara(); closeList(); continue; }
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
        flushPara(); closeList();
        out.push(`<h${Math.min(m[1].length + 2, 6)}>${inline(m[2])}</h${Math.min(m[1].length + 2, 6)}>`);
      } else if ((m = line.match(/^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/))) {
        flushPara();
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        const box = m[1] === undefined ? '' : m[1].trim() ? '☑ ' : '☐ ';
        out.push(`<li>${box}${inline(m[2])}</li>`);
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
        flushPara(); closeList(); out.push('<hr>');
      } else {
        closeList();
        para.push(line.trim());
      }
    }
    flushPara(); closeList();
    return out.join('');
  }

  const api = { render };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.BookmarkSyncMarkdown = api;
})();
