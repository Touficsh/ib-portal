import { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { BookOpen, FileText, Cpu, Search } from 'lucide-react';
import { useApi } from '../../hooks/useApi.js';

/**
 * Admin — Docs.
 *
 * Renders the project's markdown docs (OPERATIONS_GUIDE.md, DATA_FLOW.md,
 * ARCHITECTURE.md) inline as a single-page reference. Uses react-markdown
 * with GFM (tables, strikethrough, task-lists). Fetches raw markdown from
 * /api/admin/docs/:slug — the backend reads from disk on demand so docs
 * stay in sync with the repo without duplicating content.
 *
 * Features:
 *   - Tabs across the three docs
 *   - Inline search across the active doc (Ctrl+F also works natively)
 *   - URL-bookmarkable (`?doc=operations-guide`)
 */

const TAB_ICONS = {
  'operations-guide': BookOpen,
  'data-flow':        FileText,
  'architecture':     Cpu,
};

function highlight(text, needle) {
  if (!needle) return text;
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark style={{ background: 'var(--warn-soft)', color: 'var(--text-primary)', padding: 0 }}>
        {text.slice(idx, idx + needle.length)}
      </mark>
      {text.slice(idx + needle.length)}
    </>
  );
}

export default function Docs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState('');

  const { data: catalog } = useApi('/api/admin/docs', {}, []);
  const tabs = catalog || [];

  // Default to operations-guide; honor ?doc=... if present and valid
  const activeSlug = useMemo(() => {
    const requested = searchParams.get('doc');
    if (requested && tabs.some(t => t.slug === requested)) return requested;
    if (tabs.length > 0) return tabs[0].slug;
    return null;
  }, [searchParams, tabs]);

  const { data: doc, loading, error } = useApi(
    activeSlug ? `/api/admin/docs/${activeSlug}` : null,
    {},
    [activeSlug]
  );

  function pickTab(slug) {
    const next = new URLSearchParams(searchParams);
    next.set('doc', slug);
    setSearchParams(next, { replace: true });
    setQ('');  // reset search per tab
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Filter the doc content client-side when the user types in the search.
  // Naive filter: only keep paragraph blocks that contain the needle. Lossy
  // but useful for quickly finding "where does it talk about Refresh MT5".
  const filteredContent = useMemo(() => {
    if (!doc?.content) return '';
    if (!q.trim()) return doc.content;
    const needle = q.toLowerCase();
    // Keep section headers + any block within a section that contains the needle
    const lines = doc.content.split('\n');
    const out = [];
    let currentSection = [];
    let sectionMatches = false;
    let inCodeBlock = false;
    const flush = () => {
      if (sectionMatches) out.push(...currentSection);
      currentSection = [];
      sectionMatches = false;
    };
    for (const line of lines) {
      // Toggle code block state so we don't break code formatting
      if (line.startsWith('```')) inCodeBlock = !inCodeBlock;
      // Section boundaries (only outside code blocks)
      if (!inCodeBlock && /^#{1,3}\s/.test(line)) {
        flush();
        currentSection.push(line);
        if (line.toLowerCase().includes(needle)) sectionMatches = true;
        continue;
      }
      currentSection.push(line);
      if (line.toLowerCase().includes(needle)) sectionMatches = true;
    }
    flush();
    return out.length > 0 ? out.join('\n') : `_No matches for "${q}" in this doc._`;
  }, [doc?.content, q]);

  return (
    <div>
      <header className="page-header">
        <div>
          <h1><BookOpen size={18} style={{ verticalAlign: -3, marginRight: 8 }} />Docs</h1>
          <p className="muted">
            In-portal reference for how the system works. These render the project's
            markdown files live — to update them, edit the corresponding <code>.md</code> at
            the repo root.
          </p>
        </div>
      </header>

      {/* Tab bar */}
      <div className="tab-row" style={{ marginBottom: 'var(--space-3)', flexWrap: 'wrap' }}>
        {tabs.map(t => {
          const Icon = TAB_ICONS[t.slug] || FileText;
          return (
            <button
              key={t.slug}
              type="button"
              className={`tab-btn ${activeSlug === t.slug ? 'active' : ''}`}
              onClick={() => pickTab(t.slug)}
              title={t.description}
            >
              <Icon size={12} style={{ verticalAlign: -1, marginRight: 6 }} />
              {t.title}
            </button>
          );
        })}
      </div>

      {/* Inline search — limits the rendered markdown to sections containing
          the needle. Keeps the page fast for big docs. */}
      <div className="filter-bar" style={{ marginBottom: 'var(--space-3)' }}>
        <Search size={14} className="muted" />
        <input
          className="input"
          placeholder={`Search within ${doc?.title || 'this doc'}…`}
          value={q}
          onChange={e => setQ(e.target.value)}
          style={{ maxWidth: 360 }}
        />
        {q && (
          <button className="btn ghost small" onClick={() => setQ('')}>Clear</button>
        )}
        <span className="muted small" style={{ marginLeft: 'auto' }}>
          {doc?.description}
        </span>
      </div>

      {error && <div className="alert error">Failed to load doc: {error.message}</div>}
      {loading && !doc && <div className="muted pad">Loading…</div>}

      {/* Render */}
      {doc?.content && (
        <article className="card markdown-body" style={{ padding: '24px 32px', lineHeight: 1.6 }}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ node, ...props }) => <h1 style={{ marginTop: 0 }} {...props} />,
              h2: ({ node, ...props }) => <h2 style={{ borderBottom: '1px solid var(--border)', paddingBottom: 4, marginTop: 'var(--space-4)' }} {...props} />,
              code: ({ inline, className, children, ...props }) => (
                inline
                  ? <code style={{ background: 'var(--bg-tertiary)', padding: '1px 6px', borderRadius: 4, fontSize: '0.9em' }} {...props}>{children}</code>
                  : <pre style={{ background: 'var(--bg-tertiary)', padding: 12, borderRadius: 6, overflowX: 'auto', fontSize: 12 }}><code {...props}>{children}</code></pre>
              ),
              table: ({ node, ...props }) => (
                <div style={{ overflowX: 'auto', marginBottom: 'var(--space-3)' }}>
                  <table className="table" {...props} />
                </div>
              ),
              blockquote: ({ node, ...props }) => (
                <blockquote
                  style={{
                    borderLeft: '3px solid var(--accent)',
                    margin: 'var(--space-3) 0',
                    padding: '8px 16px',
                    background: 'var(--bg-tertiary)',
                    color: 'var(--text-secondary)',
                  }}
                  {...props}
                />
              ),
            }}
          >
            {filteredContent}
          </ReactMarkdown>
        </article>
      )}
    </div>
  );
}
