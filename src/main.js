import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

// ============================================================
// INPUT
// ============================================================
const input = await Actor.getInput() || {};

const searchQuery    = input.searchQuery    || '';
const location       = input.location       || 'Bangalore, India';
const industryFilter = input.industryFilter || '';
const minEmployees   = input.minEmployees   ?? 0;
const maxEmployees   = input.maxEmployees   ?? Infinity;
const numResults     = Math.min(input.numResults ?? 50, 500);
const useProxy       = input.useProxy       ?? true;

function buildSearchUrl() {
    const q = searchQuery
        ? `${searchQuery} ${location}`
        : industryFilter
            ? `${industryFilter} companies ${location}`
            : `companies ${location}`;
    return `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
}

const startUrl = buildSearchUrl();

// ============================================================
// PROXY
// ============================================================
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

// ============================================================
// HELPERS
// ============================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function humanWait(min = 800, max = 1800) {
    await sleep(Math.floor(Math.random() * (max - min + 1)) + min);
}

async function dismissPopups(page) {
    const selectors = [
        'button[aria-label="Close"]',
        'button[aria-label="Dismiss"]',
        'button:has-text("Accept all")',
        'button:has-text("I agree")',
        'button:has-text("Reject all")',
        'button:has-text("No thanks")',
    ];
    for (const sel of selectors) {
        try {
            const btn = await page.$(sel);
            if (btn) { await btn.click(); await humanWait(300, 600); }
        } catch { /* ignore */ }
    }
}

// ============================================================
// STEP 1 — SCROLL MAPS PANEL & COLLECT PLACE LINKS
// ============================================================
async function collectPlaceLinks(page, log, maxCount) {
    const feedSel = 'div[role="feed"]';

    try {
        await page.waitForSelector(feedSel, { timeout: 20000 });
    } catch {
        log.warning('Feed panel not found — might be a single result page.');
        return [page.url()];
    }

    await humanWait(1500, 2500);

    let prevCount   = 0;
    let stableTries = 0;

    while (true) {
        await dismissPopups(page);

        const cards = await page.$$('a[href^="https://www.google.com/maps/place"]');
        const count = cards.length;
        log.info(`  Panel results loaded: ${count}`);

        if (count >= maxCount) break;

        if (count === prevCount) stableTries++;
        else stableTries = 0;

        if (stableTries >= 5) {
            log.info('  No more results loading — panel exhausted.');
            break;
        }

        prevCount = count;

        await page.evaluate((sel) => {
            const feed = document.querySelector(sel);
            if (feed) feed.scrollBy(0, 15000);
        }, feedSel);

        await humanWait(1300, 2200);
    }

    const links = await page.$$eval(
        'a[href^="https://www.google.com/maps/place"]',
        (els) => [...new Set(els.map((e) => e.href))]
    );

    return links;
}

// ============================================================
// STEP 2 — SCRAPE GOOGLE MAPS PLACE PAGE
// ============================================================
async function scrapeMapsPlace(page) {
    return await page.evaluate(() => {
        const text = (sel) => {
            const el = document.querySelector(sel);
            return el ? el.textContent.trim() : '';
        };

        // Company Name
        const name = text('h1.DUwDvf') || text('h1');

        // Industry / Category
        let category = text('button.DkEaL');
        if (!category) category = text('span.YhemCb');

        // Info blocks (address, phone, website)
        const infoBlocks = [
            ...document.querySelectorAll('button[data-item-id], a[data-item-id]'),
        ];

        const getInfo = (key) => {
            const el = infoBlocks.find((x) =>
                (x.getAttribute('data-item-id') || '').includes(key)
            );
            return el ? el.textContent.trim() : '';
        };

        const address = getInfo('address');
        const phone   = getInfo('phone');

        const websiteEl = infoBlocks.find((x) =>
            (x.getAttribute('data-item-id') || '').includes('authority')
        );
        const website = websiteEl
            ? websiteEl.getAttribute('href') || websiteEl.textContent.trim()
            : '';

        // Services — multiple possible DOM locations
        const serviceEls = [
            ...document.querySelectorAll(
                'div.iP2t7d span, div[jsaction*="amenity"] span, div.LTs0Rc span'
            ),
        ];
        const services = [...new Set(
            serviceEls.map((e) => e.textContent.trim()).filter(Boolean)
        )].join(', ');

        // Region — derived from address (skip postcode/country at the end)
        const parts = address.split(',').map((s) => s.trim()).filter(Boolean);
        const region = parts.length >= 3
            ? parts.slice(-3, -1).join(', ')
            : address;

        return { name, category, address, region, phone, website, services, mapsUrl: window.location.href };
    });
}

// ============================================================
// STEP 3 — GOOGLE SEARCH ENRICHMENT (email + LinkedIn + employees)
// ============================================================
async function enrichViaGoogleSearch(page, companyName, log) {
    const result = { email: '', linkedinUrl: '', employeeSize: '' };

    // Query 1: email + LinkedIn
    try {
        const q1 = `"${companyName}" email contact OR linkedin.com/company`;
        await page.goto(
            `https://www.google.com/search?q=${encodeURIComponent(q1)}`,
            { waitUntil: 'domcontentloaded', timeout: 20000 }
        );
        await humanWait(1000, 1800);
        await dismissPopups(page);

        const html1 = await page.content();

        const emailMatch = html1.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) result.email = emailMatch[0];

        const liMatch = html1.match(/https:\/\/(?:www\.)?linkedin\.com\/company\/[a-zA-Z0-9\-_%]+/);
        if (liMatch) result.linkedinUrl = liMatch[0];

    } catch (err) {
        log.warning(`  Google Search (email/LinkedIn) failed for "${companyName}": ${err.message}`);
    }

    // Query 2: employee size
    try {
        const q2 = `"${companyName}" number of employees OR company size OR headcount`;
        await page.goto(
            `https://www.google.com/search?q=${encodeURIComponent(q2)}`,
            { waitUntil: 'domcontentloaded', timeout: 20000 }
        );
        await humanWait(1000, 1800);
        await dismissPopups(page);

        const html2 = await page.content();

        // Match patterns like "500+ employees", "1,200 employees", "51-200 employees"
        const empMatch = html2.match(
            /(\d[\d,+]*(?:\s*[-–]\s*\d[\d,+]*)?)\s*\+?\s*employees?/i
        );
        if (empMatch) {
            result.employeeSize = empMatch[0]
                .replace(/employees?/i, '')
                .trim()
                .replace(/\s+/g, ' ');
        }

    } catch (err) {
        log.warning(`  Google Search (employee size) failed for "${companyName}": ${err.message}`);
    }

    return result;
}

// ============================================================
// FILTER HELPERS
// ============================================================
function matchesIndustry(category, filter) {
    if (!filter) return true;
    return (
        category.toLowerCase().includes(filter.toLowerCase()) ||
        filter.toLowerCase().includes(category.toLowerCase().split(' ')[0])
    );
}

function parseEmpNumber(raw) {
    if (!raw) return null;
    const m = raw.replace(/,/g, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
}

function matchesEmployeeRange(empStr, min, max) {
    if (min === 0 && max === Infinity) return true;
    const n = parseEmpNumber(empStr);
    if (n === null) return true;   // unknown → include by default
    return n >= min && (max === Infinity || n <= max);
}

// ============================================================
// MAIN CRAWLER
// ============================================================
let totalSaved = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: 1,
    requestHandlerTimeoutSecs: 3600,

    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    },

    async requestHandler({ page, request, log }) {
        log.info(`\n▶ Starting: ${request.url}`);

        // Navigate to Maps search
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanWait(2000, 3500);
        await dismissPopups(page);

        // Collect all place links
        const placeLinks = await collectPlaceLinks(page, log, numResults);
        log.info(`Collected ${placeLinks.length} place links\n`);

        const toProcess = placeLinks.slice(0, numResults);

        for (let i = 0; i < toProcess.length; i++) {
            if (totalSaved >= numResults) break;

            const placeUrl = toProcess[i];
            log.info(`[${i + 1}/${toProcess.length}] Visiting: ${placeUrl}`);

            // Maps detail page
            let mapsData;
            try {
                await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await humanWait(1800, 3000);
                await dismissPopups(page);

                mapsData = await scrapeMapsPlace(page);

                if (!mapsData.name) {
                    log.warning('  ⚠ No name found — skipping.');
                    continue;
                }
            } catch (err) {
                log.error(`  ✗ Maps scrape failed: ${err.message}`);
                continue;
            }

            // Industry filter
            if (industryFilter && !matchesIndustry(mapsData.category, industryFilter)) {
                log.info(`   Filtered (industry): ${mapsData.name}`);
                continue;
            }

            // Google Search enrichment
            let email = '', linkedinUrl = '', employeeSize = '';
            try {
                const enriched = await enrichViaGoogleSearch(page, mapsData.name, log);
                email        = enriched.email;
                linkedinUrl  = enriched.linkedinUrl;
                employeeSize = enriched.employeeSize;
                await humanWait(800, 1400);
            } catch (err) {
                log.warning(`  ⚠ Enrichment error: ${err.message}`);
            }

            // Employee size filter
            if (!matchesEmployeeRange(employeeSize, minEmployees, maxEmployees)) {
                log.info(`  ⊘ Filtered (employee size): ${mapsData.name} [${employeeSize}]`);
                continue;
            }

            // Final output record — exactly your 11 fields
            const record = {
                companyName:     mapsData.name     || '',
                companyIndustry: mapsData.category || industryFilter || '',
                locationRegion:  mapsData.region   || location,
                exactAddress:    mapsData.address  || '',
                servicesOffered: mapsData.services || '',
                companyDomain:   mapsData.website  || '',
                contactNumber:   mapsData.phone    || '',
                emailId:         email             || '',
                employeeSize:    employeeSize      || '',
                linkedinUrl:     linkedinUrl       || '',
                totalCompaniesFound: 0,             // updated at the end via SUMMARY
            };

            totalSaved++;
            record.totalCompaniesFound = totalSaved;
            await Actor.pushData(record);

            log.info(
                `   [${totalSaved}] ${record.companyName}` +
                ` | Phone: ${record.contactNumber || '—'}` +
                ` | Email: ${record.emailId || '—'}` +
                ` | Employees: ${record.employeeSize || '—'}`
            );

            await humanWait(700, 1300);
        }

        log.info(`\n${'═'.repeat(52)}`);
        log.info(`  DONE — Total companies extracted: ${totalSaved}`);
        log.info(`${'═'.repeat(52)}\n`);

        await Actor.setValue('SUMMARY', {
            totalCompaniesFound: totalSaved,
            searchQuery: searchQuery || `${industryFilter} companies in ${location}`,
            location,
            industryFilter:  industryFilter  || 'Any',
            minEmployees:    minEmployees    || 'Any',
            maxEmployees:    maxEmployees === Infinity ? 'Any' : maxEmployees,
            timestamp:       new Date().toISOString(),
        });
    },
});

await crawler.run([{ url: startUrl }]);

await Actor.exit();
