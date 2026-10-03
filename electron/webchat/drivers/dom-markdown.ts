/**
 * Converts a rendered chat bubble back into the markdown the model actually wrote.
 *
 * `innerText` flattens everything: no code fences, no list markers, no emphasis, and it includes
 * UI text like "Copy code". This runs INSIDE the page (via handle.evaluate), so it must stay fully
 * self-contained: no imports, no references to outer scope, no DOM globals other than the node passed in.
 */
export function domToMarkdown(root: any): string {
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'BUTTON', 'TEXTAREA', 'INPUT', 'SELECT', 'IFRAME']);
  const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'UL', 'OL', 'LI', 'PRE', 'BLOCKQUOTE', 'TABLE', 'HR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'DETAILS', 'FIGURE']);
  const LANG = /^[a-z][a-z0-9+#._-]{0,24}$/i;

  const tag = (n: any): string => (n && n.nodeType === 1 ? String(n.tagName).toUpperCase() : '');
  const kids = (n: any): any[] => Array.prototype.slice.call(n.childNodes || []);
  const isHidden = (n: any): boolean => {
    if (n.nodeType !== 1) return false;
    if (n.getAttribute && (n.getAttribute('aria-hidden') === 'true' || n.hasAttribute('hidden'))) {
      // KaTeX keeps an aria-hidden visual copy; the MathML/annotation copy is what we read.
      return true;
    }
    const role = n.getAttribute && n.getAttribute('role');
    return role === 'button' || role === 'toolbar';
  };
  const hasBlockChild = (n: any): boolean => kids(n).some((c) => BLOCK.has(tag(c)) || (c.nodeType === 1 && hasBlockChild(c)));
  const hasPre = (n: any): boolean => tag(n) === 'PRE' || (n.nodeType === 1 && kids(n).some(hasPre));

  const fenceFor = (code: string): string => {
    let longest = 0;
    const runs = code.match(/`+/g) || [];
    for (const r of runs) longest = Math.max(longest, r.length);
    return '`'.repeat(Math.max(3, longest + 1));
  };

  const langOf = (pre: any): string => {
    const holder = (pre.querySelector && pre.querySelector('code')) || pre;
    const cls = String((holder.getAttribute && holder.getAttribute('class')) || '') + ' ' + String((pre.getAttribute && pre.getAttribute('class')) || '');
    const m = cls.match(/(?:language|lang)-([A-Za-z0-9+#._-]+)/);
    if (m) return m[1];
    const dl = (holder.getAttribute && holder.getAttribute('data-language')) || (pre.getAttribute && pre.getAttribute('data-language'));
    return dl ? String(dl) : '';
  };

  const inline = (n: any): string => {
    if (n.nodeType === 3) return String(n.nodeValue || '').replace(/\s+/g, ' ');
    if (n.nodeType !== 1 || SKIP.has(tag(n)) || isHidden(n)) return '';
    const t = tag(n);
    const cls = String((n.getAttribute && n.getAttribute('class')) || '');

    if (/\bkatex\b/.test(cls) && !/\bkatex-/.test(cls.replace(/\bkatex\b/, ''))) {
      const ann = n.querySelector && n.querySelector('annotation[encoding="application/x-tex"]');
      if (ann) return '$' + String(ann.textContent || '').trim() + '$';
    }
    const inner = () => kids(n).map(inline).join('');
    switch (t) {
      case 'BR': return '  \n';
      case 'STRONG': case 'B': { const x = inner().trim(); return x ? '**' + x + '**' : ''; }
      case 'EM': case 'I': { const x = inner().trim(); return x ? '*' + x + '*' : ''; }
      case 'DEL': case 'S': { const x = inner().trim(); return x ? '~~' + x + '~~' : ''; }
      case 'CODE': {
        const x = String(n.textContent || '');
        if (!x) return '';
        const f = fenceFor(x).slice(0, Math.max(1, fenceFor(x).length - 2));
        return f + (x.startsWith('`') || x.endsWith('`') ? ' ' + x + ' ' : x) + f;
      }
      case 'A': {
        const text = inner().trim();
        const href = n.getAttribute && n.getAttribute('href');
        if (!href || !text || /^javascript:/i.test(href)) return text;
        return text === href ? href : '[' + text + '](' + href + ')';
      }
      case 'IMG': {
        const alt = (n.getAttribute && n.getAttribute('alt')) || '';
        const src = (n.getAttribute && n.getAttribute('src')) || '';
        return /^https?:/i.test(src) ? '![' + alt + '](' + src + ')' : '';
      }
      default: return inner();
    }
  };

  const indent = (s: string, pad: string): string => s.split('\n').map((l, i) => (l.trim() === '' ? '' : (i === 0 ? '' : pad) + l)).join('\n');

  const list = (n: any, ordered: boolean): string => {
    const start = ordered ? parseInt((n.getAttribute && n.getAttribute('start')) || '1', 10) || 1 : 0;
    const items = kids(n).filter((c) => tag(c) === 'LI');
    return items
      .map((li, i) => {
        const marker = ordered ? start + i + '. ' : '- ';
        const parts = blocks(li);
        // Tight join before a nested list: "one\n  - nested", not "one\n\n  - nested" (loose).
        const nested = kids(li).some((c) => tag(c) === 'UL' || tag(c) === 'OL');
        const body = (parts.length ? parts.join(nested ? '\n' : '\n\n') : '') || inlineText(li);
        return marker + indent(body, ' '.repeat(marker.length));
      })
      .join('\n');
  };

  const inlineText = (n: any): string => kids(n).map(inline).join('').replace(/[ \t]+\n/g, '\n').trim();

  const table = (n: any): string => {
    const rows = Array.prototype.slice.call(n.querySelectorAll('tr')) as any[];
    if (!rows.length) return '';
    const cellsOf = (tr: any) =>
      (Array.prototype.slice.call(tr.children) as any[])
        .filter((c) => tag(c) === 'TH' || tag(c) === 'TD')
        .map((c) => inlineText(c).replace(/\|/g, '\\|').replace(/\n/g, ' '));
    const data = rows.map(cellsOf).filter((r) => r.length);
    if (!data.length) return '';
    const width = Math.max(...data.map((r) => r.length));
    const pad = (r: string[]) => r.concat(Array(width - r.length).fill(''));
    const line = (r: string[]) => '| ' + pad(r).join(' | ') + ' |';
    return [line(data[0]), '| ' + Array(width).fill('---').join(' | ') + ' |', ...data.slice(1).map(line)].join('\n');
  };

  /** Block-level content of a node, as separate markdown blocks. */
  const blocks = (n: any): string[] => {
    const out: string[] = [];
    let run = '';
    const flush = () => {
      const x = run.replace(/[ \t]+\n/g, '\n').replace(/^\s+|\s+$/g, '');
      if (x) out.push(x);
      run = '';
    };
    const children = kids(n);
    let pendingLang = '';
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.nodeType === 3) { run += inline(c); continue; }
      if (c.nodeType !== 1 || SKIP.has(tag(c)) || isHidden(c)) continue;
      const t = tag(c);

      // Language label rendered as its own element right before a code block (e.g. "python" next to a Copy button).
      if ((t === 'DIV' || t === 'SPAN') && !hasPre(c)) {
        const label = inline(c).trim(); // inline() skips buttons, so "Copy" never leaks into the label
        const next = children.slice(i + 1).find((x: any) => x.nodeType === 1);
        if (label && LANG.test(label) && next && hasPre(next)) { pendingLang = label; continue; }
      }

      if (t === 'PRE') {
        flush();
        const codeEl = (c.querySelector && c.querySelector('code')) || c;
        const code = String(codeEl.textContent || '').replace(/\n$/, '');
        const lang = langOf(c) || pendingLang;
        pendingLang = '';
        const f = fenceFor(code);
        out.push(f + lang + '\n' + code + '\n' + f);
      } else if (/^H[1-6]$/.test(t)) {
        flush();
        const x = inlineText(c);
        if (x) out.push('#'.repeat(Number(t[1])) + ' ' + x);
      } else if (t === 'UL' || t === 'OL') {
        flush();
        const x = list(c, t === 'OL');
        if (x) out.push(x);
      } else if (t === 'BLOCKQUOTE') {
        flush();
        const x = blocks(c).join('\n\n');
        if (x) out.push(x.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n'));
      } else if (t === 'TABLE') {
        flush();
        const x = table(c);
        if (x) out.push(x);
      } else if (t === 'HR') {
        flush();
        out.push('---');
      } else if (t === 'P') {
        flush();
        const x = inlineText(c);
        if (x) out.push(x);
      } else if (BLOCK.has(t) || hasBlockChild(c) || hasPre(c)) {
        flush();
        for (const b of blocks(c)) out.push(b);
      } else {
        run += inline(c);
      }
    }
    flush();
    return out;
  };

  try {
    return blocks(root).join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    return '';
  }
}
