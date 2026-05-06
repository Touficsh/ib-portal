import { useState, useMemo, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, CheckCircle2, Package, CornerUpLeft, UsersRound, Ban, Filter as FilterIcon,
  LayoutList, LayoutGrid,
} from 'lucide-react';
import { useApi, useAutoRefresh } from '../../hooks/useApi.js';
import LastUpdated from '../../components/LastUpdated.jsx';

/**
 * Admin — Agent Network
 *
 * The unified replacement for the two older pages (Hierarchy + Agents Tree).
 * They both walked the same agent parent_agent_id graph and rendered it as a
 * tree — only difference was how much info was overlaid on each node. Instead
 * of maintaining two near-duplicate pages, this one has a view-mode toggle at
 * the top:
 *
 *   • Compact   — minimal ASCII-style tree with names + a few counters.
 *                 Fastest to scan when you want to see the shape of the org.
 *   • Detailed  — cards-with-product-chips view, colored status dots, and
 *                 operational-state filter chips ("Needs setup", "Configured",
 *                 etc.) for finding agents that still need rate configuration.
 *
 * Both modes share the same source of truth — `GET /api/agents/hierarchy` —
 * and the same search, branch, expand/collapse controls. Switching modes is
 * instant because we never re-fetch; just re-render.
 *
 * Commission Tree is intentionally separate: it layers earnings data + waterfall
 * math + inline rate editing on top of the tree and has enough distinct utility
 * that merging it in would clutter this page for the "just show me the tree"
 * use case.
 */

// ───────────────────────── Detailed-mode helpers ─────────────────────────

/**
 * Compact product chip — name + color dot:
 *   green  = rate configured (> 0)
 *   red    = needs rate (portal row with rate_per_lot = 0)
 *   amber  = CRM-only (not yet in portal's agent_products)
 */
function ProductChip({ product }) {
  const isCrmOnly = product.source === 'crm-only' || product.in_portal === false;
  const hasRate = !isCrmOnly && product.rate_per_lot > 0;
  const status = isCrmOnly ? 'crm-only' : hasRate ? 'set' : 'unset';
  const tooltip = [
    product.name,
    product.code ? `code ${product.code}` : null,
    product.group ? `group ${product.group}` : null,
    isCrmOnly ? 'CRM-only (not in portal yet)'
      : hasRate ? `${product.rate_per_lot.toFixed(2)} ${product.currency || ''}/lot`
      : `needs rate (ceiling ${product.max_rate_per_lot || '?'} ${product.currency || ''})`,
  ].filter(Boolean).join(' · ');
  return (
    <span className={`pchip pchip-${status}`} title={tooltip}>
      <span className={`pchip-dot pchip-dot-${status}`} />
      {product.name}
    </span>
  );
}

/** Recursive card renderer — Detailed mode */
function DetailedNode({ agent, depth = 0, expandedMap, onToggle }) {
  const isExpanded = expandedMap[agent.id] !== false;
  const hasChildren = (agent.children || []).length > 0;
  const hasProducts = (agent.products || []).length > 0;

  return (
    <div className={`h-node h-depth-${Math.min(depth, 5)}`}>
      <div className={`h-card ${isExpanded && hasProducts ? 'has-products' : ''}`}>
        <div className="h-row">
          <button
            className={`h-toggle ${isExpanded ? 'open' : ''}`}
            onClick={() => onToggle(agent.id)}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            ▸
          </button>
          <div className="h-avatar">{(agent.name || '?')[0].toUpperCase()}</div>
          <Link to={`/admin/agents/${agent.id}`} className="h-name">{agent.name}</Link>
          {agent.branch && <span className="h-tag" title={`Branch: ${agent.branch}`}>{agent.branch}</span>}
          <span className="h-stats">
            <span className="h-stat h-stat-client" title="Direct clients">
              {agent.direct_clients_count}<span className="h-stat-u">Clients</span>
            </span>
            <span className="h-sep">·</span>
            <span className="h-stat h-stat-product" title="Linked products">
              {(agent.products || []).length}<span className="h-stat-u">Products</span>
            </span>
            {hasChildren && (
              <>
                <span className="h-sep">·</span>
                <span className="h-stat h-stat-sub" title="Direct sub-agents">
                  {agent.direct_sub_count}<span className="h-stat-u">Sub-agents</span>
                </span>
              </>
            )}
          </span>
          {!agent.is_active && <span className="h-badge churned">inactive</span>}
        </div>

        {isExpanded && hasProducts && (
          <div className="h-products">
            {(agent.products || []).map((p, idx) => (
              <ProductChip key={p.product_id || `${p.code}-${idx}`} product={p} />
            ))}
          </div>
        )}
      </div>

      {isExpanded && hasChildren && (
        <div className="h-children">
          {agent.children.map(child => (
            <DetailedNode
              key={child.id}
              agent={child}
              depth={depth + 1}
              expandedMap={expandedMap}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ───────────────────────── Compact-mode helpers ─────────────────────────

/** Minimal ASCII-style tree node. Uses the same hierarchy data but renders
 *  only name/email/branch + counters — no products, no color dots. */
function CompactNode({ agent, expanded, onToggle, isLast }) {
  const kids = agent.children || [];
  const hasKids = kids.length > 0;
  const isOpen = expanded[agent.id] !== false;
  const showKids = hasKids && isOpen;

  return (
    <li className={`tree-li ${isLast ? 'is-last' : ''}`}>
      <div className="tree-node">
        <button
          className={`tree-chev ${isOpen ? 'open' : ''}`}
          onClick={() => onToggle(agent.id)}
          disabled={!hasKids}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
          title={hasKids ? (isOpen ? 'Collapse subtree' : 'Expand subtree') : 'No sub-agents'}
        >
          {hasKids ? '▸' : '·'}
        </button>
        <span className="tree-init">{(agent.name || '?')[0].toUpperCase()}</span>
        <Link to={`/admin/agents/${agent.id}`} className="tree-nm">{agent.name}</Link>
        <span className="tree-email muted">{agent.email || '—'}</span>
        {agent.branch && <span className="tree-br" title={`Branch: ${agent.branch}`}>{agent.branch}</span>}
        <span className="tree-nums">
          <span className="tree-num tree-num-c" title="Direct clients">
            {agent.direct_clients_count}<span className="tree-num-u">Clients</span>
          </span>
          <span className="tree-num tree-num-s" title="Direct sub-agents">
            {agent.direct_sub_count}<span className="tree-num-u">Sub-agents</span>
          </span>
          <span
            className={`tree-num tree-num-p ${(agent.products || []).length > 0 ? 'strong' : 'dim'}`}
            title="Linked products"
          >
            {(agent.products || []).length}<span className="tree-num-u">Products</span>
          </span>
          {!agent.is_active && <span className="tree-badge">inactive</span>}
        </span>
      </div>
      {showKids && (
        <ul className="tree-ul">
          {kids.map((k, idx) => (
            <CompactNode
              key={k.id}
              agent={k}
              expanded={expanded}
              onToggle={onToggle}
              isLast={idx === kids.length - 1}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// ───────────────────────── Detailed-mode status filters ─────────────────────────

/** Buckets for the "operational state" filter chips. Keep the predicates
 *  pure so they can both drive tree-pruning and the chip counts. */
const STATUS_FILTERS = {
  all: {
    label: 'All',
    icon: FilterIcon,
    match: () => true,
  },
  'needs-setup': {
    label: 'Needs setup',
    icon: AlertCircle,
    match: (n) => (n.products || []).length > 0 && (n.products || []).some(p => !(p.rate_per_lot > 0) && p.source !== 'crm-only'),
    tone: 'warn',
  },
  configured: {
    label: 'Configured',
    icon: CheckCircle2,
    match: (n) => (n.products || []).length > 0 && (n.products || []).every(p => p.source === 'crm-only' || p.rate_per_lot > 0),
    tone: 'success',
  },
  'no-products': {
    label: 'No products',
    icon: Package,
    match: (n) => (n.products || []).length === 0,
    tone: 'muted',
  },
  'top-level': {
    label: 'Top-level',
    icon: CornerUpLeft,
    match: (_, depth) => depth === 0,
  },
  'has-subs': {
    label: 'Has sub-agents',
    icon: UsersRound,
    match: (n) => (n.children || []).length > 0,
  },
  inactive: {
    label: 'Inactive',
    icon: Ban,
    match: (n) => !n.is_active,
    tone: 'danger',
  },
};

function countBuckets(roots) {
  const counts = Object.fromEntries(Object.keys(STATUS_FILTERS).map(k => [k, 0]));
  function walk(node, depth) {
    for (const key of Object.keys(STATUS_FILTERS)) {
      if (STATUS_FILTERS[key].match(node, depth)) counts[key]++;
    }
    (node.children || []).forEach(c => walk(c, depth + 1));
  }
  roots.forEach(r => walk(r, 0));
  return counts;
}

// ───────────────────────── The page ─────────────────────────

const MODE_LS_KEY = 'admin.agent_network.mode';

export default function AgentNetwork() {
  const [mode, setMode] = useState(() => localStorage.getItem(MODE_LS_KEY) || 'detailed');
  useEffect(() => { localStorage.setItem(MODE_LS_KEY, mode); }, [mode]);

  const [branchFilter, setBranchFilter] = useState('');
  const [textFilter, setTextFilter] = useState('');
  const [statusMode, setStatusMode] = useState('all');
  const [clientCountFilter, setClientCountFilter] = useState('all');
  const [expandedMap, setExpandedMap] = useState({});

  const { data, loading, refetch, dataAt } = useApi(
    '/api/agents/hierarchy',
    { query: { branch: branchFilter || undefined } },
    [branchFilter]
  );
  const { data: branches } = useApi('/api/agents/branches-with-counts', {}, []);
  // Auto-refresh every 45 s + on tab refocus. Without this, edits made on
  // Commission Tree (which writes to the same agent_products table) wouldn't
  // appear here until the admin manually reloaded the page.
  useAutoRefresh(refetch, 45_000);

  const roots = data?.roots || [];
  const bucketCounts = useMemo(() => countBuckets(roots), [roots]);

  // Predicate for the client-count bucket the user picked. Counts only the
  // agent's DIRECT clients (not the subtree total). Returns true to keep.
  const clientCountFn = (node) => {
    const n = Number(node.direct_clients_count || 0);
    switch (clientCountFilter) {
      case 'zero':    return n === 0;
      case 'lt10':    return n > 0 && n < 10;
      case 'lt20':    return n > 0 && n < 20;
      case 'gte10':   return n >= 10;
      case 'gte20':   return n >= 20;
      case 'gte50':   return n >= 50;
      default:        return true;  // 'all'
    }
  };

  // Text + (detailed-mode) status filter + client-count bucket filter.
  // Returns a Set<id> of visible node ids (null means "no filters active — show all").
  const visibleIds = useMemo(() => {
    const statusFn = STATUS_FILTERS[statusMode]?.match || (() => true);
    const q = textFilter.trim().toLowerCase();
    const hasText = !!q;
    const hasStatus = mode === 'detailed' && statusMode !== 'all';
    const hasClientCount = clientCountFilter !== 'all';
    if (!hasText && !hasStatus && !hasClientCount) return null;

    const visible = new Set();
    function textMatch(node) {
      if (!hasText) return true;
      return (node.name || '').toLowerCase().includes(q)
          || (node.email || '').toLowerCase().includes(q)
          || (node.branch || '').toLowerCase().includes(q);
    }
    function addSubtree(node) {
      visible.add(node.id);
      for (const c of (node.children || [])) addSubtree(c);
    }
    function walk(node, depth, ancestors) {
      const hits = textMatch(node)
        && (!hasStatus || statusFn(node, depth))
        && (!hasClientCount || clientCountFn(node));
      if (hits) {
        ancestors.forEach(a => visible.add(a));
        // When only a text filter is active, also reveal the subtree so you
        // get context around the match. When status or client-count is on,
        // keep it tight to the matching node.
        if (hasText && !hasStatus && !hasClientCount) addSubtree(node);
        else visible.add(node.id);
      }
      for (const c of (node.children || [])) walk(c, depth + 1, [...ancestors, node.id]);
    }
    roots.forEach(r => walk(r, 0, []));
    return visible;
  }, [roots, textFilter, statusMode, mode, clientCountFilter]);

  const filteredRoots = useMemo(() => {
    if (!visibleIds) return roots;
    function prune(node) {
      if (!visibleIds.has(node.id)) return null;
      return { ...node, children: (node.children || []).map(prune).filter(Boolean) };
    }
    return roots.map(prune).filter(Boolean);
  }, [roots, visibleIds]);

  // Tree expansion state
  function toggle(id) {
    setExpandedMap(m => ({ ...m, [id]: m[id] === false ? true : false }));
  }
  function expandAll() {
    const m = {};
    function walk(n) { m[n.id] = true; (n.children || []).forEach(walk); }
    roots.forEach(walk);
    setExpandedMap(m);
  }
  function collapseAll() {
    const m = {};
    function walk(n) { m[n.id] = false; (n.children || []).forEach(walk); }
    roots.forEach(walk);
    setExpandedMap(m);
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1>Agent Network</h1>
          <p className="muted">
            The full imported agent tree — same data, two ways to look at it. Switch modes with the
            toggle on the right. For earnings + waterfall analysis see <Link to="/admin/commission-tree">Commission Tree</Link>.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <LastUpdated dataAt={dataAt} loading={loading} />
          {/* Mode toggle */}
          <div
            role="tablist"
            aria-label="View mode"
            style={{
              display: 'inline-flex',
              background: 'var(--bg-elev-1)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-sm)',
              padding: 2,
              gap: 2,
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'compact'}
              className={`btn small ${mode === 'compact' ? '' : 'ghost'}`}
              onClick={() => setMode('compact')}
              title="Minimal tree — fastest to scan"
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <LayoutList size={12} /> Compact
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'detailed'}
              className={`btn small ${mode === 'detailed' ? '' : 'ghost'}`}
              onClick={() => setMode('detailed')}
              title="Cards with product chips + status filters"
              style={{ display: 'flex', alignItems: 'center', gap: 4 }}
            >
              <LayoutGrid size={12} /> Detailed
            </button>
          </div>

          <select
            className="input"
            value={branchFilter}
            onChange={e => setBranchFilter(e.target.value)}
            title="Filter top-level agents by branch. Children keep showing across branches."
            style={{ minWidth: 220 }}
          >
            <option value="">All branches ({data?.total_roots_unfiltered ?? data?.total_agents ?? 0})</option>
            {(branches || []).map(b => (
              <option key={b.branch} value={b.branch === '(no branch)' ? '' : b.branch}>
                {b.branch} — {b.agent_count} agent{b.agent_count === 1 ? '' : 's'}
                {b.code ? ` · ${b.code}` : ''}
              </option>
            ))}
          </select>
          <button className="btn ghost small" onClick={expandAll}>Expand all</button>
          <button className="btn ghost small" onClick={collapseAll}>Collapse all</button>
        </div>
      </header>

      {loading ? (
        <div className="muted pad">Loading agent network…</div>
      ) : (
        <>
          <section className="stat-row">
            <div className="stat">
              <div className="stat-label">Imported agents</div>
              <div className="stat-value">{data?.total_agents ?? 0}</div>
              <div className="stat-sub muted">in users table</div>
            </div>
            <div className="stat">
              <div className="stat-label">Top-level{branchFilter ? ` in ${branchFilter}` : ''}</div>
              <div className="stat-value">{data?.total_roots ?? 0}</div>
              <div className="stat-sub muted">
                {branchFilter
                  ? `of ${data?.total_roots_unfiltered ?? 0} across all branches`
                  : 'no parent above them'}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Branches</div>
              <div className="stat-value">{(branches || []).length}</div>
              <div className="stat-sub muted">with imported agents</div>
            </div>
            <div className="stat">
              <div className="stat-label">Product links</div>
              <div className="stat-value">{data?.total_links ?? 0}</div>
              <div className="stat-sub muted">rows in agent_products</div>
            </div>
          </section>

          {/* Status filter chips — only meaningful in Detailed mode (they need product data) */}
          {mode === 'detailed' && (
            <div className="h-filter-chips">
              {Object.entries(STATUS_FILTERS).map(([key, def]) => {
                const Icon = def.icon;
                const active = statusMode === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`h-filter-chip ${active ? 'active' : ''} ${def.tone ? `tone-${def.tone}` : ''}`}
                    onClick={() => setStatusMode(key)}
                    title={`Show only ${def.label.toLowerCase()} agents`}
                  >
                    <Icon size={12} />
                    <span>{def.label}</span>
                    <span className="h-filter-count mono">{bucketCounts[key] || 0}</span>
                  </button>
                );
              })}
            </div>
          )}

          <div className="filter-bar">
            <input
              className="input"
              placeholder="Filter by name, email, or branch…"
              value={textFilter}
              onChange={e => setTextFilter(e.target.value)}
              style={{ width: 320 }}
            />
            <select
              className="input"
              value={clientCountFilter}
              onChange={e => setClientCountFilter(e.target.value)}
              title="Filter agents by their direct client count"
              style={{ width: 200 }}
            >
              <option value="all">All client counts</option>
              <option value="zero">No direct clients</option>
              <option value="lt10">Less than 10 clients</option>
              <option value="lt20">Less than 20 clients</option>
              <option value="gte10">10+ clients</option>
              <option value="gte20">20+ clients</option>
              <option value="gte50">50+ clients</option>
            </select>
            {(textFilter || statusMode !== 'all' || clientCountFilter !== 'all') && (
              <button
                className="btn ghost small"
                onClick={() => { setTextFilter(''); setStatusMode('all'); setClientCountFilter('all'); }}
              >
                Clear filters
              </button>
            )}
            <div className="muted small" style={{ marginLeft: 'auto' }}>
              {(textFilter || statusMode !== 'all' || clientCountFilter !== 'all')
                ? `${filteredRoots.length} top-level visible${mode === 'detailed' && statusMode !== 'all' ? ` · ${STATUS_FILTERS[statusMode].label}` : ''}${clientCountFilter !== 'all' ? ` · ${clientCountFilter === 'zero' ? '0 clients' : clientCountFilter.replace('lt','<').replace('gte','≥')} clients` : ''}`
                : ''}
            </div>
          </div>

          {/* Tree render — one of two modes, but the same filtered data */}
          {filteredRoots.length === 0 ? (
            <div className="muted pad">{textFilter || statusMode !== 'all' ? 'No agents match those filters.' : 'No agents imported yet.'}</div>
          ) : mode === 'detailed' ? (
            <div className="hierarchy-tree">
              {filteredRoots.map(r => (
                <DetailedNode
                  key={r.id}
                  agent={r}
                  depth={0}
                  expandedMap={expandedMap}
                  onToggle={toggle}
                />
              ))}
            </div>
          ) : (
            <div className="card tree-card">
              <ul className="tree-ul tree-root">
                {filteredRoots.map((r, idx) => (
                  <CompactNode
                    key={r.id}
                    agent={r}
                    expanded={expandedMap}
                    onToggle={toggle}
                    isLast={idx === filteredRoots.length - 1}
                  />
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
