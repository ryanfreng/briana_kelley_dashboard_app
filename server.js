// server.js
// Single Node process that:
//   1. Serves the static dashboard HTML at /clients/:slug
//   2. Exposes /api/client-dashboard/:slug, which assembles JSON from Notion
//
// Deploy target: Sevalla Application (Nixpacks). Sevalla sets PORT for us.

const express = require('express');
const path = require('path');
const { Client } = require('@notionhq/client');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.NOTION_TOKEN) {
  console.warn('[startup] NOTION_TOKEN is not set. /api/client-dashboard will return 500.');
}

const notion = new Client({ auth: process.env.NOTION_TOKEN });

// -------------------------------------------------------------
// Client registry. Add new retainer clients by appending entries.
// Data source IDs are shared across clients (workbook, social cal,
// master cal, tasks); project / client / brandscript IDs are
// per-client. All values come from environment variables.
// -------------------------------------------------------------
const CLIENTS = {
  briana: {
    projectId:        process.env.BRIANA_PROJECT_ID,
    clientId:         process.env.BRIANA_CLIENT_ID,
    brandscriptId:    process.env.BRIANA_BRANDSCRIPT_ID,
    // Notion data source IDs (UUID with dashes). In Notion's current
    // API a database can have multiple data sources, and queries go
    // through the data source endpoint.
    workbookDsId:     process.env.RETAINER_WORKBOOK_DATA_SOURCE_ID,
    socialCalDsId:    process.env.SOCIAL_MEDIA_CALENDAR_DATA_SOURCE_ID,
    masterCalDsId:    process.env.MASTER_CALENDAR_DATA_SOURCE_ID,
    tasksDsId:        process.env.TASKS_DATA_SOURCE_ID,
    displayName:      'Briana Kelley Realty',
    tagline:          'List with strategy. Close with confidence.',
    retainer:         'Accelerate Retainer Phase 2 (Trust & Conversion)',
    teamLead:         'Ryan Freng (Creative Director)',
  },
};

// Notion API version that exposes the data sources endpoints.
const NOTION_VERSION = '2025-09-03';

async function queryDataSource(dataSourceId, body = {}) {
  const r = await fetch(`https://api.notion.com/v1/data_sources/${dataSourceId}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let err = {};
    try { err = await r.json(); } catch (_) {}
    throw new Error(`Notion data source query failed (${r.status}): ${err.message || r.statusText}`);
  }
  return r.json();
}

// Wraps a fetcher so a single failure (e.g. one database not shared with
// the integration, or a property name mismatch) doesn't crash the whole
// response. The other sections still render.
async function safeSection(label, fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[section:${label}] ${err.message}`);
    return fallback;
  }
}

// -------------------------------------------------------------
// In-memory cache, 5 minute TTL.
// -------------------------------------------------------------
const CACHE = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached(key) {
  const hit = CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.storedAt > CACHE_TTL_MS) {
    CACHE.delete(key);
    return null;
  }
  return hit.value;
}

function setCached(key, value) {
  CACHE.set(key, { storedAt: Date.now(), value });
}

// -------------------------------------------------------------
// Routes
// -------------------------------------------------------------

app.use('/clients', express.static(path.join(__dirname, 'public', 'clients')));

app.get('/healthz', (_req, res) => res.status(200).json({ ok: true }));

app.get('/', (_req, res) => {
  const slugs = Object.keys(CLIENTS);
  res.type('html').send(
    `<h1>Backflip Client Dashboards</h1>` +
    `<ul>${slugs.map(s => `<li><a href="/clients/${s}/">${CLIENTS[s].displayName}</a></li>`).join('')}</ul>`
  );
});

app.get('/api/client-dashboard/:slug', async (req, res) => {
  const slug = req.params.slug;
  const cfg = CLIENTS[slug];
  if (!cfg) return res.status(404).json({ error: 'Unknown client' });

  const cached = getCached(slug);
  if (cached) {
    res.set('X-Dashboard-Cache', 'HIT');
    return res.status(200).json(cached);
  }

  try {
    const data = await assembleDashboard(cfg);
    setCached(slug, data);
    res.set('X-Dashboard-Cache', 'MISS');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[dashboard] assembly failed:', err);
    return res.status(500).json({
      error: 'Dashboard assembly failed',
      message: err.message || String(err),
    });
  }
});

app.listen(PORT, () => {
  console.log(`[startup] Listening on :${PORT}`);
});

// =============================================================
// Notion assembly
// =============================================================

async function assembleDashboard(cfg) {
  const [
    projectPage,
    shoots,
    inFlight,
    recentContent,
    reports,
    approvals,
  ] = await Promise.all([
    safeSection('projectPage', () =>
      cfg.projectId ? notion.pages.retrieve({ page_id: cfg.projectId }) : Promise.resolve(null), null),
    safeSection('shoots',         () => fetchShoots(cfg),         { upcoming: [], recent: [] }),
    safeSection('inFlight',       () => fetchInFlight(cfg),       []),
    safeSection('recentContent',  () => fetchRecentContent(cfg),  []),
    safeSection('reports',        () => fetchReports(cfg),        { current: null, previous: null }),
    safeSection('approvals',      () => fetchApprovals(cfg),      []),
  ]);

  return {
    client: {
      name: cfg.displayName,
      tagline: cfg.tagline,
      retainer: cfg.retainer,
      period: `Reporting through ${reports.current?.month || 'current month'}`,
      teamLead: cfg.teamLead,
      frameioUrl: extractProp(projectPage, 'Frame.io', 'url') || '#',
      basecampUrl: extractProp(projectPage, 'Basecamp URL', 'url') || '#',
    },
    strategy: getStaticBrandscript(),
    weeklyRhythm: getStaticWeeklyRhythm(),
    campaignProgress: [],
    shoots,
    inFlight,
    recentContent,
    currentReport: reports.current,
    previousReport: reports.previous,
    approvals,
  };
}

// -------------------------------------------------------------
// Master Calendar -> Shoots
// -------------------------------------------------------------
async function fetchShoots(cfg) {
  if (!cfg.masterCalDsId || !cfg.projectId) return { upcoming: [], recent: [] };

  const r = await queryDataSource(cfg.masterCalDsId, {
    filter: {
      and: [
        { property: 'Project', relation: { contains: cfg.projectId } },
        { property: 'Tags',    multi_select: { contains: '🎥 Shoot' } },
      ],
    },
    sorts: [{ property: 'Date', direction: 'ascending' }],
  });

  const today = new Date().toISOString().slice(0, 10);
  const upcoming = [];
  const past = [];
  for (const p of r.results) {
    const d = p.properties?.Date?.date?.start;
    if (!d) continue;
    (d >= today ? upcoming : past).push(toShoot(p));
  }
  past.reverse();
  return { upcoming, recent: past.slice(0, 4) };
}

function toShoot(p) {
  return {
    name: getTitle(p),
    date: p.properties?.Date?.date?.start || null,
    location: extractProp(p, 'Location', 'rich_text') || '',
  };
}

// -------------------------------------------------------------
// Master Calendar -> In Flight (non-shoot work)
// -------------------------------------------------------------
async function fetchInFlight(cfg) {
  if (!cfg.masterCalDsId || !cfg.projectId) return [];

  const r = await queryDataSource(cfg.masterCalDsId, {
    filter: {
      and: [
        { property: 'Project',  relation: { contains: cfg.projectId } },
        { property: 'Complete', checkbox: { equals: false } },
      ],
    },
  });

  return r.results
    .filter(p => !(p.properties?.Tags?.multi_select || []).some(t => t.name === '🎥 Shoot'))
    .map(p => {
      const title = getTitle(p);
      const icon  = leadingIcon(title);
      return {
        icon,
        category: iconToCategory(icon),
        title: title.replace(/^\S+\s*/, '').trim() || title,
        status: extractProp(p, 'Description', 'rich_text') || 'In progress',
        target: formatDateRange(p.properties?.Deadline?.date),
      };
    })
    .filter(it => it.category); // drop unknown-icon (internal-only) items
}

// -------------------------------------------------------------
// Social Calendar -> Recent Content (last 30 days)
// -------------------------------------------------------------
async function fetchRecentContent(cfg) {
  if (!cfg.socialCalDsId || !cfg.projectId) return [];

  const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const r = await queryDataSource(cfg.socialCalDsId, {
    filter: {
      and: [
        { property: '🎉 Project', relation: { contains: cfg.projectId } },
        { property: 'Publish Date',         date:     { on_or_after: since } },
      ],
    },
    sorts: [{ property: 'Publish Date', direction: 'descending' }],
  });

  return r.results.map(p => ({
    date:   p.properties?.['Publish Date']?.date?.start || null,
    title:  getTitle(p),
    format: (p.properties?.['Type of Post']?.multi_select || []).map(t => t.name).join(', '),
    stage:  p.properties?.['Funnel Stage']?.select?.name || 'TBD',
    status: p.properties?.Status?.status?.name || 'Planned',
  }));
}

// -------------------------------------------------------------
// Retainer Workbook -> current + previous Monthly Report
// -------------------------------------------------------------
async function fetchReports(cfg) {
  if (!cfg.workbookDsId || !cfg.clientId) return { current: null, previous: null };

  const r = await queryDataSource(cfg.workbookDsId, {
    filter: {
      and: [
        { property: 'Type',   select:   { equals: 'Monthly Report' } },
        { property: 'Client', relation: { contains: cfg.clientId } },
      ],
    },
    sorts: [{ property: 'Date', direction: 'descending' }],
    page_size: 2,
  });

  const current  = r.results[0] ? await assembleReport(r.results[0]) : null;
  const previous = r.results[1] ? await assembleReport(r.results[1]) : null;
  return { current, previous };
}

async function assembleReport(page) {
  const props = page.properties || {};
  const metrics = {
    fbReach:            num(props['FB Reach']),
    fbImpressions:      num(props['FB Impressions']),
    fbEngagement:       num(props['FB Engagement']),
    fbFollowers:        num(props['FB Followers']),
    igFollowers:        num(props['IG Followers']),
    igEngagement:       num(props['IG Engagement']),
    tiktokViews:        num(props['TikTok Video Views']),
    tiktokFollowers:    num(props['TikTok Followers']),
    postsShipped:       num(props['Posts Shipped']),
    totalAdSpend:       num(props['Total Ad Spend']),
    totalConversations: num(props['Total Conversations']),
  };
  const month = formatMonth(props.Date?.date?.start);
  const commitmentsMet = mapStatus(props['Commitments met']?.select?.name);

  const body = await fetchBlockChildren(page.id);
  const sections = await parseReportBody(body);

  return {
    month,
    metrics,
    commitmentsMet,
    topPosts:    sections['Top Posts']                   || [],
    audience:    sections['Audience']                    || { summary: '', topCities: [] },
    ads:         sections['Ads']                         || [],
    adsNote:     sections['Ads Note']                    || '',
    dataNotes:   sections['Data Notes']                  || '',
    learned:     sections['What We Learned']             || '',
    testingNext: sections["What We're Testing Next"]     || '',
  };
}

// -------------------------------------------------------------
// Tasks -> Waiting on Client
// -------------------------------------------------------------
async function fetchApprovals(cfg) {
  if (!cfg.tasksDsId || !cfg.projectId) return [];

  const r = await queryDataSource(cfg.tasksDsId, {
    filter: {
      and: [
        { property: 'Project', relation: { contains: cfg.projectId } },
        { property: 'Status',  status:   { equals: 'Waiting on Client' } },
      ],
    },
    sorts: [{ property: 'Due Date', direction: 'ascending' }],
  });

  return r.results.map(p => ({
    title:   getTitle(p),
    dueDate: p.properties?.['Due Date']?.date?.start || null,
    link:    p.url,
  }));
}

// =============================================================
// Block-walking + section parsing for Monthly Report bodies
// =============================================================

async function fetchBlockChildren(blockId) {
  const out = [];
  let cursor;
  do {
    const r = await notion.blocks.children.list({
      block_id: blockId,
      page_size: 100,
      start_cursor: cursor,
    });
    out.push(...r.results);
    cursor = r.has_more ? r.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function parseReportBody(blocks) {
  const sections = {};
  let currentHeading = null;
  let currentBlocks = [];

  const flush = async () => {
    if (currentHeading) {
      sections[currentHeading] = await renderSection(currentHeading, currentBlocks);
    }
  };

  for (const b of blocks) {
    if (b.type === 'heading_2') {
      await flush();
      currentHeading = b.heading_2.rich_text.map(t => t.plain_text).join('').trim();
      currentBlocks = [];
    } else {
      currentBlocks.push(b);
    }
  }
  await flush();
  return sections;
}

async function renderSection(name, blocks) {
  switch (name) {
    case 'Top Posts':
      return parseTopPostsTable(blocks);
    case 'Audience':
      return parseAudienceSection(blocks);
    case 'Ads':
      return parseAdsTable(blocks);
    default:
      return blocks
        .filter(b => b.type === 'paragraph')
        .map(b => (b.paragraph.rich_text || []).map(t => t.plain_text).join(''))
        .filter(Boolean)
        .join('\n\n');
  }
}

async function parseTopPostsTable(blocks) {
  const table = blocks.find(b => b.type === 'table');
  if (!table) return [];
  const rows = await readTableRows(table.id);
  const [, ...data] = rows;
  return data.map((row, i) => ({
    rank:       row[0] || String(i + 1),
    title:      row[1] || '',
    date:       row[2] || '',
    reach:      row[3] || '',
    engagement: row[4] || '',
    note:       row[5] || '',
  }));
}

async function parseAudienceSection(blocks) {
  const paragraphs = blocks
    .filter(b => b.type === 'paragraph')
    .map(b => (b.paragraph.rich_text || []).map(t => t.plain_text).join(''))
    .filter(Boolean);
  const summary = paragraphs.join('\n\n');

  const table = blocks.find(b => b.type === 'table');
  if (!table) return { summary, topCities: [] };

  const rows = await readTableRows(table.id);
  const [, ...data] = rows;
  const topCities = data.map(row => ({
    city:      row[0] || '',
    followers: row[1] || '',
  }));
  return { summary, topCities };
}

async function parseAdsTable(blocks) {
  const table = blocks.find(b => b.type === 'table');
  if (!table) return [];
  const rows = await readTableRows(table.id);
  const [, ...data] = rows;
  return data.map(row => ({
    campaign:      row[0] || '',
    spend:         row[1] || '',
    result:        row[2] || '',
    costPerResult: row[3] || '',
  }));
}

async function readTableRows(tableBlockId) {
  const children = await fetchBlockChildren(tableBlockId);
  return children
    .filter(b => b.type === 'table_row')
    .map(row => (row.table_row.cells || []).map(cell =>
      (cell || []).map(t => t.plain_text).join('')
    ));
}

// =============================================================
// Static config (these change rarely; edit and redeploy)
// =============================================================

function getStaticBrandscript() {
  return {
    sentence:
      'Kelley Realty helps homeowners sell lake homes and $500K+ properties with a clear strategy ' +
      'built before the home ever hits the market, so sellers walk away confident they received ' +
      'the strongest possible outcome.',
    personas: [
      'Legacy Sellers (Roger & Linda)',
      'Remote Inheritor (Todd)',
      'Strategic Upgraders (Karen & Steve)',
    ],
    plan: [
      'Strategic positioning, built before the home hits the market',
      'Pre-list preparation, targeted launch',
      'Calm negotiation, confident close',
    ],
  };
}

function getStaticWeeklyRhythm() {
  return [
    { day: 'Monday',    type: 'Educational',  description: 'Strategic listing process: how Briana thinks about pricing, prep, timing.' },
    { day: 'Wednesday', type: 'Seller Tip',   description: 'Specific, actionable seller advice. Often the Pain Point series format.' },
    { day: 'Friday',    type: 'Story',        description: 'Briana behind the business: personal POV, lake lifestyle, behind the scenes.' },
  ];
}

// =============================================================
// Small utilities
// =============================================================

function getTitle(page) {
  const titleProp = page && Object.values(page.properties || {}).find(p => p.type === 'title');
  return (titleProp?.title || []).map(t => t.plain_text).join('');
}

function extractProp(page, name, type) {
  if (!page) return null;
  const p = page.properties?.[name];
  if (!p) return null;
  if (type === 'url')        return p.url || null;
  if (type === 'rich_text')  return (p.rich_text || []).map(t => t.plain_text).join('');
  return null;
}

function num(prop) {
  if (!prop) return null;
  return typeof prop.number === 'number' ? prop.number : null;
}

function formatMonth(dateStr) {
  if (!dateStr) return '';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function formatDateRange(date) {
  if (!date) return '';
  const start = new Date(date.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (!date.end) return start;
  const end = new Date(date.end).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${start} to ${end}`;
}

function mapStatus(notionStatus) {
  if (!notionStatus) return 'ontrack';
  if (/Off\s*Track/i.test(notionStatus)) return 'offtrack';
  if (/Watch/i.test(notionStatus))       return 'watch';
  if (/On\s*Track/i.test(notionStatus))  return 'ontrack';
  return 'ontrack';
}

function leadingIcon(title) {
  const match = title.match(/^[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2700}-\u{27BF}]/u);
  return match ? match[0] : '';
}

function iconToCategory(icon) {
  return {
    '🎥': 'Shoots',
    '🖥️': 'Website',
    '🖥':  'Website',
    '📱':  'Social media',
    '📼':  'Editing',
    '✏️': 'Messaging',
    '✏':  'Messaging',
    '💰':  'Ads',
  }[icon] || null;
}
