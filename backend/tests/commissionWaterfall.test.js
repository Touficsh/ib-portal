/**
 * Commission waterfall math — locks in the contract that:
 *   - Each ancestor earns the DIFFERENCE between their rate and the child's
 *   - With CRM levels: commission_amount = brokerComm × (my.pct − child.pct) / 100
 *                     rebate_amount     = lots × (my.per_lot − child.per_lot)
 *   - Cascade violations clamp at 0 (parent never earns negative)
 *   - Without CRM levels: legacy bucket-fill math
 *
 * Run: node --test tests/commissionWaterfall.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeWaterfallRows } from '../src/services/commissionEngine.js';

// Build a tiny `db` stub that pretends to be `pg` for the function under test.
// Each call to `db.query(sql, params)` is matched against the registered
// fixtures by a sql substring — clear and trivially debuggable.
function mockDb(fixtures) {
  return {
    async query(sql, params) {
      for (const [needle, response] of fixtures) {
        if (sql.includes(needle)) {
          if (typeof response === 'function') return response(params);
          return response;
        }
      }
      throw new Error(`unmocked query: ${sql.slice(0, 80)}…`);
    },
  };
}

test('NEW MATH — single ancestor earns full pct + per_lot of one deal', async () => {
  const db = mockDb([
    ['FROM clients WHERE id', { rows: [{ agent_id: 'agent-1' }] }],
    ['FROM products WHERE id', { rows: [{ commission_per_lot: 0, rebate_per_lot: 0 }] }],
    ['WITH RECURSIVE ancestors', { rows: [
      { agent_id: 'agent-1', level: 0,
        rate_per_lot: 0,
        ccl_pct: 100, ccl_per_lot: 5,
        ov_pct: null, ov_per_lot: null },
    ]}],
  ]);

  const rows = await computeWaterfallRows(db, {
    deal_id: 1, client_id: 'c-1', mt5_login: '123', product_id: 'p-1',
    lots: 2, deal_time: new Date().toISOString(),
    mt5_commission: 20,        // |broker comm| = $20 for the deal
  });

  assert.equal(rows.length, 1, 'one ancestor → one commission row');
  const r = rows[0];
  // 100% × $20 + ($5/lot × 2 lots) = $20 + $10 = $30
  assert.equal(r.commission_amount, 20, 'commission portion is full broker comm');
  assert.equal(r.rebate_amount, 10, 'rebate portion is 2 lots × $5');
  assert.equal(r.amount, 30, 'total amount = commission + rebate');
  assert.equal(r.rate_source, 'crm', 'no override → rate_source = crm');
});

test('NEW MATH — parent override semantics: parent earns delta over child', async () => {
  // Sub: 50% + $3/lot.   Parent: 100% + $10/lot.
  // Sub earns:    50% × $20 + $3 × 2 = $10 + $6 = $16
  // Parent earns: (100−50)% × $20 + ($10−$3) × 2 = $10 + $14 = $24
  const db = mockDb([
    ['FROM clients WHERE id', { rows: [{ agent_id: 'sub' }] }],
    ['FROM products WHERE id', { rows: [{ commission_per_lot: 0, rebate_per_lot: 0 }] }],
    ['WITH RECURSIVE ancestors', { rows: [
      { agent_id: 'sub',    level: 0, rate_per_lot: 0,
        ccl_pct: 50,  ccl_per_lot: 3, ov_pct: null, ov_per_lot: null },
      { agent_id: 'parent', level: 1, rate_per_lot: 0,
        ccl_pct: 100, ccl_per_lot: 10, ov_pct: null, ov_per_lot: null },
    ]}],
  ]);

  const rows = await computeWaterfallRows(db, {
    deal_id: 2, client_id: 'c-1', mt5_login: '123', product_id: 'p-1',
    lots: 2, deal_time: new Date().toISOString(),
    mt5_commission: 20,
  });

  assert.equal(rows.length, 2);
  const sub = rows.find(r => r.agent_id === 'sub');
  const parent = rows.find(r => r.agent_id === 'parent');

  assert.equal(sub.commission_amount, 10);
  assert.equal(sub.rebate_amount, 6);
  assert.equal(sub.amount, 16);

  assert.equal(parent.commission_amount, 10, 'parent commission = (100-50)% × $20');
  assert.equal(parent.rebate_amount, 14,    'parent rebate = ($10-$3) × 2 lots');
  assert.equal(parent.amount, 24);
});

test('NEW MATH — cascade violation (sub > parent) clamps parent to zero', async () => {
  // Sub: 100% + $5/lot.  Parent (misconfigured): 50% + $3/lot.
  // Parent margin would be negative → must clamp to 0 (parent earns nothing).
  const db = mockDb([
    ['FROM clients WHERE id', { rows: [{ agent_id: 'sub' }] }],
    ['FROM products WHERE id', { rows: [{ commission_per_lot: 0, rebate_per_lot: 0 }] }],
    ['WITH RECURSIVE ancestors', { rows: [
      { agent_id: 'sub',    level: 0, rate_per_lot: 0,
        ccl_pct: 100, ccl_per_lot: 5, ov_pct: null, ov_per_lot: null },
      { agent_id: 'parent', level: 1, rate_per_lot: 0,
        ccl_pct: 50,  ccl_per_lot: 3, ov_pct: null, ov_per_lot: null },
    ]}],
  ]);

  const rows = await computeWaterfallRows(db, {
    deal_id: 3, client_id: 'c-1', mt5_login: '123', product_id: 'p-1',
    lots: 1, deal_time: new Date().toISOString(),
    mt5_commission: 10,
  });

  // Only sub gets a row; parent's amount is 0 and is filtered out.
  assert.equal(rows.length, 1);
  assert.equal(rows[0].agent_id, 'sub');
  assert.equal(rows[0].amount, 15, 'sub: 100% × $10 + $5 × 1 lot');
});

test('NEW MATH — CRM override columns take precedence over synced ccl_*', async () => {
  // ov_pct=80, ov_per_lot=4 → these win over ccl_pct/ccl_per_lot.
  const db = mockDb([
    ['FROM clients WHERE id', { rows: [{ agent_id: 'agent-1' }] }],
    ['FROM products WHERE id', { rows: [{ commission_per_lot: 0, rebate_per_lot: 0 }] }],
    ['WITH RECURSIVE ancestors', { rows: [
      { agent_id: 'agent-1', level: 0, rate_per_lot: 0,
        ccl_pct: 100, ccl_per_lot: 10,    // ignored
        ov_pct: 80,   ov_per_lot: 4 },     // these win
    ]}],
  ]);

  const rows = await computeWaterfallRows(db, {
    deal_id: 4, client_id: 'c-1', mt5_login: '123', product_id: 'p-1',
    lots: 1, deal_time: new Date().toISOString(),
    mt5_commission: 10,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].commission_amount, 8, '80% × $10');
  assert.equal(rows[0].rebate_amount, 4,     '$4 × 1 lot');
  assert.equal(rows[0].amount, 12);
  assert.equal(rows[0].rate_source, 'crm_override');
});

test('LEGACY MATH — no CRM levels, uses agent_products.rate_per_lot bucket', async () => {
  // No ccl_* set → legacy path: bucket-fill commission first, overflow to rebate.
  // sub_rate=$2/lot, parent_rate=$5/lot. Parent earns ($5−$2)=$3/lot margin.
  const db = mockDb([
    ['FROM clients WHERE id', { rows: [{ agent_id: 'sub' }] }],
    ['FROM products WHERE id', { rows: [{ commission_per_lot: 0, rebate_per_lot: 0 }] }],
    ['WITH RECURSIVE ancestors', { rows: [
      { agent_id: 'sub',    level: 0, rate_per_lot: 2,
        ccl_pct: null, ccl_per_lot: null, ov_pct: null, ov_per_lot: null },
      { agent_id: 'parent', level: 1, rate_per_lot: 5,
        ccl_pct: null, ccl_per_lot: null, ov_pct: null, ov_per_lot: null },
    ]}],
  ]);

  const rows = await computeWaterfallRows(db, {
    deal_id: 5, client_id: 'c-1', mt5_login: '123', product_id: 'p-1',
    lots: 2, deal_time: new Date().toISOString(),
    mt5_commission: 20,
  });

  assert.equal(rows.length, 2);
  const sub = rows.find(r => r.agent_id === 'sub');
  const parent = rows.find(r => r.agent_id === 'parent');
  assert.equal(sub.amount,    4, 'sub: 2 lots × $2 = $4');
  assert.equal(parent.amount, 6, 'parent: 2 lots × ($5-$2) = $6');
  // Both rows tagged as legacy
  assert.equal(sub.rate_source, 'legacy');
  assert.equal(parent.rate_source, 'legacy');
});
