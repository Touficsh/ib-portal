/**
 * Portal — PDF Commission Statements — /api/portal/statements
 *
 * Streams a printable PDF of the current agent's commission ledger for a
 * given date range. Generated on-demand with pdfkit; no file is persisted.
 *
 * Endpoint:
 *   GET /api/portal/statements/commissions.pdf?from=<ISO>&to=<ISO>&product_id=<uuid>
 *
 * Response: application/pdf, Content-Disposition: attachment
 *
 * Output layout:
 *   Header         — "Commission Statement", agent name + email, date range
 *   Summary block  — total deals, total lots, total commission
 *   By-product     — one row per product
 *   Ledger         — chronological table (deal_time / product / lots / rate / level / amount)
 *
 * For now this is agent-scoped only (uses req.user.id as agent_id). An admin
 * version (`?agent_id=`) can be added later under /api/commissions/statement.pdf.
 */
import { Router } from 'express';
import PDFDocument from 'pdfkit';
import pool from '../../db/pool.js';
import { portalAuthenticate, requireAgentAccess, requirePortalPermission } from '../../middleware/portalAuth.js';

const router = Router();
// Statement download piggybacks on the same permission as the Commissions tab —
// if you can't view your commissions in the UI, you can't download them as PDF either.
router.use(
  portalAuthenticate,
  requireAgentAccess,
  requirePortalPermission('portal.commissions.view')
);

function parseDate(v, fallback) {
  if (!v) return fallback;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

function fmtMoney(n, currency = 'USD') {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(n));
}

function fmtDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

// GET /api/portal/statements/commissions.pdf
router.get('/commissions.pdf', async (req, res, next) => {
  try {
    const now = new Date();
    const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    const from = parseDate(req.query.from, defaultFrom);
    const to = parseDate(req.query.to, now);
    const productId = req.query.product_id || null;

    // Resolve user profile for the header
    const { rows: [me] } = await pool.query(
      `SELECT name, email FROM users WHERE id = $1`,
      [req.user.id]
    );

    // Fetch all ledger rows in range (cap at 5000 to avoid runaway PDFs)
    const where = ['c.agent_id = $1', 'c.deal_time >= $2', 'c.deal_time < $3'];
    const params = [req.user.id, from.toISOString(), to.toISOString()];
    if (productId) { where.push(`c.product_id = $${params.length + 1}`); params.push(productId); }

    const { rows: items } = await pool.query(
      `SELECT c.deal_id, c.deal_time, c.mt5_login, c.product_id, p.name AS product_name,
              p.currency, c.lots, c.rate_per_lot, c.amount, c.level
       FROM commissions c
       JOIN products p ON p.id = c.product_id
       WHERE ${where.join(' AND ')}
       ORDER BY c.deal_time ASC, c.deal_id ASC
       LIMIT 5000`,
      params
    );

    // Rollup by product
    const byProduct = new Map();
    let totalLots = 0, totalAmount = 0;
    for (const r of items) {
      const cur = byProduct.get(r.product_id) || {
        name: r.product_name, currency: r.currency, deals: 0, lots: 0, amount: 0,
      };
      cur.deals += 1;
      cur.lots += Number(r.lots);
      cur.amount += Number(r.amount);
      byProduct.set(r.product_id, cur);
      totalLots += Number(r.lots);
      totalAmount += Number(r.amount);
    }

    // ── Build the PDF ──
    const filename = `commission-statement-${fmtDate(from)}_to_${fmtDate(to)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    doc.pipe(res);

    // Header
    doc.fontSize(18).fillColor('#1e293b').text('Commission Statement', { align: 'left' });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#64748b')
       .text(`${me?.name || '—'}  ·  ${me?.email || ''}`);
    doc.text(`Period: ${fmtDate(from)} → ${fmtDate(to)}`);
    doc.text(`Generated: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);

    // Summary block
    doc.moveDown(1);
    doc.fontSize(12).fillColor('#0f172a').text('Summary', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor('#0f172a');
    const summaryRows = [
      ['Total deals',       String(items.length)],
      ['Total lots',        totalLots.toFixed(2)],
      ['Total commission',  fmtMoney(totalAmount)],
    ];
    for (const [k, v] of summaryRows) {
      doc.text(`${k}:`, { continued: true, width: 160 });
      doc.fillColor('#1e293b').text(`  ${v}`).fillColor('#0f172a');
    }

    // By product
    if (byProduct.size > 0) {
      doc.moveDown(1);
      doc.fontSize(12).fillColor('#0f172a').text('By product', { underline: true });
      doc.moveDown(0.3);
      doc.fontSize(10);
      const headerY = doc.y;
      doc.fillColor('#64748b')
         .text('Product', 50, headerY, { width: 200 })
         .text('Deals',   260, headerY, { width: 60, align: 'right' })
         .text('Lots',    320, headerY, { width: 80, align: 'right' })
         .text('Total',   400, headerY, { width: 140, align: 'right' });
      doc.moveTo(50, doc.y + 2).lineTo(540, doc.y + 2).strokeColor('#e2e8f0').stroke();
      doc.moveDown(0.3);
      for (const [, row] of byProduct) {
        const y = doc.y;
        doc.fillColor('#0f172a')
           .text(row.name, 50, y, { width: 200 })
           .text(String(row.deals), 260, y, { width: 60, align: 'right' })
           .text(row.lots.toFixed(2), 320, y, { width: 80, align: 'right' })
           .text(fmtMoney(row.amount, row.currency), 400, y, { width: 140, align: 'right' });
        doc.moveDown(0.3);
      }
    }

    // Ledger table
    doc.moveDown(1);
    doc.fontSize(12).fillColor('#0f172a').text('Ledger', { underline: true });
    doc.moveDown(0.3);
    doc.fontSize(9);

    function drawLedgerHeader() {
      const y = doc.y;
      doc.fillColor('#64748b')
         .text('Date',     50,  y, { width: 80 })
         .text('Deal',     130, y, { width: 70 })
         .text('Product',  200, y, { width: 130 })
         .text('Lots',     330, y, { width: 50, align: 'right' })
         .text('Rate',     380, y, { width: 50, align: 'right' })
         .text('Lv',       430, y, { width: 25, align: 'right' })
         .text('Amount',   455, y, { width: 85, align: 'right' });
      doc.moveTo(50, doc.y + 2).lineTo(540, doc.y + 2).strokeColor('#e2e8f0').stroke();
      doc.moveDown(0.3);
    }
    drawLedgerHeader();

    for (const r of items) {
      // Page break if near bottom
      if (doc.y > 760) {
        doc.addPage();
        drawLedgerHeader();
      }
      const y = doc.y;
      doc.fillColor('#0f172a')
         .text(new Date(r.deal_time).toISOString().slice(0, 10), 50,  y, { width: 80 })
         .text(String(r.deal_id),                                 130, y, { width: 70 })
         .text(r.product_name || '—',                             200, y, { width: 130 })
         .text(Number(r.lots).toFixed(2),                         330, y, { width: 50, align: 'right' })
         .text(Number(r.rate_per_lot).toFixed(2),                 380, y, { width: 50, align: 'right' })
         .text(String(r.level),                                   430, y, { width: 25, align: 'right' })
         .text(fmtMoney(r.amount, r.currency),                    455, y, { width: 85, align: 'right' });
      doc.moveDown(0.25);
    }

    if (items.length === 0) {
      doc.fillColor('#64748b').text('No commissions in this period.', { align: 'center' });
    }

    // Footer with page numbers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(i);
      doc.fillColor('#9ca3af').fontSize(8)
         .text(`Page ${i + 1} of ${range.count}`, 50, 810, { width: 490, align: 'center' });
    }

    doc.end();
  } catch (err) {
    if (!res.headersSent) next(err);
    else res.end();
  }
});

export default router;
