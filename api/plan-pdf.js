// Turns an agent plan (markdown) into a branded, printable PDF. Same auth shape as
// watermark.js: the caller sends the signed-in user's Supabase token, we verify it with
// auth.getUser and answer 401 to anything else. No service-role key here either — this
// function reads nothing from the database, it only needs to know the caller is a user.
//
// pdfkit is pure JS and its standard fonts ship as modules, so the whole thing fits a
// Hobby lambda with room to spare. No browser, no chromium.
import { createClient } from '@supabase/supabase-js';
import PDFDocument from 'pdfkit';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const config = { maxDuration: 60 };

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://uapiytquwuhtewqieegx.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVhcGl5dHF1d3VodGV3cWllZWd4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM2NzcwMTksImV4cCI6MjA4OTI1MzAxOX0.BLs2RdStghm0_cF8t70cBTX1GWcowGRwID7TAG8Mg38';

const MAX_CHARS = 60000;
const MAX_TITLE = 200;
const MAX_NAME = 120;

const MARK_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'aiad-mark.png');

// Print palette. Dark on white — this is going to a printer, not a screen.
const INK = '#111111';
const MUTED = '#666666';
const RULE = '#D9D9D9';
const PLATE = '#0A0A0A';

const PAGE = { size: 'LETTER', margin: 64 };

function send(res, status, body) {
    res.status(status).setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
}

export function slugify(title) {
    const s = String(title || '')
        .toLowerCase()
        .normalize('NFKD').replace(/[\u0300-\u036F]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
        .replace(/-+$/g, '');
    return s || 'aiad-plan';
}

// pdfkit's built-in Helvetica is WinAnsi: Latin-1 plus a handful of typographic extras.
// Anything outside that renders as a blank box, and agents are fond of emoji, so strip
// what the font cannot draw rather than print rubbish. Arrows get a text stand-in
// because they carry meaning in a plan ("A -> B"); the rest just goes.
const WINANSI_EXTRA = '\u2013\u2014\u2018\u2019\u201A\u201C\u201D\u201E\u2020\u2021\u2022\u2026\u2030\u2039\u203A\u20AC\u2122\u0160\u0161\u017D\u017E\u0152\u0153\u0178\u0192\u02C6\u02DC';
export function sanitize(text) {
    let out = '';
    const s = String(text == null ? '' : text)
        .replace(/[\u2192\u27A1\u2794\u279C\u21D2]/g, '->')
        .replace(/[\u2713\u2714\u2705]/g, '')
        .replace(/[\u2610\u2611\u2612]/g, '');
    for (const ch of s) {
        const c = ch.codePointAt(0);
        if (c === 0x09 || c === 0x0A || (c >= 0x20 && c <= 0x7E) || (c >= 0xA0 && c <= 0xFF) || WINANSI_EXTRA.indexOf(ch) !== -1) {
            out += ch;
        }
        // everything else (emoji, symbols, joiners) is dropped
    }
    // Collapse the gaps dropped glyphs leave behind, but never leading indentation —
    // that is how a nested list item says it is nested.
    return out.replace(/(\S)[ \t]{2,}/g, '$1 ');
}

// ---- markdown -> blocks ----
// Mirrors the shape the client renderer understands (headings, lists, rules, bold,
// paragraphs). Anything else is reduced to its text rather than printed as syntax:
// links keep their label, code fences and inline code become plain text, blockquotes
// lose the ">", table rows lose their pipes, images vanish.
export function parseMarkdown(src) {
    const lines = sanitize(src).replace(/\r\n?/g, '\n').split('\n');
    const blocks = [];
    let para = [];
    let list = null;
    let inFence = false;

    function closePara() {
        if (!para.length) return;
        blocks.push({ type: 'p', text: para.join(' ') });
        para = [];
    }
    function closeList() {
        if (!list) return;
        blocks.push(list);
        list = null;
    }
    function flush() { closeList(); closePara(); }

    for (let i = 0; i < lines.length; i++) {
        let t = lines[i];

        if (/^\s*(```|~~~)/.test(t)) { flush(); inFence = !inFence; continue; }
        if (inFence) { para.push(t.trim()); continue; }

        t = t.replace(/\s+$/, '');
        const trimmed = t.trim();
        if (!trimmed) { flush(); continue; }

        if (/^([-*_])\1{2,}$/.test(trimmed.replace(/\s+/g, ''))) { flush(); blocks.push({ type: 'hr' }); continue; }

        const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(trimmed);
        if (h) { flush(); blocks.push({ type: 'h', level: Math.min(h[1].length, 3), text: h[2] }); continue; }

        // Tables: a separator row is dropped, a data row becomes one line of cells.
        if (/^\|/.test(trimmed) || /\|.*\|/.test(trimmed)) {
            if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(trimmed)) continue;
            const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); }).filter(Boolean);
            if (cells.length) { flush(); blocks.push({ type: 'p', text: cells.join('  \u2014  '), tight: true }); }
            continue;
        }

        const quote = /^>\s?(.*)$/.exec(trimmed);
        if (quote) { closeList(); para.push(quote[1]); continue; }

        const indent = /^(\s*)/.exec(t)[1].length;
        // A nested item joins whatever list is open, whichever marker it uses; only a
        // top-level item of the other kind starts a new list.
        const ul = /^\s*[-*+]\s+(.*)$/.exec(t);
        const ol = /^\s*(\d+)[.)]\s+(.*)$/.exec(t);
        if (ul || ol) {
            closePara();
            const tag = ul ? 'ul' : 'ol';
            const depth = indent >= 2 ? 1 : 0;
            if (!list || (depth === 0 && list.tag !== tag)) { closeList(); list = { type: 'list', tag: tag, items: [] }; }
            list.items.push({ text: ul ? ul[1] : ol[2], depth: depth, tag: tag });
            continue;
        }

        // A wrapped continuation of the previous list item, when it is indented.
        if (list && indent >= 2) {
            const last = list.items[list.items.length - 1];
            last.text += ' ' + trimmed;
            continue;
        }

        closeList();
        para.push(trimmed);
    }
    flush();
    return blocks;
}

// Inline: **bold**, *em* / _em_, `code` (as plain), [label](url) -> label, ![alt](src) -> gone.
export function inlineRuns(text) {
    let s = String(text || '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/`([^`]+)`/g, '$1');
    const runs = [];
    const re = /(\*\*([^*]+)\*\*|__([^_]+)__|(^|[^*\w])\*([^*\n]+)\*(?![*\w])|(^|[^_\w])_([^_\n]+)_(?![_\w]))/g;
    let last = 0, m;
    while ((m = re.exec(s)) !== null) {
        let start = m.index;
        let plainBefore = '';
        if (m[2] != null) {
            runs.push({ text: s.slice(last, start) }); runs.push({ text: m[2], bold: true });
        } else if (m[3] != null) {
            runs.push({ text: s.slice(last, start) }); runs.push({ text: m[3], bold: true });
        } else if (m[5] != null) {
            plainBefore = m[4] || '';
            runs.push({ text: s.slice(last, start) + plainBefore }); runs.push({ text: m[5], italic: true });
        } else if (m[7] != null) {
            plainBefore = m[6] || '';
            runs.push({ text: s.slice(last, start) + plainBefore }); runs.push({ text: m[7], italic: true });
        }
        last = start + m[0].length;
    }
    runs.push({ text: s.slice(last) });
    // Leftover single asterisks that did not pair are syntax, not content.
    return runs.filter(function (r) { return r.text.length; }).map(function (r) {
        return r.bold || r.italic ? r : { text: r.text.replace(/(^|\s)[*_]+(\s|$)/g, '$1$2') };
    }).filter(function (r) { return r.text.length; });
}

function fontFor(run, base) {
    if (base === 'bold') return run.italic ? 'Helvetica-BoldOblique' : 'Helvetica-Bold';
    if (run.bold && run.italic) return 'Helvetica-BoldOblique';
    if (run.bold) return 'Helvetica-Bold';
    if (run.italic) return 'Helvetica-Oblique';
    return 'Helvetica';
}

// Writes inline runs as one flowing paragraph starting at (x, doc.y) within `width`.
function writeRuns(doc, runs, x, width, opts) {
    const o = opts || {};
    if (!runs.length) runs = [{ text: '' }];
    for (let i = 0; i < runs.length; i++) {
        doc.font(fontFor(runs[i], o.base)).fontSize(o.size || 10.5).fillColor(o.color || INK);
        const params = { width: width, lineGap: o.lineGap == null ? 2.5 : o.lineGap, continued: i < runs.length - 1, align: 'left' };
        if (i === 0) doc.text(runs[i].text, x, doc.y, params);
        else doc.text(runs[i].text, params);
    }
}

function ensureRoom(doc, needed) {
    const bottom = doc.page.height - doc.page.margins.bottom;
    if (doc.y + needed > bottom) doc.addPage();
}

export async function renderPdf({ title, markdown, artistName }) {
    const doc = new PDFDocument({
        size: PAGE.size,
        margin: PAGE.margin,
        bufferPages: true,
        info: { Title: title, Author: artistName || 'AIAD', Creator: 'AIAD', Producer: 'AIAD' }
    });
    const chunks = [];
    doc.on('data', function (c) { chunks.push(c); });
    const done = new Promise(function (resolve, reject) {
        doc.on('end', function () { resolve(Buffer.concat(chunks)); });
        doc.on('error', reject);
    });

    const left = doc.page.margins.left;
    const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // ---- page 1 header: mark, title, byline ----
    // The mark is a white wordmark with a transparent ground, drawn for the dark UI. On
    // paper it would disappear, so it sits on a small dark plate — the asset is untouched
    // and everything else on the page stays dark-on-white.
    let markBuf = null;
    try { markBuf = await readFile(MARK_PATH); } catch (e) { markBuf = null; }
    const markW = 112, markH = Math.round(markW * 143 / 640);
    const plateW = markW + 20, plateH = markH + 14;
    if (markBuf) {
        doc.save();
        doc.roundedRect(left, PAGE.margin, plateW, plateH, 6).fill(PLATE);
        doc.image(markBuf, left + 10, PAGE.margin + 7, { width: markW });
        doc.restore();
    }
    doc.y = PAGE.margin + plateH + 22;

    doc.font('Helvetica-Bold').fontSize(22).fillColor(INK)
       .text(title, left, doc.y, { width: contentWidth, lineGap: 2 });
    doc.moveDown(0.35);

    const when = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const byline = (artistName ? artistName + '  \u00B7  ' : '') + 'Generated ' + when + '  \u00B7  aiad.studio';
    doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text(byline, left, doc.y, { width: contentWidth });
    doc.moveDown(0.8);
    doc.moveTo(left, doc.y).lineTo(left + contentWidth, doc.y).lineWidth(0.75).strokeColor(RULE).stroke();
    doc.moveDown(1.2);

    // ---- body ----
    const blocks = parseMarkdown(markdown);
    // The client titles the export from the plan's own first heading, so the same line
    // would otherwise print twice in a row.
    if (blocks.length && blocks[0].type === 'h' && blocks[0].level === 1
        && inlineRuns(blocks[0].text).map(function (r) { return r.text; }).join('').trim().toLowerCase() === title.trim().toLowerCase()) {
        blocks.shift();
    }
    for (let b = 0; b < blocks.length; b++) {
        const blk = blocks[b];
        if (blk.type === 'h') {
            const size = blk.level === 1 ? 16 : blk.level === 2 ? 13.5 : 11.5;
            ensureRoom(doc, size * 3.2);
            doc.moveDown(blk.level === 1 ? 0.9 : 0.6);
            writeRuns(doc, inlineRuns(blk.text), left, contentWidth, { base: 'bold', size: size, lineGap: 1.5 });
            doc.moveDown(0.35);
        } else if (blk.type === 'hr') {
            ensureRoom(doc, 24);
            doc.moveDown(0.5);
            doc.moveTo(left, doc.y).lineTo(left + contentWidth, doc.y).lineWidth(0.6).strokeColor(RULE).stroke();
            doc.moveDown(0.9);
        } else if (blk.type === 'p') {
            ensureRoom(doc, 30);
            writeRuns(doc, inlineRuns(blk.text), left, contentWidth, { size: 10.5 });
            doc.moveDown(blk.tight ? 0.2 : 0.7);
        } else if (blk.type === 'list') {
            let n = 0;
            for (let i = 0; i < blk.items.length; i++) {
                const it = blk.items[i];
                const depth = it.depth || 0;
                const indent = 6 + depth * 18;
                const gutter = blk.tag === 'ol' ? 20 : 14;
                if (depth === 0 && it.tag === 'ol') n++;
                ensureRoom(doc, 28);
                const y = doc.y;
                const label = depth ? '\u2013' : (it.tag === 'ol' ? (n + '.') : '\u2022');
                doc.font('Helvetica').fontSize(10.5).fillColor(INK)
                   .text(label, left + indent, y, { width: gutter, lineBreak: false });
                doc.y = y;
                writeRuns(doc, inlineRuns(it.text), left + indent + gutter, contentWidth - indent - gutter, { size: 10.5 });
                doc.moveDown(0.25);
            }
            doc.moveDown(0.5);
        }
    }

    // ---- footer on every page ----
    const range = doc.bufferedPageRange();
    for (let p = range.start; p < range.start + range.count; p++) {
        doc.switchToPage(p);
        // Writing at the foot of the page must not trigger another page break.
        const savedBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        const fy = doc.page.height - 40;
        doc.moveTo(left, fy - 8).lineTo(left + contentWidth, fy - 8).lineWidth(0.5).strokeColor(RULE).stroke();
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
        doc.text('AIAD  \u00B7  ' + title, left, fy, { width: contentWidth - 80, lineBreak: false, ellipsis: true });
        doc.text('Page ' + (p - range.start + 1) + ' of ' + range.count, left + contentWidth - 80, fy, { width: 80, align: 'right', lineBreak: false });
        doc.page.margins.bottom = savedBottom;
    }

    doc.end();
    return done;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });

    // ---- auth: the user's token, verified, or nothing ----
    const auth = req.headers.authorization || req.headers.Authorization || '';
    const token = /^Bearer\s+(.+)$/i.test(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
    if (!token) return send(res, 401, { error: 'unauthorized' });

    const supa = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: 'Bearer ' + token } }
    });

    let user = null;
    try {
        const got = await supa.auth.getUser(token);
        user = got && got.data && got.data.user;
        if (got && got.error) user = null;
    } catch (e) { user = null; }
    if (!user || !user.id) return send(res, 401, { error: 'unauthorized' });

    // ---- input ----
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    if (!body || typeof body !== 'object') return send(res, 400, { error: 'bad_request' });

    const markdown = typeof body.markdown === 'string' ? body.markdown : '';
    if (!markdown.trim()) return send(res, 400, { error: 'bad_request' });
    if (markdown.length > MAX_CHARS) return send(res, 413, { error: 'too_large', max: MAX_CHARS });

    const title = sanitize(String(body.title || '')).replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || 'AIAD Plan';
    const artistName = sanitize(String(body.artistName || '')).replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);

    try {
        const pdf = await renderPdf({ title, markdown, artistName });
        res.status(200);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="' + slugify(title) + '.pdf"');
        res.setHeader('Content-Length', String(pdf.length));
        res.setHeader('Cache-Control', 'no-store');
        res.end(pdf);
    } catch (e) {
        console.warn('[plan-pdf] ' + (e && e.message));
        return send(res, 500, { error: 'render_failed' });
    }
}
