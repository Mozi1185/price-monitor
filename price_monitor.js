#!/usr/bin/env node
'use strict';

/**
 * Competitor Price Monitor
 * Usage: node price_monitor.js
 * Requires: npm install playwright && npx playwright install chromium
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PRODUCTS_FILE = path.resolve(__dirname, 'products.txt');
const CSV_FILE      = path.resolve(__dirname, 'price_report.csv');
const NAV_TIMEOUT   = 45000;
const WAIT_TIMEOUT  = 15000;

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function escapeCSV(value) {
  const str = (value === null || value === undefined) ? '' : String(value);
  return str.includes(',') || str.includes('"') || str.includes('\n')
    ? `"${str.replace(/"/g, '""')}"`
    : str;
}

function parseCSV(content) {
  const lines = content.trim().split('\n');
  if (lines.length < 2) return [];

  const headers = parseLine(lines[0]);

  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const values = parseLine(line);
      const row = {};
      headers.forEach((h, i) => { row[h] = values[i] ?? ''; });
      return row;
    });
}

function parseLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  values.push(current);
  return values;
}

function writeCSV(records) {
  const headers = ['timestamp', 'url', 'product_name', 'price'];
  const lines   = [headers.join(',')];

  for (const r of records) {
    lines.push([
      escapeCSV(r.timestamp),
      escapeCSV(r.url),
      escapeCSV(r.product_name),
      escapeCSV(r.price),
    ].join(','));
  }

  fs.writeFileSync(CSV_FILE, lines.join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Scraping
// ---------------------------------------------------------------------------

// Takealot product URLs have the form /slug/PLIDxxxxxx — extract the slug
// so we can detect when a PLID has been reassigned to a different product.
function extractSlug(rawUrl) {
  try {
    const parts = new URL(rawUrl).pathname.split('/').filter(Boolean);
    // parts[0] = slug, parts[1] = PLIDxxxxxx
    return parts[0] ?? '';
  } catch {
    return '';
  }
}

const TITLE_SELECTORS = [
  'h1.product-title',
  '[data-ref="product-title"]',
  'h1[itemprop="name"]',
  '[class*="pdp-header"] h1',
  '[class*="product-header"] h1',
  '[class*="product-title"]',
  'h1',
];

// Primary: Takealot's sticky-nav price element — populated for both in-stock
// and out-of-stock products once JS hydration completes.
// Fallback chain covers other layouts and generic ZAR price patterns.
const PRICE_SELECTORS = [
  '[class*="pdp-sticky-nav"][class*="price-buybox"]',
  '[class*="pdp-sticky-nav"][class*="price"]',
  '[data-ref="buybox-price"]',
  '[class*="buybox"] [class*="price"][class*="final"]',
  '[class*="buybox"] [class*="price"][class*="sell"]',
  '[class*="buybox"] [class*="price"]',
  '[itemprop="price"]',
  '[class*="price--final"]',
  '[class*="final-price"]',
  '[class*="selling-price"]',
  '[class*="sale-price"]',
  '[class*="current-price"]',
];

async function trySelector(page, selectors, validator) {
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const text = (await el.innerText()).trim();
      if (text && (!validator || validator(text))) return text;
    } catch {
      // selector failed — try next
    }
  }
  return null;
}

async function extractViaDOM(page) {
  return page.evaluate(() => {
    // Walk the DOM looking for the first visible text matching a ZAR price
    const priceRe = /R\s?[\d\s,]+(?:\.\d{2})?/;
    const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD']);

    function isVisible(el) {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' &&
             style.visibility !== 'hidden' &&
             style.opacity !== '0';
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent || skipTags.has(parent.tagName)) continue;
      const text = node.textContent.trim();
      const match = text.match(priceRe);
      if (match && isVisible(parent)) return match[0].replace(/\s+/g, ' ').trim();
    }
    return null;
  });
}

async function scrapeProduct(browser, url) {
  const context = await browser.newContext({
    userAgent:  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale:     'en-ZA',
    timezoneId: 'Africa/Johannesburg',
    viewport:   { width: 1440, height: 900 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-ZA,en;q=0.9',
    },
  });

  const page = await context.newPage();

  // Suppress unnecessary resource types to speed up page load
  await page.route('**/*.{woff,woff2,ttf,otf}', route => route.abort());
  await page.route('**/ads/**', route => route.abort().catch(() => {}));
  await page.route('**/tracking/**', route => route.abort().catch(() => {}));

  try {
    const initialSlug = extractSlug(url);

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout:   NAV_TIMEOUT,
    });

    if (!response) throw new Error('No response received from page');

    const status = response.status();
    if (status === 404) throw new Error('Product page returned 404 — URL may be invalid or product discontinued');
    if (status >= 400) throw new Error(`HTTP ${status} from product page`);

    // Waiting for h1 is the correct signal on Takealot: the JS router rewrites
    // the URL slug and populates the buybox only after React hydration, which
    // is what surfaces the h1 element.
    try {
      await page.waitForSelector('h1', { timeout: WAIT_TIMEOUT });
    } catch {
      // Continue anyway — title will fall back to <title> tag
    }

    // Short settle for price elements that render after the title
    await page.waitForTimeout(1500);

    // Detect PLID reassignment: if the slug in the final URL differs from the
    // slug we requested, Takealot has reused this PLID for a different product.
    const finalUrl  = page.url();
    const finalSlug = extractSlug(finalUrl);
    const reassigned = initialSlug && finalSlug && initialSlug !== finalSlug;

    const productName = await trySelector(page, TITLE_SELECTORS)
      ?? await page.title().then(t => t.replace(/ \|.*$/i, '').trim())
      ?? 'Unknown';

    const isZARPrice = (text) => /R\s?[\d,]/.test(text);

    const price = await trySelector(page, PRICE_SELECTORS, isZARPrice)
      ?? await extractViaDOM(page)
      ?? 'Not found';

    // Normalise price string — strip extra lines, collapse whitespace
    const normalisedPrice = price
      .split('\n')[0]
      .replace(/\s+/g, ' ')
      .trim();

    // Detect out-of-stock via body text
    const bodyText   = await page.evaluate(() => document.body.innerText);
    const outOfStock = /supplier out of stock|out of stock|not available/i.test(bodyText);

    return { url, productName, price: normalisedPrice, reassigned, finalSlug, outOfStock, error: null };

  } catch (err) {
    return { url, productName: null, price: null, error: err.message };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Previous-price index — latest record wins per URL
// ---------------------------------------------------------------------------

function loadPreviousPrices() {
  if (!fs.existsSync(CSV_FILE)) return { index: {}, records: [] };

  try {
    const records = parseCSV(fs.readFileSync(CSV_FILE, 'utf8'));
    const index   = {};
    for (const r of records) {
      // Overwrite so the last (most recent) entry for each URL survives
      if (r.url && r.price && !r.price.startsWith('ERROR')) {
        index[r.url] = r.price;
      }
    }
    return { index, records };
  } catch (err) {
    console.warn(`  Warning: could not parse existing CSV — ${err.message}`);
    return { index: {}, records: [] };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!fs.existsSync(PRODUCTS_FILE)) {
    console.error(`Error: ${PRODUCTS_FILE} not found.`);
    process.exit(1);
  }

  const urls = fs.readFileSync(PRODUCTS_FILE, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));

  if (urls.length === 0) {
    console.error('Error: No URLs found in products.txt');
    process.exit(1);
  }

  console.log('\nCompetitor Price Monitor');
  console.log('========================');
  console.log(`Products to check : ${urls.length}`);
  console.log(`Timestamp         : ${new Date().toLocaleString('en-ZA')}\n`);

  const { index: previousPrices, records: historicalRecords } = loadPreviousPrices();

  if (Object.keys(previousPrices).length > 0) {
    console.log(`Loaded ${historicalRecords.length} historical record(s) from ${path.basename(CSV_FILE)}\n`);
  }

  const timestamp    = new Date().toISOString();
  const newRecords   = [];
  const priceChanges = [];
  const reassignments = [];
  const errors       = [];
  let   successCount = 0;

  const browser = await chromium.launch({ headless: true });

  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      process.stdout.write(`[${i + 1}/${urls.length}] ${url}\n`);

      const result = await scrapeProduct(browser, url);

      if (result.error) {
        console.log(`  ERROR    : ${result.error}\n`);
        errors.push({ url, message: result.error });
        newRecords.push({
          timestamp,
          url,
          product_name: 'ERROR',
          price:        `ERROR: ${result.error}`,
        });
        continue;
      }

      console.log(`  Product  : ${result.productName}`);
      console.log(`  Price    : ${result.price}`);

      if (result.outOfStock) {
        console.log(`  Stock    : OUT OF STOCK`);
      }

      if (result.reassigned) {
        console.log(`  WARNING  : PLID reassigned — URL now resolves to "${result.finalSlug}"`);
        console.log(`             Update products.txt with the correct current URL for this product.`);
        reassignments.push({ url, newSlug: result.finalSlug, productName: result.productName });
      }

      const prev = previousPrices[url];
      if (prev) {
        if (prev !== result.price) {
          console.log(`  CHANGED  : ${prev}  ->  ${result.price}  *** PRICE CHANGE ***`);
          priceChanges.push({
            url,
            productName: result.productName,
            oldPrice:    prev,
            newPrice:    result.price,
          });
        } else {
          console.log(`  Status   : No change (${prev})`);
        }
      } else {
        console.log(`  Status   : First record — no previous price to compare`);
      }

      console.log('');
      successCount++;

      newRecords.push({
        timestamp,
        url,
        product_name: result.productName,
        price:        result.price,
      });
    }
  } finally {
    await browser.close();
  }

  // Append new records to historical data and write CSV
  writeCSV([...historicalRecords, ...newRecords]);

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  const sep = '='.repeat(55);
  console.log(sep);
  console.log('SUMMARY');
  console.log(sep);
  console.log(`Products checked  : ${urls.length}`);
  console.log(`Successful        : ${successCount}`);
  console.log(`Errors            : ${errors.length}`);
  console.log(`Price changes     : ${priceChanges.length}`);
  console.log(`PLID reassignments: ${reassignments.length}`);
  console.log(`Report saved to   : ${CSV_FILE}`);

  if (errors.length > 0) {
    console.log('\nERRORS:');
    console.log('-'.repeat(55));
    for (const e of errors) {
      console.log(`  ${e.url}`);
      console.log(`  ${e.message}\n`);
    }
  }

  if (reassignments.length > 0) {
    console.log('\nPLID REASSIGNMENTS — UPDATE products.txt:');
    console.log('-'.repeat(55));
    for (const r of reassignments) {
      console.log(`  Was  : ${r.url}`);
      console.log(`  Now  : ${r.newSlug} (product: ${r.productName})\n`);
    }
  }

  if (priceChanges.length > 0) {
    console.log('\nPRICE CHANGES DETECTED:');
    console.log('-'.repeat(55));
    for (const c of priceChanges) {
      console.log(`  ${c.productName}`);
      console.log(`  ${c.url}`);
      console.log(`  Old: ${c.oldPrice}`);
      console.log(`  New: ${c.newPrice}\n`);
    }
  } else if (successCount > 0) {
    console.log('\nNo price changes detected.');
  }

  console.log('');
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
