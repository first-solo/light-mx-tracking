'use strict';

// AD 79-12-08 compliance report: a letter-size PDF of every sign-off in a date
// range, with signatures, meant to be printed and kept with the aircraft records.

const PDFDocument = require('pdfkit');

const PNG_PREFIX = 'data:image/png;base64,';
const INK = '#14202a';
const MUTED = '#5d6a6f';
const RULE = '#c9d1d4';
const SHADE = '#f1f4f5';
const ALERT = '#9b2c22';

const M = 40;                      // page margin
const PAGE_W = 612, PAGE_H = 792;  // US letter, points
const W = PAGE_W - M * 2;

// Table columns, widths in points (sum = W).
const COLS = [
  { key: 'date', label: 'Date', w: 54 },
  { key: 'time', label: 'Time', w: 34 },
  { key: 'for', label: 'For', w: 58 },
  { key: 'exposed', label: 'Below\nfreezing', w: 46 },
  { key: 'left', label: 'Left valve', w: 62 },
  { key: 'right', label: 'Right valve', w: 62 },
  { key: 'name', label: 'Printed name / remarks', w: 114 },
  { key: 'sig', label: 'Signature', w: 102 },
];

const fmtDate = (s) => { const [y, m, d] = s.split('-'); return `${m}/${d}/${y}`; };
const longDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
};
const trigger = { first_flight: 'First flight', after_refuel: 'After refuel' };
const valve = (v) => (v === 'water_drained' ? 'Water found, drained' : 'No water');

function buildAdReport({ aircraft, from, to, rows, removedCount }, out) {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: M, bottom: M, left: M, right: M },
    bufferPages: true,
    info: {
      Title: `${aircraft.tail} AD 79-12-08 compliance record ${from} to ${to}`,
      Subject: 'AD 79-12-08 fuel selector valve water check sign-offs',
      Creator: 'light-mx-tracking',
    },
  });
  doc.pipe(out);

  const generated = new Date().toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
  });

  // ---------- header (every page) ----------
  function header(first) {
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(first ? 16 : 11)
      .text(`${aircraft.tail}${aircraft.model ? '  ·  ' + aircraft.model : ''}`, M, M, { width: W, continued: false });
    doc.font('Helvetica-Bold').fontSize(first ? 12 : 9)
      .text('AD 79-12-08 Compliance Record', { width: W });
    if (first) {
      doc.moveDown(0.2).font('Helvetica').fontSize(9).fillColor(MUTED)
        .text('Fuel selector valve water-contamination check per Piper Service Letter 851, Part B. Required before the first flight of each day and after each refueling once the airplane has been exposed to below-freezing temperatures.', { width: W });
      doc.moveDown(0.4);
    }
    doc.font('Helvetica').fontSize(9).fillColor(INK)
      .text(`Period: ${longDate(from)} through ${longDate(to)}`, { width: W });
    const y = doc.y + 6;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(1).strokeColor(INK).stroke();
    doc.y = y + 8;
  }

  // ---------- summary ----------
  function summary() {
    const performed = rows.filter((r) => r.exposed).length;
    const water = rows.filter((r) => r.left_result === 'water_drained' || r.right_result === 'water_drained');
    const firstDays = new Set(rows.filter((r) => r.trigger === 'first_flight').map((r) => r.date)).size;
    const items = [
      ['Sign-offs', String(rows.length)],
      ['Checks performed', String(performed)],
      ['Not required (no freezing exposure)', String(rows.length - performed)],
      ['Days with a first-flight sign-off', String(firstDays)],
      ['Sign-offs with water found', String(water.length)],
    ];
    const colW = W / items.length;
    const top = doc.y;
    items.forEach(([k, v], i) => {
      const x = M + i * colW;
      doc.font('Helvetica-Bold').fontSize(14).fillColor(i === 4 && water.length ? ALERT : INK).text(v, x, top, { width: colW - 8 });
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(k, x, top + 18, { width: colW - 8 });
    });
    doc.y = top + 42;
  }

  // ---------- table ----------
  function tableHead() {
    const top = doc.y;
    doc.rect(M, top, W, 22).fill(SHADE);
    let x = M;
    doc.font('Helvetica-Bold').fontSize(7).fillColor(MUTED);
    for (const c of COLS) {
      doc.text(c.label.toUpperCase(), x + 4, top + (c.label.includes('\n') ? 3 : 8), { width: c.w - 8, lineGap: -1 });
      x += c.w;
    }
    doc.y = top + 22;
  }

  function cellText(r) {
    return {
      date: fmtDate(r.date),
      time: r.time || '—',
      for: trigger[r.trigger],
      exposed: r.exposed ? 'Yes' : 'No',
      left: r.exposed ? valve(r.left_result) : 'Not required',
      right: r.exposed ? valve(r.right_result) : 'Not required',
    };
  }

  function rowHeight(r) {
    doc.font('Helvetica').fontSize(8);
    const nameW = COLS.find((c) => c.key === 'name').w - 8;
    let h = doc.heightOfString(r.performed_by, { width: nameW });
    if (r.note) { doc.fontSize(7.5); h += 2 + doc.heightOfString(r.note, { width: nameW }); }
    const t = cellText(r);
    doc.fontSize(8);
    for (const c of COLS.slice(0, 6)) h = Math.max(h, doc.heightOfString(t[c.key], { width: c.w - 8 }));
    return Math.max(h + 10, r.signature ? 32 : 22);
  }

  function row(r) {
    const h = rowHeight(r);
    if (doc.y + h > PAGE_H - M - 24) { doc.addPage(); header(false); tableHead(); }
    const top = doc.y;
    const t = cellText(r);
    let x = M;
    for (const c of COLS) {
      const tx = x + 4, tw = c.w - 8;
      if (c.key === 'name') {
        doc.font('Helvetica').fontSize(8).fillColor(INK).text(r.performed_by, tx, top + 5, { width: tw });
        if (r.note) doc.fontSize(7.5).fillColor(MUTED).text(r.note, tx, doc.y + 2, { width: tw });
      } else if (c.key === 'sig') {
        if (r.signature && r.signature.startsWith(PNG_PREFIX)) {
          try {
            doc.image(Buffer.from(r.signature.slice(PNG_PREFIX.length), 'base64'), tx, top + 3, { fit: [tw, h - 6], align: 'left', valign: 'center' });
          } catch { doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED).text('Signature unreadable', tx, top + 6, { width: tw }); }
        } else {
          doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED).text('Not hand-signed', tx, top + 6, { width: tw });
        }
      } else {
        const water = (c.key === 'left' && r.left_result === 'water_drained') || (c.key === 'right' && r.right_result === 'water_drained');
        doc.font(water ? 'Helvetica-Bold' : 'Helvetica').fontSize(8)
          .fillColor(water ? ALERT : (t[c.key] === 'Not required' ? MUTED : INK))
          .text(t[c.key], tx, top + 5, { width: tw });
      }
      x += c.w;
    }
    doc.moveTo(M, top + h).lineTo(M + W, top + h).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.y = top + h;
  }

  // ---------- certification ----------
  function certification() {
    const need = 120;
    if (doc.y + need > PAGE_H - M - 24) { doc.addPage(); header(false); }
    doc.y += 18;
    doc.font('Helvetica').fontSize(8.5).fillColor(INK).text(
      `I certify that the above is a true copy of the AD 79-12-08 sign-offs recorded for ${aircraft.tail} from ${longDate(from)} through ${longDate(to)}.`,
      M, doc.y, { width: W });
    const y = doc.y + 34;
    const fields = [['Signature', 200], ['Printed name', 140], ['Certificate no.', 100], ['Date', 72]];
    let x = M;
    doc.lineWidth(0.75).strokeColor(INK);
    for (const [label, w] of fields) {
      doc.moveTo(x, y).lineTo(x + w - 12, y).stroke();
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(label, x, y + 4, { width: w - 12 });
      x += w;
    }
    doc.y = y + 20;
  }

  // ---------- compose ----------
  header(true);
  summary();
  if (!rows.length) {
    doc.font('Helvetica').fontSize(10).fillColor(MUTED).text('No AD 79-12-08 sign-offs were recorded in this period.', M, doc.y + 8, { width: W });
  } else {
    tableHead();
    rows.forEach(row);
  }
  if (removedCount) {
    doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED).text(
      `${removedCount} entr${removedCount === 1 ? 'y was' : 'ies were'} removed from the log during this period and ${removedCount === 1 ? 'is' : 'are'} not shown. Removed entries remain in the CSV export with the time they were removed.`,
      M, doc.y + 8, { width: W });
  }
  certification();

  // footer with page numbers
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7).fillColor(MUTED)
      .text(`${aircraft.tail} · AD 79-12-08 · ${fmtDate(from)}–${fmtDate(to)} · Generated ${generated}`, M, PAGE_H - M + 6, { width: W - 80, lineBreak: false });
    doc.text(`Page ${i - range.start + 1} of ${range.count}`, M + W - 80, PAGE_H - M + 6, { width: 80, align: 'right', lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
  doc.end();
}

module.exports = { buildAdReport };
