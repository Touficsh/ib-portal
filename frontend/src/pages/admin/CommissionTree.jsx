import { useMemo, useState, useRef, useEffect } from 'react';
import {
  GitBranch, ChevronRight, ChevronDown, Package,
  AlertTriangle, ArrowDown, Info, DollarSign, Trophy, Pencil, Check, X, Search,
  RefreshCw, CloudDownload,
} from 'lucide-react';
import { useApi, useMutation } from '../../hooks/useApi.js';
import { toast, confirm } from '../../components/ui/toast.js';

/**
 * Admin — Commission Tree (per branch)
 *
 * Waterfall visualization of product rates per branch. For every (agent, product)
 * pair, shows whether direct sub-agents absorb the full rate (no override for
 * parent) or pass some up the chain.
 *
 * Source: /api/agents/hierarchy + /api/commissions/earners. All client-side
 * analysis, zero external calls.
 *
 * Design notes:
 *   - Each agent node shows real earnings next to the name
 *   - Sub-agent detail is collapsed by default (summary pills: "3 absorbed / 7 no-product")
 *   - Click the product header to expand per-sub-agent breakdown
 *   - Tree is sorted by actual $ earned (desc) so top earners surface first
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
 * Analyze one (agent, product) pair — return counts of direct sub-agents in
 * each waterfall state. Uses CRM commission levels (pct + rebate) when
 * available; falls back to legacy single rate_per_lot when not synced yet.
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
      // CRM math: parent's override = (pct - child.pct)/100 × broker + ($rebate - child.$rebate) × lots
      const childPct    = Number(childProduct.effective_pct     || 0);
      const childRebate = Number(childProduct.effective_per_lot || 0);
      const pctMargin    = parentPct    - childPct;
      const rebateMargin = parentRebate - childRebate;
      const broker = Number(product.broker_commission_per_lot || 0);
      // Effective override per lot at the product's broker commission
      const overridePerLot = Math.max(0, pctMargin) / 100 * broker + Math.max(0, rebateMargin);
      const childEffective = Number(childProduct.effective_rate_per_lot || 0);
      const parentEffective = Number(product.effective_rate_per_lot || 0);
      return {
        agent_id: child.id,
        name: child.name,
        // Show child's CRM config directly
        pct: childPct,
        rebate: childRebate,
        effective: childEffective,
        // And parent's override
        overridePct: pctMargin,
        overrideRebate: rebateMargin,
        overridePerLot,
        parentEffective,
        state: overridePerLot > 0 ? 'override' : 'absorbed',
      };
    }

    if (useCrm && !childProduct.has_crm_config) {
      // Mixed mode: parent is CRM-synced, child has no CRM config (either not
      // yet synced, or CRM removed their rates). Engine falls back to
      // rate_per_lot as the child's per_lot component (see commissionEngine.js).
      // Display that fallback explicitly so the admin isn't confused by
      // wrong legacy-math override numbers.
      const childLegacyRate = Number(childProduct.rate_per_lot || 0);
      const parentPerLot    = Number(product.effective_per_lot || 0);
      // Approximate parent override: parent keeps the per_lot margin above child's legacy rate.
      // (The pct portion flows 100% to parent since child has no pct config.)
      const overridePerLot = Math.max(0, parentPerLot - childLegacyRate);
      return {
        agent_id: child.id,
        name: child.name,
        rate: childLegacyRate,
        overridePerLot,
        mixedMode: true,
        state: overridePerLot > 0 || Number(product.effective_pct || 0) > 0 ? 'override' : 'absorbed',
      };
    }

    // Legacy path: fall back to rate_per_lot (for branches not yet synced)
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

/**
 * Inline-editable rate pill. Click to edit; Enter / Save hits
 * POST /api/agents/:id/products. Handles cascade errors (400) and
 * descendants-exceeding warnings (409 → confirm to force-clamp).
 */
function EditableRate({ agentId, product, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(Number(product.rate_per_lot).toFixed(2)));
  const [save, { loading }] = useMutation();
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [editing]);

  function cancel(e) {
    e?.stopPropagation();
    setValue(String(Number(product.rate_per_lot).toFixed(2)));
    setEditing(false);
  }

  async function commit(e) {
    e?.stopPropagation();
    const n = Number(value);
    const max = Number(product.max_rate_per_lot);
    if (!Number.isFinite(n) || n < 0) {
      toast.error('Invalid rate'); return;
    }
    if (n > max) {
      toast.error(`Rate exceeds product max ($${money(max)}/lot)`); return;
    }
    if (n === Number(product.rate_per_lot)) {
      setEditing(false); return;  // no change
    }
    try {
      await save(`/api/agents/${agentId}/products`, {
        method: 'POST',
        body: { product_id: product.product_id, rate_per_lot: n },
      });
      toast.success(`${product.name} → $${money(n)}/lot`);
      setEditing(false);
      onSaved?.();
    } catch (err) {
      // 409 = lowering would orphan descendants — offer to force-clamp
      if (err.status === 409 && err.body?.affected?.length > 0) {
        const names = err.body.affected.slice(0, 5).map(a => a.agent_name).join(', ');
        const extra = err.body.affected.length > 5 ? ` + ${err.body.affected.length - 5} more` : '';
        const ok = await confirm(
          `Lowering this rate would orphan ${err.body.affected.length} descendant rate${err.body.affected.length === 1 ? '' : 's'}:\n${names}${extra}\n\nClamp them down to the new rate automatically?`,
          { confirmLabel: 'Clamp descendants', cancelLabel: 'Cancel', variant: 'warning' }
        );
        if (!ok) return;
        try {
          await save(`/api/agents/${agentId}/products?force=true`, {
            method: 'POST',
            body: { product_id: product.product_id, rate_per_lot: n },
          });
          toast.success(`${product.name} → $${money(n)}/lot + clamped ${err.body.affected.length} descendants`);
          setEditing(false);
          onSaved?.();
        } catch (err2) {
          toast.error(err2.message || 'Clamp failed');
        }
        return;
      }
      // 400 cascade = exceeds parent's ceiling
      if (err.status === 400 && err.body?.ceiling != null) {
        toast.error(`Rate exceeds parent's ceiling of $${money(err.body.ceiling)}/lot`);
        return;
      }
      toast.error(err.message || 'Save failed');
    }
  }

  if (!editing) {
    return (
      <span
        className="ct-rate ct-rate-editable mono"
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title="Click to edit"
      >
        ${money(Number(product.rate_per_lot))}/lot
        <Pencil size={10} className="ct-rate-pencil" />
      </span>
    );
  }

  return (
    <span className="ct-rate-editor" onClick={e => e.stopPropagation()}>
      <span className="ct-rate-dollar">$</span>
      <input
        ref={inputRef}
        type="number"
        step="0.01"
        min="0"
        max={product.max_rate_per_lot}
        className="ct-rate-input mono"
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') commit(e);
          if (e.key === 'Escape') cancel(e);
        }}
        disabled={loading}
      />
      <button type="button" className="ct-rate-btn ct-rate-save" onClick={commit} disabled={loading} title="Save (Enter)">
        <Check size={12} />
      </button>
      <button type="button" className="ct-rate-btn ct-rate-cancel" onClick={cancel} disabled={loading} title="Cancel (Esc)">
        <X size={12} />
      </button>
    </span>
  );
}

function ProductDetail({ product, agent, onRateChanged }) {
  const [expanded, setExpanded] = useState(false);
  const { subs, absorbed, override, orphan } = analyzeProduct(agent, product);
  const hasChildren = subs.length > 0;
  const useCrm = product.has_crm_config;

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
            {/* CRM-synced: show pct + rebate + effective rate. Read-only. */}
            <span
              className="ct-rate mono"
              title={`CRM: ${product.effective_pct}% commission + $${money(product.effective_per_lot)}/lot rebate\nEffective at broker $${money(product.broker_commission_per_lot)}/lot`}
            >
              {product.effective_pct}% + ${money(product.effective_per_lot)}
            </span>
            <span className="mono small" style={{ color: 'var(--success)', fontWeight: 600 }} title="Effective $/lot — pct × broker commission + flat rebate">
              ≈ ${money(product.effective_rate_per_lot)}/lot
            </span>
            <span className="pill stage-active" style={{ fontSize: 9, padding: '1px 5px' }} title="Source: synced from xdev CRM. Edit in CRM to change.">
              CRM
            </span>
          </>
        ) : (
          <>
            {/* Legacy: editable rate_per_lot for unsynced branches */}
            <EditableRate agentId={agent.id} product={product} onSaved={onRateChanged} />
            <span className="muted small">max ${money(product.max_rate_per_lot)}</span>
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
              ) : sub.mixedMode ? (
                <>
                  {/* Mixed: parent CRM-synced, child uses legacy rate as per_lot fallback */}
                  <span className="ct-sub-rate mono" title="Legacy rate — no CRM config synced for this agent">
                    ${money(sub.rate)}/lot
                  </span>
                  <span className="pill" style={{ fontSize: 9, padding: '1px 5px', background: 'var(--warn-soft)', color: 'var(--warn)', marginLeft: 4 }}
                    title="No CRM commission config for this agent. Engine uses their legacy rate_per_lot as the per-lot component.">
                    no CRM
                  </span>
                  {sub.state === 'override' ? (
                    <span className="ct-sub-verdict verdict-good">
                      +${money(sub.overridePerLot)}/lot rebate margin + {money(product.effective_pct || 0)}% pct → parent
                    </span>
                  ) : (
                    <span className="ct-sub-verdict verdict-warn">
                      child rate ≥ parent rebate — only parent pct margin flows up
                    </span>
                  )}
                </>
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
                  {/* CRM math — show child's pct + rebate, and parent override breakdown */}
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

function AgentNode({ node, depth, earningsById, onRateChanged, initiallyOpen = false, autoExpand = false, highlight = '' }) {
  const [open, setOpen] = useState(initiallyOpen || depth === 0);
  const hasChildren = (node.children || []).length > 0;
  const products = node.products || [];
  const earnings = earningsById.get(node.id);
  const total = earnings?.total_amount || 0;

  // When the caller requests auto-expand (e.g. search active), force-open.
  // Still allow the user to collapse after — we only set it on the autoExpand edge.
  useEffect(() => {
    if (autoExpand) setOpen(true);
  }, [autoExpand]);

  // Highlight match inside the name
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

  // Sort children by earnings desc for visual prominence
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
                  onRateChanged={onRateChanged}
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
              onRateChanged={onRateChanged}
              initiallyOpen={false}
              autoExpand={autoExpand}
              highlight={highlight}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function CommissionTree() {
  // Branch selector — default to Paul Matar (first validated branch). User can pick any.
  const [selectedBranch, setSelectedBranch] = useState('Paul Matar');
  // Agent-name filter
  const [q, setQ] = useState('');
  const { data: branches } = useApi('/api/agents/branches-with-counts', {}, []);

  // If the default branch isn't in the list (e.g. renamed), fall back to the top branch.
  useEffect(() => {
    if (!branches || branches.length === 0) return;
    if (!branches.find(b => b.branch === selectedBranch)) {
      setSelectedBranch(branches[0].branch);
    }
  }, [branches]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: hier, loading, refetch: refetchHier } = useApi(
    selectedBranch ? `/api/agents/hierarchy?branch=${encodeURIComponent(selectedBranch)}` : null,
    {},
    [selectedBranch]
  );
  const { data: earners } = useApi('/api/commissions/earners', {}, []);

  // Sync mutations — both wire to existing admin endpoints. Products sync
  // walks every imported agent, upserts links, and (after the recent fix)
  // deactivates rows for products that CRM no longer lists for an agent.
  // Commission-levels sync pulls per-agent `% + $/lot` from CRM into the
  // crm_commission_levels table so the engine uses real numbers instead of
  // legacy single-rate fallback.
  const [runProductSync,   { loading: syncingProducts }]   = useMutation();
  const [runCommLevelSync, { loading: syncingCommLevels }] = useMutation();

  async function handleSyncProducts() {
    const ok = await confirm(
      `Sync agent product list from CRM?\n\n` +
      `This walks every imported agent, adds new product links, and deactivates ` +
      `links for products the CRM no longer lists. Manual rate edits are preserved. ` +
      `Takes ~30–60 seconds.`,
      { confirmLabel: 'Sync products', cancelLabel: 'Cancel' }
    );
    if (!ok) return;
    try {
      const r = await runProductSync('/api/agents/sync-products-from-crm', { method: 'POST' });
      const msg = `Synced ${r.scannedLinks || 0} CRM links — created ${r.created || 0}, deactivated ${r.deactivated || 0}, preserved ${r.preserved || 0}${r.errors ? ` · ${r.errors} errors` : ''}`;
      toast.success(msg, { duration: 8000 });
      refetchHier();
    } catch (err) {
      toast.error(err.message || 'Product sync failed');
    }
  }

  /**
   * Sync commission rates from CRM. Two flavors:
   *   - Default ("smart sync"): sends ?staleAfterHours=24, so agents synced
   *     within the last day are skipped. Repeated clicks within a day fire
   *     ~zero CRM calls — protects the CRM from overload.
   *   - Force-full: sends ?staleAfterHours=0, hits every agent. Use when
   *     CRM rates definitely changed and you need them right now.
   */
  async function handleSyncCommLevels({ force = false } = {}) {
    const ok = await confirm(
      force
        ? `FORCE-FULL sync of commission rates from CRM?\n\n` +
          `Will hit ALL imported agents (~700) regardless of last sync time. ` +
          `~1,400 CRM calls at 4/s = ~5 minutes. Use only when you know rates changed ` +
          `and need them immediately. Default "Sync rates" is gentler.`
        : `Sync commission rates from CRM (smart mode)?\n\n` +
          `Skips agents synced within the last 24h to spare CRM. New imports ` +
          `and stale agents get refreshed. Use "Force full sync" only when rates ` +
          `definitely changed.\n\n` +
          `Typical run: a handful of CRM calls (vs ~1,400 for a full sync).`,
      { confirmLabel: force ? 'Force full sync' : 'Smart sync', cancelLabel: 'Cancel', variant: force ? 'danger' : undefined }
    );
    if (!ok) return;
    try {
      const url = force
        ? '/api/agents/sync-commission-levels?staleAfterHours=0'
        : '/api/agents/sync-commission-levels';
      const r = await runCommLevelSync(url, { method: 'POST' });
      const note = r.note
        || (force
          ? 'Force-full sync started in the background.'
          : 'Smart sync started — agents synced in the last 24h are skipped.');
      toast.success(`${note} Refresh page in ~1 min to see updated rates.`, { duration: 8000 });
    } catch (err) {
      toast.error(err.message || 'Commission-rate sync failed');
    }
  }

  const earningsById = useMemo(() => {
    const map = new Map();
    (earners || []).forEach(e => map.set(e.id, e));
    return map;
  }, [earners]);

  // Sort roots by earnings desc so highest-earning top-level agents appear first
  const sortedRoots = useMemo(() => {
    return [...(hier?.roots || [])].sort((a, b) => {
      const ea = earningsById.get(a.id)?.total_amount || 0;
      const eb = earningsById.get(b.id)?.total_amount || 0;
      return eb - ea;
    });
  }, [hier, earningsById]);

  // Agent filter — prune the tree so:
  //   - a direct match shows the agent AND their full sub-tree (so "Hadi Chkair"
  //     reveals Hadi + every agent under him)
  //   - an indirect match (a descendant matches) keeps only the ancestor chain
  //     down to the match, pruning unrelated siblings
  const needle = q.trim().toLowerCase();
  const filteredRoots = useMemo(() => {
    if (!needle) return sortedRoots;
    function prune(node) {
      const selfMatch = (node.name || '').toLowerCase().includes(needle);
      if (selfMatch) {
        // Keep the entire subtree unfiltered — user asked for this agent,
        // so show everything they oversee.
        return node;
      }
      const keptChildren = (node.children || []).map(prune).filter(Boolean);
      if (keptChildren.length > 0) {
        return { ...node, children: keptChildren };
      }
      return null;
    }
    return sortedRoots.map(prune).filter(Boolean);
  }, [sortedRoots, needle]);

  // Count total matching agents (for the status line)
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

  const stats = useMemo(() => {
    if (!hier?.roots) return null;
    let agents = 0, products = 0, zeroRate = 0, absorbedPairs = 0, overridePairs = 0, orphanPairs = 0;
    function walk(node) {
      agents++;
      for (const p of (node.products || [])) {
        products++;
        if (Number(p.rate_per_lot) === 0) zeroRate++;
        const a = analyzeProduct(node, p);
        overridePairs += a.override;
        absorbedPairs += a.absorbed;
        orphanPairs   += a.orphan;
      }
      (node.children || []).forEach(walk);
    }
    hier.roots.forEach(walk);
    return { agents, products, zeroRate, absorbedPairs, overridePairs, orphanPairs };
  }, [hier]);

  // Top 10 earners in this branch (flatten tree + filter to those with earnings)
  const topEarners = useMemo(() => {
    if (!hier?.roots) return [];
    const flat = [];
    function walk(node) {
      const e = earningsById.get(node.id);
      if (e && Number(e.total_amount) > 0) flat.push({ id: node.id, name: node.name, total: Number(e.total_amount), deals: e.deal_count });
      (node.children || []).forEach(walk);
    }
    hier.roots.forEach(walk);
    return flat.sort((a, b) => b.total - a.total).slice(0, 10);
  }, [hier, earningsById]);

  const branchTotal = topEarners.reduce((s, a) => s + a.total, 0);

  return (
    <div>
      <header className="page-header" style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1><GitBranch size={18} style={{ verticalAlign: -3, marginRight: 8 }} />Commission tree</h1>
          <p className="muted">
            Waterfall view of product rates per branch. Every agent shows their real earnings,
            products, and which sub-agents absorb vs pass up the rate. Sort is by earnings so
            your top producers surface first.
          </p>
        </div>
        {/* Sync controls — pull fresh product list + rates from x-dev CRM
            without leaving the page. Both fire global syncs (all agents)
            since CRM is the source of truth and the operation is idempotent. */}
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            className="btn ghost small"
            onClick={handleSyncProducts}
            disabled={syncingProducts || syncingCommLevels}
            title="Walk every agent's product list from CRM. New links added, removed links deactivated. Manual rate edits preserved."
          >
            <CloudDownload size={12} /> {syncingProducts ? 'Syncing products…' : 'Sync products'}
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => handleSyncCommLevels({ force: false })}
            disabled={syncingProducts || syncingCommLevels}
            title="Smart sync: pull commission rates only for agents not synced in the last 24 hours. Light on CRM."
          >
            <RefreshCw size={12} /> {syncingCommLevels ? 'Syncing rates…' : 'Sync rates (smart)'}
          </button>
          <button
            type="button"
            className="btn ghost small"
            onClick={() => handleSyncCommLevels({ force: true })}
            disabled={syncingProducts || syncingCommLevels}
            title="Force-full sync: hit all ~700 agents regardless of last sync time. Heavy on CRM — only use when rates definitely changed."
            style={{ opacity: 0.7 }}
          >
            <RefreshCw size={12} /> Force full
          </button>
        </div>
      </header>

      <div className="filter-bar">
        <label className="field inline">
          <span>Branch</span>
          <select
            className="input"
            value={selectedBranch}
            onChange={e => { setSelectedBranch(e.target.value); setQ(''); }}
            style={{ minWidth: 240 }}
          >
            {(branches || []).map(b => (
              <option key={b.branch} value={b.branch}>
                {b.branch} — {b.agent_count} agents · {b.client_count} clients
              </option>
            ))}
          </select>
        </label>
        <div className="ct-search-wrap">
          <Search size={13} className="ct-search-icon" />
          <input
            className="input ct-search-input"
            placeholder="Filter agents by name…"
            value={q}
            onChange={e => setQ(e.target.value)}
            style={{ width: 280 }}
          />
          {q && (
            <button type="button" className="btn ghost small" onClick={() => setQ('')}>
              Clear
            </button>
          )}
        </div>
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          {loading
            ? 'loading…'
            : needle
              ? `${matchCount} match${matchCount === 1 ? '' : 'es'} in ${selectedBranch}`
              : `${(branches || []).length} branches · ${(branches || []).reduce((s, b) => s + (b.agent_count || 0), 0)} agents total`}
        </span>
      </div>

      {stats && (
        <section className="stat-row" style={{ marginBottom: 'var(--space-4)' }}>
          <div className="stat">
            <div className="stat-label">Agents</div>
            <div className="stat-value">{stats.agents}</div>
            <div className="stat-sub muted">{topEarners.length} earning</div>
          </div>
          <div className="stat">
            <div className="stat-label">Branch earnings</div>
            <div className="stat-value">${money(branchTotal)}</div>
            <div className="stat-sub muted">sum of all agents</div>
          </div>
          <div className="stat stat-success">
            <div className="stat-label">Override pairs</div>
            <div className="stat-value">{stats.overridePairs}</div>
            <div className="stat-sub muted">parent earns from sub</div>
          </div>
          <div className="stat stat-warn">
            <div className="stat-label">Absorbed pairs</div>
            <div className="stat-value">{stats.absorbedPairs}</div>
            <div className="stat-sub muted">sub takes full rate</div>
          </div>
          <div className="stat">
            <div className="stat-label">No-product pairs</div>
            <div className="stat-value">{stats.orphanPairs}</div>
            <div className="stat-sub muted">full rate flows up</div>
          </div>
        </section>
      )}

      {topEarners.length > 0 && (
        <section className="card" style={{ marginBottom: 'var(--space-4)' }}>
          <div className="card-header">
            <h2><Trophy size={14} style={{ verticalAlign: -2, marginRight: 6, color: 'var(--accent)' }} />Top earners in {selectedBranch}</h2>
            <span className="muted small">All-time</span>
          </div>
          <div className="pad">
            <div className="ct-leaderboard">
              {topEarners.map((e, i) => {
                const pct = branchTotal > 0 ? (e.total / branchTotal) * 100 : 0;
                return (
                  <div key={e.id} className="ct-leader-row">
                    <span className="ct-leader-rank">{i + 1}</span>
                    <span className="ct-leader-name">{e.name}</span>
                    <div className="ct-leader-bar">
                      <div className="ct-leader-fill" style={{ width: Math.max(3, pct) + '%' }} />
                    </div>
                    <span className="ct-leader-amount mono">${money(e.total)}</span>
                    <span className="muted small ct-leader-pct">{pct.toFixed(1)}%</span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-header">
          <h2>{selectedBranch} · agent hierarchy</h2>
          <span className="muted small">Click a product to see which sub-agents absorb vs pass up · Click an agent to expand sub-tree</span>
        </div>
        <div className="pad">
          {loading && <div className="muted">Loading…</div>}
          {!loading && sortedRoots.length === 0 && (
            <div className="muted">No imported agents in this branch.</div>
          )}
          {!loading && sortedRoots.length > 0 && filteredRoots.length === 0 && (
            <div className="muted">No agents match "{q}".</div>
          )}
          <div className="ct-tree">
            {filteredRoots.map(root => (
              <AgentNode
                key={root.id}
                node={root}
                depth={0}
                earningsById={earningsById}
                onRateChanged={refetchHier}
                initiallyOpen={false}
                autoExpand={!!needle}
                highlight={needle ? q.trim() : ''}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 'var(--space-4)' }}>
        <div className="card-header"><h2>Legend</h2></div>
        <div className="pad ct-legend-grid">
          <div className="ct-legend-item">
            <span className="ct-summary-chip ct-chip-override">3↑</span>
            <div>
              <div className="small"><b>Override</b></div>
              <div className="muted small">Sub has lower rate. Difference flows up to parent on sub's deals.</div>
            </div>
          </div>
          <div className="ct-legend-item">
            <span className="ct-summary-chip ct-chip-absorbed">5=</span>
            <div>
              <div className="small"><b>Absorbed</b></div>
              <div className="muted small">Sub has same rate as parent. Parent earns <b>$0</b> from sub's deals.</div>
            </div>
          </div>
          <div className="ct-legend-item">
            <span className="ct-summary-chip ct-chip-orphan">2·</span>
            <div>
              <div className="small"><b>No product</b></div>
              <div className="muted small">Sub doesn't hold this product. Parent earns full rate on sub's clients.</div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
