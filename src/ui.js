'use strict';
/** Terminal output helpers. No dependencies, degrades to plain text. */

const useColor =
  process.env.NO_COLOR === undefined &&
  process.env.POLY_NO_COLOR === undefined &&
  process.stdout.isTTY;

const wrap = (open, close) => s => (useColor ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));

const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  italic: wrap(3, 23),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  grey: wrap(90, 39),
  bgRed: wrap(41, 49),
  bgGreen: wrap(42, 49),
};

// Windows Terminal, VS Code and git-bash all render these. Only the legacy
// cmd.exe console struggles, so this is opt-out rather than opt-in.
const unicode = !process.env.POLY_ASCII;
const sym = {
  ok: unicode ? '✓' : 'OK',
  bad: unicode ? '✗' : 'X',
  warn: unicode ? '!' : '!',
  info: unicode ? '·' : '-',
  arrow: unicode ? '→' : '->',
  bullet: unicode ? '•' : '*',
};

const ok = s => c.green(`${sym.ok} ${s}`);
const bad = s => c.red(`${sym.bad} ${s}`);
const warn = s => c.yellow(`${sym.warn} ${s}`);
const info = s => c.grey(`${sym.info} ${s}`);

/** Visible width, ignoring ANSI escapes. */
function width(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
}

function pad(s, n, align = 'left') {
  const len = width(s);
  if (len >= n) return s;
  const fill = ' '.repeat(n - len);
  return align === 'right' ? fill + s : s + fill;
}

/**
 * Render an aligned table.
 * columns: [{ key, header, align }]
 */
function table(columns, rows, { indent = '  ', gap = 2 } = {}) {
  if (!rows.length) return '';
  const widths = columns.map(col =>
    Math.max(width(col.header || ''), ...rows.map(r => width(r[col.key] ?? '')))
  );
  const sep = ' '.repeat(gap);

  const body = rows.map(r =>
    indent + columns
      .map((col, i) => pad(r[col.key] ?? '', widths[i], col.align))
      .join(sep)
      .replace(/\s+$/, '')
  );

  // A header row of empty strings would just be trailing whitespace.
  const hasHeaders = columns.some(col => (col.header || '').length > 0);
  if (!hasHeaders) return body.join('\n');

  const head = indent + columns
    .map((col, i) => c.grey(c.bold(pad(col.header || '', widths[i], col.align))))
    .join(sep)
    .replace(/\s+$/, '');

  return [head, ...body].join('\n');
}

function heading(text) {
  return '\n' + c.bold(text);
}

function rule(len = 60) {
  return c.grey((unicode ? '─' : '-').repeat(len));
}

function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || one + 's'}`;
}

/** Indent a block of text. */
function indent(text, prefix = '  ') {
  return String(text).split('\n').map(l => (l ? prefix + l : l)).join('\n');
}

module.exports = { c, sym, ok, bad, warn, info, table, heading, rule, relTime, plural, width, pad, indent, useColor };
