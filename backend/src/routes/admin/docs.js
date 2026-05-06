/**
 * Admin — In-Portal Docs — /api/admin/docs
 *
 * Serves the project's markdown documentation files (OPERATIONS_GUIDE.md +
 * DATA_FLOW.md) so admins can read them inside the portal instead of
 * having to clone the repo or open files on disk.
 *
 * Allow-list approach: only specific filenames are servable. Path traversal
 * (../) is structurally impossible because the slug → filename map is
 * hard-coded.
 *
 * Endpoints:
 *   GET /api/admin/docs            — list available docs
 *   GET /api/admin/docs/:slug      — raw markdown text for that doc
 */
import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { authenticate, requirePermission } from '../../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Project root = ../../../../ from this file (src/routes/admin/docs.js)
const PROJECT_ROOT = resolve(__dirname, '../../../..');

const DOCS = {
  // Listed in order from least-technical to most-technical so the docs page
  // greets non-developers with the right starting point.
  'owner-handbook': {
    file: 'OWNER_HANDBOOK.md',
    title: 'Owner Handbook',
    description: 'Plain-language guide for the people running this portal day-to-day. No coding background needed. Start here.',
  },
  'operations-guide': {
    file: 'OPERATIONS_GUIDE.md',
    title: 'Operations Guide',
    description: 'Detailed page-by-page button reference — what every click does, CRM/bridge cost, and troubleshooting workflows.',
  },
  'data-flow': {
    file: 'DATA_FLOW.md',
    title: 'Data Flow',
    description: 'Plain-English guide to where data comes from, where it goes, and how the pieces fit together.',
  },
  'architecture': {
    file: 'ARCHITECTURE.md',
    title: 'Architecture',
    description: 'System architect view — components, target shape, and the gating layers that protect external systems.',
  },
};

const router = Router();
router.use(authenticate, requirePermission('portal.admin'));

// GET /api/admin/docs — list
router.get('/', (req, res) => {
  res.json(
    Object.entries(DOCS).map(([slug, meta]) => ({
      slug,
      title: meta.title,
      description: meta.description,
    }))
  );
});

// GET /api/admin/docs/:slug — raw markdown content
router.get('/:slug', async (req, res, next) => {
  try {
    const meta = DOCS[req.params.slug];
    if (!meta) return res.status(404).json({ error: 'Doc not found' });
    const path = resolve(PROJECT_ROOT, meta.file);
    let content;
    try {
      content = await readFile(path, 'utf8');
    } catch (err) {
      return res.status(404).json({
        error: `Doc file not found at ${meta.file}`,
        hint: 'The file may not be present in this deployment. Confirm the project root copy includes the latest docs.',
      });
    }
    res.json({
      slug: req.params.slug,
      title: meta.title,
      description: meta.description,
      content,
    });
  } catch (err) { next(err); }
});

export default router;
