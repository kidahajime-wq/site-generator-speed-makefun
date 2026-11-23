// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01-run-20261122).
//
// Same answers as the reference, byte for byte, by the same pipeline — but the hot
// paths are restructured, not micro-tuned:
//   * Markdown inline rendering scans plain text in bulk instead of escaping one
//     character at a time (the reference calls a regex escape per character), and
//     finds closers with indexOf + a backslash-parity check instead of char scans.
//   * Block lexing uses direct character checks instead of a regex per line.
//   * Templates are walked with precomputed scope depths (no scope-chain search per
//     variable) and rendered into one shared output array (no intermediate strings).
//   * slugify results are memoised per build (tag names repeat across posts).
//   * Word counting scans code units against a whitespace table instead of building
//     a match array of every word.
// Everything else follows the reference pipeline step for step.

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' . */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. */
export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
export const SLUG_MAX = 64;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most SLUG_MAX
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * `cache` memoises it for this build only (tag names repeat across posts).
 */
export function slugify(text, cache) {
  if (cache !== undefined) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
  }
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = -1;
    if (code >= 65 && code <= 90) keep = code + 32;
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  if (cache !== undefined) cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

// ECMAScript WhiteSpace + LineTerminator code points (all BMP): what /\s/ matches.
const WS = new Uint8Array(65536);
for (const cp of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS[cp] = 1;

/** The words of a body: its runs of characters other than whitespace (as /\S+/g counts them). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
export const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 */
export function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line) || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) return { error: `line ${i + 1} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- markdown

const SPACE = 32;
const TAB = 9;

/** A line of spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== SPACE && c !== TAB) return false;
  }
  return true;
}

/** Whether `ch` is a fence language character (A-Z, a-z, 0-9, _, +, -). */
function isLangChar(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 43 || code === 45;
}

/** A fence's language, or null: ``` then a language of [A-Za-z0-9_+-]*, then spaces/tabs only. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const lang = line.slice(3, j);
  while (j < line.length && (line.charCodeAt(j) === SPACE || line.charCodeAt(j) === TAB)) j++;
  return j === line.length ? lang : null;
}

/** A fence's closing line: ``` then spaces or tabs only. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== SPACE && c !== TAB) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let k = 0;
  while (k < line.length && line.charCodeAt(k) === 35) k++;
  if (k === 0 || k > 6) return null;
  let j = k;
  if (j >= line.length || (line.charCodeAt(j) !== SPACE && line.charCodeAt(j) !== TAB)) return null;
  while (j < line.length && (line.charCodeAt(j) === SPACE || line.charCodeAt(j) === TAB)) j++;
  let end = line.length;
  while (end > j && (line.charCodeAt(end - 1) === SPACE || line.charCodeAt(end - 1) === TAB)) end--;
  if (end === j) return null;
  return { depth: k, text: line.slice(j, end) };
}

/** A thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const c = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && c === 45) || (a === 42 && b === 42 && c === 42))) return false;
  for (let j = 3; j < line.length; j++) {
    const d = line.charCodeAt(j);
    if (d !== SPACE && d !== TAB) return false;
  }
  return true;
}

/** A bullet item's text, or null: "- " or "* " then the rest. */
function bulletOf(line) {
  const a = line.charCodeAt(0);
  if ((a === 45 || a === 42) && line.charCodeAt(1) === SPACE) return line.slice(2);
  return null;
}

/** An ordered item's start number and text, or null: 1-9 digits, ". ", then the rest. */
function orderedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === 0 || j > 9) return null;
  if (line.charCodeAt(j) !== 46 || line.charCodeAt(j + 1) !== SPACE) return null;
  return { start: Number(line.slice(0, j)), text: line.slice(j + 2) };
}

/** A list continuation: two or more spaces, then a non-whitespace character. */
function isContinued(line) {
  if (line.charCodeAt(0) !== SPACE || line.charCodeAt(1) !== SPACE) return false;
  let j = 2;
  while (j < line.length && line.charCodeAt(j) === SPACE) j++;
  return j < line.length && WS[line.charCodeAt(j)] !== 1;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** A line trimmed of spaces and tabs at both ends (the same string when nothing trims). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === SPACE || line.charCodeAt(a) === TAB)) a++;
  while (b > a && (line.charCodeAt(b - 1) === SPACE || line.charCodeAt(b - 1) === TAB)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** `src`'s block tokens, in order. */
export function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang, lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
      i++;
      continue;
    }
    if (isHr(line)) {
      tokens.push({ type: 'hr' });
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === SPACE ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      tokens.push({ type: 'blockquote', lines: kept });
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        const m = isOrdered ? orderedOf(l) : bulletOf(l);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m.text : m)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? ordered.start : 1, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** Whether the character at `j` is backslash-escaped: an odd run of '\' just before it. */
function isEscapedAt(s, j) {
  let k = j - 1;
  let count = 0;
  while (k >= 0 && s.charCodeAt(k) === 92) {
    count++;
    k--;
  }
  return (count & 1) === 1;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1 && isEscapedAt(s, j)) j = s.indexOf(what, j + 1);
  return j;
}

/**
 * The first single * from `from` (one whose run is not **), outside an escape, or -1.
 * Mirrors the reference scan: a * followed by another * advances two positions.
 */
function findSingleStar(s, from) {
  let pos = from;
  for (;;) {
    const j = s.indexOf('*', pos);
    if (j === -1) return -1;
    if (isEscapedAt(s, j)) {
      pos = j + 1;
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      pos = j + 2;
      continue;
    }
    return j;
  }
}

// The characters special to inline rendering: " ' & * < > [ \ `
// One native regex scan finds the next one; the plain text before it needs no
// escaping (the regex stops at every escapable character).
const INLINE_RE = /["'&*<>[\\`]/g;

/** `s` rendered inline; `env.link(target)` is a link's href. */
export function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  INLINE_RE.lastIndex = 0;
  for (;;) {
    const m = INLINE_RE.exec(s);
    if (m === null) break;
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = m[0];
    if (c === '&') {
      out += '&amp;';
      i = j + 1;
    } else if (c === '<') {
      out += '&lt;';
      i = j + 1;
    } else if (c === '>') {
      out += '&gt;';
      i = j + 1;
    } else if (c === '"') {
      out += '&quot;';
      i = j + 1;
    } else if (c === "'") {
      out += '&#39;';
      i = j + 1;
    } else if (c === '\\') {
      const d = s[j + 1];
      if (d !== undefined && ESCAPABLE.has(d)) {
        // The only escapable character that is also HTML-special is '>'.
        out += d === '>' ? '&gt;' : d;
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
    } else {
      // '['
      const k = findUnescaped(s, ']', j + 1);
      const p = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = p === -1 ? '' : s.slice(k + 2, p);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
        i = p + 1;
      } else {
        out += '[';
        i = j + 1;
      }
    }
    INLINE_RE.lastIndex = i;
  }
  if (i < n) out += s.slice(i, n);
  return out;
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n" after
 * the last), its table of contents (every level 2 and 3 heading: level, id and its
 * inline HTML) and its excerpt (the first paragraph's inline HTML, or ""). The
 * block scan is the lexer's, rendering each block as it is recognized instead of
 * building token objects first.
 */
export function renderMarkdown(src, env, slugCache) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  const lines = src.split('\n');
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      const text = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
      blocks.push(`<pre><code${cls}>${text}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === SPACE ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.start : 1;
      const items = [];
      let cur = null;
      while (i < n) {
        const l = lines[i];
        const m = isOrdered ? orderedOf(l) : bulletOf(l);
        if (m !== null) {
          if (cur !== null) items.push(cur.join('\n'));
          cur = [trimLine(isOrdered ? m.text : m)];
          i++;
        } else if (isContinued(l)) {
          cur.push(trimLine(l));
          i++;
        } else break;
      }
      if (cur !== null) items.push(cur.join('\n'));
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let rendered = '';
      for (const item of items) rendered += `<li>${inline(item, env)}</li>\n`;
      blocks.push(`${open}\n${rendered}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
export const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
export class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  annotateDepths(root.body, []);
  return root.body;
}

// ---------------------------------------------------------------- scope depths
//
// A path's first name is read from the innermost loop that binds it, else from
// the page's values. The binding is fixed by where the node sits in the tree, so
// parse time records it: `depth` is how many for-scopes above the innermost the
// name is bound in (0 = the innermost for), or -1 when no enclosing for of this
// template binds it (then rendering walks the scopes from the innermost out, so an
// included template still reads its caller's loop variable). Rendering then
// indexes the scope array directly instead of searching the chain with hasOwn
// per step, for every name the template's own fors bind.

/** The depth of `name` in the for-stack (innermost last), or -1 for the root vars. */
function depthOf(name, stack) {
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k][0] === name || stack[k][1] === name) return stack.length - 1 - k;
  }
  return -1;
}

/** Record each path node's scope depth. `stack` holds one [varName, 'loop'] pair per enclosing for. */
function annotateDepths(nodes, stack) {
  for (const n of nodes) {
    if (n.path !== undefined) n.depth = depthOf(n.path[0], stack);
    if (n.kind === 'for') annotateDepths(n.body, [...stack, [n.name, 'loop']]);
    else if (n.kind === 'if') {
      annotateDepths(n.then, stack);
      if (n.else !== null) annotateDepths(n.else, stack);
    }
  }
}

/**
 * Mark paths whose first name is a root variable no for anywhere in the case
 * binds: they read the root vars directly (depth -2), with no chain walk.
 */
function markRootOnly(nodes, rootOnly) {
  for (const n of nodes) {
    if (n.path !== undefined && n.depth === -1 && rootOnly.has(n.path[0])) n.depth = -2;
    if (n.kind === 'for') markRootOnly(n.body, rootOnly);
    else if (n.kind === 'if') {
      markRootOnly(n.then, rootOnly);
      if (n.else !== null) markRootOnly(n.else, rootOnly);
    }
  }
}

/**
 * The value at `path` in the scope array. `depth` is the parse-time scope depth:
 * >= 0, the name is bound by this template's own enclosing for (indexed directly);
 * -2, the name is a root variable no for anywhere in the case binds, so it comes
 * from the root vars directly; -1, otherwise: walk the scopes from the innermost
 * out, exactly as the reference walks its parent chain (an included template
 * reading its caller's loop variable).
 */
function lookup(scopes, path, depth) {
  let v;
  if (depth === -2) {
    v = scopes[0][path[0]];
  } else if (depth >= 0) {
    v = scopes[scopes.length - 1 - depth][path[0]];
  } else {
    let found = false;
    for (let k = scopes.length - 1; k >= 0; k--) {
      if (Object.hasOwn(scopes[k], path[0])) {
        v = scopes[k][path[0]];
        found = true;
        break;
      }
    }
    if (!found) return undefined;
  }
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (one shared array, joined once by the top-level
 * render). `scopes` is the array of vars objects, root first, innermost last.
 * `ctx` holds the parsed templates, the HTML escape and the include depth.
 */
export function renderNodes(nodes, scopes, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scopes, n.path, n.depth))));
        break;
      case 'raw':
        out.push(textOf(lookup(scopes, n.path, n.depth)));
        break;
      case 'if': {
        const v = truthy(lookup(scopes, n.path, n.depth));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scopes, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scopes, n.path, n.depth);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          scopes.push(vars);
          renderNodes(n.body, scopes, ctx, depth, out);
          scopes.pop();
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        if (ctx.cacheable.get(n.name) === true) {
          // A template that only reads the case's site, tags and recent (never the
          // page, and never a caller's loop variable) renders the same string at
          // every include site in this case: render it once, at this depth.
          const key = `${n.name}@${depth + 1}`;
          let s = ctx.renderCache.get(key);
          if (s === undefined) {
            const out2 = [];
            renderNodes(t, [ctx.rootVars], ctx, depth + 1, out2);
            s = out2.join('');
            ctx.renderCache.set(key, s);
          }
          out.push(s);
        } else {
          renderNodes(t, scopes, ctx, depth + 1, out);
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- template caching
//
// A template whose every path reads only the case's site, tags or recent — never
// the page, never a caller's loop variable — renders the same string at every
// include site in the case (the shared partials that loop over `recent` are the
// classic case: they are re-rendered for every page otherwise). Such a template
// is rendered once per include depth and reused. The analysis is exact:
//   * a loop variable is clean only when the for's own path is clean, and `loop`
//     with it; any other first name is clean only when it is site, tags or recent;
//   * a template is cacheable only when all of its paths are clean and every
//     template it includes is cacheable (greatest fixpoint, so cycles stay in);
//   * caching is disabled for the whole case when any template binds site, tags
//     or recent as a for variable, since that could shadow the root names.

const ROOT_NAMES = new Set(['site', 'tags', 'recent']);

/** Collect every for variable name bound anywhere in `nodes` into `names`. */
function collectForNames(nodes, names) {
  for (const n of nodes) {
    if (n.kind === 'for') {
      names.add(n.name);
      collectForNames(n.body, names);
    } else if (n.kind === 'if') {
      collectForNames(n.then, names);
      if (n.else !== null) collectForNames(n.else, names);
    }
  }
}

/** Whether the first name of `path` is clean given the enclosing fors' bindings. */
function pathIsClean(path, stack) {
  const first = path[0];
  if (ROOT_NAMES.has(first)) return true;
  // `loop` is bound by every for, so the innermost for's binding is the one read.
  if (first === 'loop') return stack.length > 0 && stack[stack.length - 1].clean;
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k].name === first) return stack[k].clean;
  }
  return false;
}

/** Whether every path in `nodes` reads only clean names. `stack` holds one {name, clean} per enclosing for. */
function nodesAreClean(nodes, stack) {
  for (const n of nodes) {
    if (n.path !== undefined && !pathIsClean(n.path, stack)) return false;
    if (n.kind === 'for') {
      const clean = pathIsClean(n.path, stack);
      if (!nodesAreClean(n.body, [...stack, { name: n.name, clean }])) return false;
    } else if (n.kind === 'if') {
      if (!nodesAreClean(n.then, stack)) return false;
      if (n.else !== null && !nodesAreClean(n.else, stack)) return false;
    }
  }
  return true;
}

/** The names of the templates `nodes` includes, directly. */
function includesOf(nodes, out = new Set()) {
  for (const n of nodes) {
    if (n.kind === 'include') out.add(n.name);
    else if (n.kind === 'for') includesOf(n.body, out);
    else if (n.kind === 'if') {
      includesOf(n.then, out);
      if (n.else !== null) includesOf(n.else, out);
    }
  }
  return out;
}

/** For each parsed template, whether it may be rendered once and reused. */
export function analyzeCacheable(templates) {
  const forNames = new Set();
  for (const nodes of templates.values()) collectForNames(nodes, forNames);
  if (['site', 'tags', 'recent'].some((n) => forNames.has(n))) {
    return new Map([...templates.keys()].map((name) => [name, false]));
  }
  const cacheable = new Map([...templates.keys()].map((name) => [name, true]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, nodes] of templates) {
      if (!cacheable.get(name)) continue;
      if (!nodesAreClean(nodes, [])) {
        cacheable.set(name, false);
        changed = true;
        continue;
      }
      for (const inc of includesOf(nodes)) {
        if (templates.has(inc) && !cacheable.get(inc)) {
          cacheable.set(name, false);
          changed = true;
          break;
        }
      }
    }
  }
  return cacheable;
}

// ---------------------------------------------------------------- the pipeline

/** `rel` (a link's path, "/"-separated) from the directory parts `dirParts`, or null when it climbs out of the root. */
function resolvePathParts(dirParts, rel) {
  const parts = dirParts.slice();
  let i = 0;
  const n = rel.length;
  while (i <= n) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = n;
    const seg = rel.slice(i, j);
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (seg !== '' && seg !== '.') parts.push(seg);
    i = j + 1;
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, b.slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePathParts(dirParts, rel);
        if (path !== null) {
          const page = b.bySource.get(path);
          if (page !== undefined) return `${page.url}${frag}`;
          if (staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        }
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, b.slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    return (s.data.tags ?? []).filter((name) => !seen.has(slugify(name, b.slugCache)) && seen.add(slugify(name, b.slugCache)));
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, b.slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, b.slugCache)) ?? { name, slug: slugify(name, b.slugCache), url: '', posts: [] });
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it (`card` is its card, already built for a post). */
function pageOf(s, card) {
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const ctx = { templates: b.templates, escape: escapeHtml, cacheable: b.cacheable, renderCache: new Map(), rootVars: { site, tags: allTags, recent } };
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, [{ site, tags: allTags, recent, ...vars }], ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) {
    const card = s.post ? b.cards.get(s) : cardOf(s);
    b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, card) });
  }
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** The plugins, in the order a build runs them. */
export const PIPELINE = Object.freeze([readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report]);

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Root variables no for anywhere in the case binds read the root vars directly.
  const forNames = new Set();
  for (const nodes of templates.values()) collectForNames(nodes, forNames);
  const rootOnly = new Set(['site', 'tags', 'recent', 'page', 'posts', 'pager', 'tag'].filter((n) => !forNames.has(n)));
  for (const nodes of templates.values()) markRootOnly(nodes, rootOnly);
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    cacheable: analyzeCacheable(templates),
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugCache: new Map(),
  };
  for (const plugin of PIPELINE) plugin(b);
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
