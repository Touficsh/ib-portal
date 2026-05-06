import { useMemo, useState, useEffect } from 'react';
import {
  GitBranch, ChevronRight, ChevronDown, Package,
  AlertTriangle, ArrowDown, DollarSign, Trophy, Search,
} from 'lucide-react';
import { useApi } from '../hooks/useApi.js';

/**
 * Portal — Commission Tree (viewer-scoped, read-only)
 *
 * Same waterfall visualization as the admin Commission Tree, but rooted at
 * the authenticated agent and without any editing affordances. For each
 * (agent, product) pair: the rate, the direct sub-agents' rates, and whether
 * the parent earns an override or the sub absorbs the full rate.
 *
 * Data: GET /api/portal/commission-tree  (returns { root_id, roots, earnings })
 */

function money(n) {
  return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function moneyShort(n) {
  const v = Number(n || 0);
  if (v >= 1000) return '$' + (v / 1000).toFixed(1) + 'k';
  return '$' + v.toFixed(0);
}

/**
 * For a given (agent, product), classify each direct sub-agent as absorbed /
 * override / orphan. Same logic as the admin version — CRM-synced config wins
 * over the legacy single-rate model when both are present.
 */
function analyzeProduct(agent, product) {
  const useCrm = product.has_crm_config;
  const parentPct    = useCrm ? (product.effective_pct     || 0) : null;
  const parentRebate = useCrm ? (product.effective_per_lot || 0) : null;
  const parentLegacyRate = Number(product.rate_per_lot || 0);

  const directSubs = (agent.children || []).map(child => {
    const childProduct = (child.products || []).find(cp => cp.product_id === product.product_id);
    if (!childProduct) {
      return { agent_id: child.id, name: child.name, state: 'orphan' };
    }

    if (useCrm && childProduct.has_crm_config) {
      const childPct    = Number(childProduct.effective_pct     || 0);
      const childRebate = Number(childProduct.effective_per_lot || 0);
      const pctMargin    = parentPct    - childPct;
      const rebateMargin = parentRebate - childRebate;
      const broker = Number(product.broker_commission_per_lot || 0);
      const overridePerLot = Math.max(0, pctMargin) / 100 * broker + Math.max(0, rebateMargin);
      const childEffective = Number(childProduct.effective_rate_per_lot || 0);
      const parentEffective = Number(product.effective_rate_per_lot || 0);
      return {
        agent_id: child.id,
        name: child.name,
        pct: childPct,
        rebate: childRebate,
        effective: childEffective,
        overridePct: pctMargin,
        overrideRebate: rebateMargin,
        overridePerLot,
        parentEffective,
        state: overridePerLot > 0 ? 'override' : 'absorbed',
      };
    }

    const childRate = Number(childProduct.rate_per_lot);
    const override = parentLegacyRate - childRate;
    return {
      agent_id: child.id,
      name: child.name,
      rate: childRate,
      override,
      legacy: true,
      state: override > 0 ? 'override' : 'absorbed',
    };
  });

  return {
    subs: directSubs,
    absorbed: directSubs.filter(s => s.state === 'absorbed').length,
    override: directSubs.filter(s => s.state === 'override').length,
    orphan: directSubs.filter(s => s.state === 'orphan').length,
  };
}

function ProductDetail({ product, agent, parentProduct = null, parentExists = false }) {
  const [expanded, setExpanded] = useState(false);
  const { subs, absorbed, override, orphan } = analyzeProduct(agent, product);
  const hasChildren = subs.length > 0;
  const useCrm = product.has_crm_config;

  // Cascade-violation: my rate > parent's rate (or parent doesn't hold this product)
  const myRate = Number(
    product.effective_rate_per_lot != null
      ? product.effective_rate_per_lot
      : (product.rate_per_lot || 0)
  );
  const parentRate = parentProduct
    ? Number(parentProduct.effective_rate_per_lot != null
        ? parentProduct.effective_rate_per_lot
        : (parentProduct.rate_per_lot || 0))
    : null;
  const violatesParent =
    parentExists && myRate > 0 && (parentProduct == null || parentRate < myRate);
  const violationTitle = !violatesParent ? null
    : parentProduct == null
      ? `Parent agent does not hold ${product.name} — sub-agent should not exceed $0/lot`
      : `Sub-agent rate $${money(myRate)}/lot exceeds parent's $${money(parentRate)}/lot — cascade violation`;

  return (
    <div className="ct-product-card">
      <div className="ct-product-head-btn">
        <button
          type="button"
          onClick={() => hasChildren && setExpanded(e => !e)}
          disabled={!hasChildren}
          className="ct-product-expand-btn"
          style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, background: 'transparent', border: 'none', padding: 0, textAlign: 'left', color: 'inherit', cursor: hasChildren ? 'pointer' : 'default' }}
        >
          <Package size={13} className="ct-product-icon" />
          <span className="ct-product-name">{product.name}</span>
        </button>
        {useCrm ? (
          <>
            <span
              className="ct-rate mono"
              title={`CRM: ${product.effective_pct}% commission + $${money(product.effective_per_lot)}/lot rebate\nEffective at broker $${money(product.broker_commission_per_lot)}/lot`}
            >
              {product.effective_pct}% + ${money(product.effective_per_lot)}
            </span>
            <span
              className={`mono small${violatesParent ? ' ct-rate-violates' : ''}`}
              style={violatesParent
                ? { color: 'var(--danger)', fontWeight: 700 }
                : { color: 'var(--success)', fontWeight: 600 }}
              title={violatesParent
                ? violationTitle
                : 'Effective $/lot — pct × broker commission + flat rebate'}
            >
              {violatesParent && '⚠ '}≈ ${money(product.effective_rate_per_lot)}/lot
            </span>
            <span className="pill stage-active" style={{ fontSize: 9, padding: '1px 5px' }} title="Source: synced from xdev CRM">
              CRM
            </span>
          </>
        ) : (
          <>
            <span
              className={`ct-rate mono${violatesParent ? ' ct-rate-violates' : ''}`}
              title={violatesParent ? violationTitle : 'Per-lot rate — no CRM commission level configured for this agent on this product'}
            >
              {violatesParent && '⚠ '}${money(product.rate_per_lot)}/lot
            </span>
            <span className="muted small">max ${money(product.max_rate_per_lot)}</span>
            <span
              className="pill"
              style={{
                fontSize: 9,
                padding: '1px 5px',
                background: 'color-mix(in srgb, var(--warn) 15%, transparent)',
                color: 'var(--warn)',
                border: '1px solid color-mix(in srgb, var(--warn) 35%, transparent)',
                fontWeight: 600,
              }}
              title="No CRM commission_level row exists for this (agent, product). Rate shown is a local default. Configure in xdev CRM to make it authoritative."
            >
              ⚠ No CRM config
            </span>
          </>
        )}
        {hasChildren && (
          <span className="ct-product-summary">
            {override > 0 && (
              <span className="ct-summary-chip ct-chip-override" title="sub-agents passing override up">
                {override}↑
              </span>
            )}
            {absorbed > 0 && (
              <span className="ct-summary-chip ct-chip-absorbed" title="sub-agents taking full rate — no override for this agent">
                {absorbed}=
              </span>
            )}
            {orphan > 0 && (
              <span className="ct-summary-chip ct-chip-orphan" title="sub-agents who don't hold this product — full rate flows up">
                {orphan}·
              </span>
            )}
          </span>
        )}
        {hasChildren && (
          <button
            type="button"
            onClick={() => setExpanded(e => !e)}
            className="ct-rate-btn"
            aria-label={expanded ? 'Collapse' : 'Expand'}
          >
            <ChevronDown
              size={12}
              className="ct-product-chev"
              style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            />
          </button>
        )}
      </div>

      {expanded && subs.length > 0 && (
        <div className="ct-subs">
          <div className="muted small" style={{ marginBottom: 6 }}>
            <ArrowDown size={10} style={{ verticalAlign: -1 }} />
            {' '}Flows to direct sub-agents:
          </div>
          {subs.map(sub => (
            <div key={sub.agent_id} className={`ct-sub-row ct-state-${sub.state}`}>
              <span className="ct-sub-name">{sub.name}</span>
              {sub.state === 'orphan' ? (
                <span className="ct-sub-verdict verdict-neutral">
                  no product — parent earns full {useCrm ? `${product.effective_pct}% + $${money(product.effective_per_lot)}` : `$${money(product.rate_per_lot)}/lot`}
                </span>
              ) : sub.legacy ? (
                <>
                  <span className="ct-sub-rate mono">${money(sub.rate)}/lot</span>
                  {sub.state === 'override' ? (
                    <span className="ct-sub-verdict verdict-good">+${money(sub.override)}/lot override → parent</span>
                  ) : (
                    <span className="ct-sub-verdict verdict-warn">parent earns $0 on their clients</span>
                  )}
                </>
              ) : (
                <>
                  <span className="ct-sub-rate mono" title="Child's CRM config">
                    {sub.pct}% + ${money(sub.rebate)}
                  </span>
                  <span className="mono small muted" title="Child's effective $/lot">
                    ≈${money(sub.effective)}
                  </span>
                  {sub.state === 'override' ? (
                    <span className="ct-sub-verdict verdict-good">
                      parent override: {sub.overridePct > 0 ? `+${sub.overridePct}%` : ''}{sub.overridePct > 0 && sub.overrideRebate > 0 ? ' & ' : ''}{sub.overrideRebate > 0 ? `+$${money(sub.overrideRebate)}/lot` : ''}
                      {' '}(≈ +${money(sub.overridePerLot)}/lot)
                    </span>
                  ) : (
                    <span className="ct-sub-verdict verdict-warn">
                      parent earns $0 override (sub has same rate)
                    </span>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentNode({ node, depth, earningsById, initiallyOpen = false, autoExpand = false, highlight = '', parentProductsById = null }) {
  const [open, setOpen] = useState(initiallyOpen || depth === 0);
  const hasChildren = (node.children || []).length > 0;
  const products = node.products || [];
  const earnings = earningsById.get(node.id);
  const total = earnings?.total_amount || 0;

  const myProductsById = useMemo(
    () => new Map(products.map(p => [p.product_id, p])),
    [products]
  );

  useEffect(() => {
    if (autoExpand) setOpen(true);
  }, [autoExpand]);

  const renderName = () => {
    if (!highlight) return node.name;
    const i = (node.name || '').toLowerCase().indexOf(highlight.toLowerCase());
    if (i === -1) return node.name;
    return (
      <>
        {node.name.slice(0, i)}
        <mark className="ct-highlight">{node.name.slice(i, i + highlight.length)}</mark>
        {node.name.slice(i + highlight.length)}
      </>
    );
  };
  const isDirectMatch = highlight && (node.name || '').toLowerCase().includes(highlight.toLowerCase());

  const sortedChildren = useMemo(() => {
    return [...(node.children || [])].sort((a, b) => {
      const ea = earningsById.get(a.id)?.total_amount || 0;
      const eb = earningsById.get(b.id)?.total_amount || 0;
      return eb - ea;
    });
  }, [node.children, earningsById]);

  return (
    <div className={`ct-node ct-depth-${depth}${isDirectMatch ? ' ct-match' : ''}`}>
      <div className="ct-row">
        <button
          type="button"
          className="ct-chev"
          onClick={() => hasChildren && setOpen(v => !v)}
          disabled={!hasChildren}
          aria-label={hasChildren ? (open ? 'Collapse' : 'Expand') : undefined}
        >
          {hasChildren ? (open ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span style={{ width: 14 }} />}
        </button>
        <div className="ct-agent">
          <div className="ct-agent-head">
            <div className="ct-agent-avatar" aria-hidden>
              {(node.name || '?')[0].toUpperCase()}
            </div>
            <span className="ct-agent-name">{renderName()}</span>
            {node.email && (
              <span className="muted small" style={{ marginLeft: 6 }} title={node.email}>
                {node.email}
              </span>
            )}
            <span className="ct-agent-earnings" title="Total commission earned (all time)">
              <DollarSign size={11} style={{ verticalAlign: -1 }} />
              {moneyShort(total)}
            </span>
            {earnings?.deal_count > 0 && (
              <span className="muted small">{earnings.deal_count.toLocaleString()} deals</span>
            )}
            {hasChildren && (
              <span className="muted small">
                · {sortedChildren.length} sub{sortedChildren.length === 1 ? '' : 's'}
              </span>
            )}
            {(node.direct_clients_count || 0) > 0 && (
              <span className="muted small">· {node.direct_clients_count} direct clients</span>
            )}
          </div>

          {products.length === 0 ? (
            <div className="ct-no-products muted small">
              <AlertTriangle size={12} style={{ verticalAlign: -2 }} /> No products — will earn nothing
            </div>
          ) : (
            <div className="ct-products">
              {products.map(p => (
                <ProductDetail
                  key={p.product_id}
                  product={p}
                  agent={node}
                  parentProduct={parentProductsById ? parentProductsById.get(p.product_id) : null}
                  parentExists={parentProductsById !== null}
                />
              ))}
            </div>
          )}
        </div>
      </div>
      {hasChildren && open && (
        <div className="ct-children">
          {sortedChildren.map(child => (
            <AgentNode
              key={child.id}
              node={child}
              depth={depth + 1}
              earningsById={earningsById}
              initiallyOpen={false}
              autoExpand={autoExpand}
              highlight={highlight}
              parentProductsById={myProductsById}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CommissionTree() {
  const [q, setQ] = useState('');
  const { data, loading, error } = useApi('/commission-tree', {}, []);

  const roots = data?.roots || [];
  const earnings = data?.earnings || [];

  const earningsById = useMemo(() => {
    const map = new Map();
    earnings.forEach(e => map.set(e.id, e));
    return map;
  }, [earnings]);

  const sortedRoots = useMemo(() => {
    return [...roots].sort((a, b) => {
      const ea = earningsById.get(a.id)?.total_amount || 0;
      const eb = earningsById.get(b.id)?.total_amount || 0;
      return eb - ea;
    });
  }, [roots, earningsById]);

  // Filter — keep the agent's entire subtree on a direct match; otherwise
  // trim unrelated branches to the ancestor chain leading to a match.
  const needle = q.trim().toLowerCase();
  const filteredRoots = useMemo(() => {
    if (!needle) return sortedRoots;
    function prune(node) {
      const selfMatch = (node.name || '').toLowerCase().includes(needle);
      if (selfMatch) return node;
      const keptChildren = (node.children || []).map(prune).filter(Boolean);
      if (keptChildren.length > 0) return { ...node, children: keptChildren };
      return null;
    }
    return sortedRoots.map(prune).filter(Boolean);
  }, [sortedRoots, needle]);

  const matchCount = useMemo(() => {
    if (!needle) return 0;
    let n = 0;
    function walk(node) {
      if ((node.name || '').toLowerCase().includes(needle)) n++;
      (node.children || []).forEach(walk);
    }
    filteredRoots.forEach(walk);
    return n;
  }, [filteredRoots, needle]);

  // Subtree stats — same shape as admin view's stats bar
  const stats = useMemo(() => {
    if (roots.length === 0) return null;
    let agents = 0, products = 0, absorbedPairs = 0, overridePairs = 0, orphanPairs = 0;
    function walk(node) {
      agents++;
      for (const p of (node.products || [])) {
        products++;
        const a = analyzeProduct(node, p);
        overridePairs += a.override;
        absorbedPairs += a.absorbed;
        orphanPairs   += a.orphan;
      }
      (node.children || []).forEach(walk);
    }
    roots.forEach(walk);
    return { agents, products, absorbedPairs, overridePairs, orphanPairs };
  }, [roots]);

  const topEarners = useMemo(() => {
    if (roots.length === 0) return [];
    const flat = [];
    function walk(node) {
      const e = earningsById.get(node.id);
      if (e && Number(e.total_amount) > 0) flat.push({ id: node.id, name: node.name, total: Number(e.total_amount), deals: e.deal_count });
      (node.children || []).forEach(walk);
    }
    roots.forEach(walk);
    return flat.sort((a, b) => b.total - a.total).slice(0, 10);
  }, [roots, earningsById]);

  const subtreeTotal = topEarners.reduce((s, a) => s + a.total, 0);

  return (
    <div>
      <header className="page-header">
        <div>
          <h1><GitBranch size={18} style={{ verticalAlign: -3, marginRight: 8 }} />Commission tree</h1>
          <p className="muted">
            Your subtree's waterfall view — your own rates, every sub-agent
            below you, and whether they absorb the rate or pass an override
            back up to you. Rate changes are managed by admins.
          </p>
        </div>
      </header>

      {error && <div className="alert error">{error.message}</div>}

      <div className="filter-bar">
        <label className="field inline" style={{ flex: 1, maxWidth: 360 }}>
          <span><Search size={12} style={{ verticalAlign: -1 }} /> Agent name</span>
          <input
            className="input"
            placeholder="Search by agent name…"
            value={q}
            onChange={e => setQ(e.target.value)}
          />
        </label>
        {needle && (
          <div className="muted small">
            {matchCount} match{matchCount === 1 ? '' : 'es'}
            <button
              type="button"
              className="btn ghost small"
              style={{ marginLeft: 8 }}
              onClick={() => setQ('')}
            >Clear</button>
          </div>
        )}
      </div>

      {stats && (
        <section className="stat-row">
          <div className="stat">
            <div className="stat-label">Agents in subtree</div>
            <div className="stat-value">{stats.agents}</div>
            <div className="stat-sub muted">{stats.products} product assignment{stats.products === 1 ? '' : 's'}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Override pairs</div>
            <div className="stat-value" style={{ color: 'var(--success)' }}>{stats.overridePairs}</div>
            <div className="stat-sub muted">sub-agents passing up</div>
          </div>
          <div className="stat">
            <div className="stat-label">Absorbed pairs</div>
            <div className="stat-value" style={{ color: 'var(--warn)' }}>{stats.absorbedPairs}</div>
            <div className="stat-sub muted">sub-agents taking full rate</div>
          </div>
          <div className="stat">
            <div className="stat-label">Orphan pairs</div>
            <div className="stat-value" style={{ color: 'var(--text-muted)' }}>{stats.orphanPairs}</div>
            <div className="stat-sub muted">sub-agent missing product</div>
          </div>
        </section>
      )}

      {topEarners.length > 0 && (
        <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
          <div className="card-header">
            <h2><Trophy size={14} style={{ verticalAlign: -2, marginRight: 6 }} />Top earners in your subtree</h2>
            <span className="muted small">All-time commission · ${moneyShort(subtreeTotal)} total</span>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 32 }}>#</th>
                <th>Agent</th>
                <th className="num">Deals</th>
                <th className="num">Total earned</th>
              </tr>
            </thead>
            <tbody>
              {topEarners.map((e, i) => (
                <tr key={e.id}>
                  <td className="muted mono">{i + 1}</td>
                  <td>{e.name}</td>
                  <td className="num mono">{(e.deals || 0).toLocaleString()}</td>
                  <td className="num mono strong">${money(e.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {loading && roots.length === 0 && (
        <div className="muted pad">Loading your subtree…</div>
      )}

      {!loading && roots.length === 0 && !error && (
        <div className="muted pad">No agents in your subtree yet.</div>
      )}

      {filteredRoots.length > 0 && (
        <div className="ct-tree">
          {filteredRoots.map(root => (
            <AgentNode
              key={root.id}
              node={root}
              depth={0}
              earningsById={earningsById}
              initiallyOpen
              autoExpand={!!needle}
              highlight={needle}
            />
          ))}
        </div>
      )}
    </div>
  );
}
