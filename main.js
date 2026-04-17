/**
 * Google Maps Company Scraper — v3.0
 *
 * ARCHITECTURE  (why it's now 5–8× faster)
 * ─────────────────────────────────────────
 * OLD  : 1 browser tab, serial loop.
 *        Visit detail → scrape → visit next…  ≈ 37 s / listing
 *
 * NEW  : 2-phase pipeline
 *   Phase 1 — 1 tab scrolls the search feed and ENQUEUES all listing URLs
 *             (label = 'DETAIL') into Crawlee's RequestQueue
 *   Phase 2 — Up to 5 concurrent browser tabs each process a DETAIL page
 *             Expected: ~5–8 results / min  vs the old ~1.6 results / min
 *
 * KEY FIXES vs v2
 *   ✅ Email     : only stored when a real company domain exists; 'N/A' otherwise
 *   ✅ LinkedIn  : scroll detail panel to "Web results" section at the bottom
 *                  → grabs real linkedin.com/company URLs, not fabricated searches
 *   ✅ Speed     : images/fonts/ads blocked on every page; parallel tabs
 *   ✅ Sessions  : pool of 10 sessions rotated across proxy IPs
 */

import { Actor }         from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

// ─── INPUT ────────────────────────────────────────────────────────────────────
const input          = await Actor.getInput() || {};
const location       = (input.location       || 'Bangalore, India').trim();
const industryFilter = (input.industryFilter  || '').trim();
const minEmployees   =  input.minEmployees    ?? 0;
const maxEmployees   =  input.maxEmployees    ?? null;
const numResults     = Math.min(input.numResults ?? 50, 500);
const useProxy       =  input.useProxy        ?? true;

// ─── QUERY ────────────────────────────────────────────────────────────────────
function buildQuery() {
    let base = (input.searchQuery || '').trim();
    if (!base) base = industryFilter ? `${industryFilter} companies` : 'companies';
    const cityName = location.split(',')[0].toLowerCase();
    if (!base.toLowerCase().includes(cityName)) base += ` in ${location}`;
    if (minEmployees > 0 && maxEmployees)  base += ` with ${minEmployees} to ${maxEmployees} employees`;
    else if (minEmployees > 0)             base += ` with ${minEmployees}+ employees`;
    return base;
}
const searchQuery = buildQuery();
const SEARCH_URL  = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;

console.log(`\n🔍 Query  : "${searchQuery}"`);
console.log(`🌐 URL    : ${SEARCH_URL}`);
console.log(`⚙️  Target : ${numResults} results | concurrency: 5\n`);

// ─── PROXY ────────────────────────────────────────────────────────────────────
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

// ─── SHARED STATE ─────────────────────────────────────────────────────────────
let totalSaved = 0;

// ─── LABELS ───────────────────────────────────────────────────────────────────
const LABEL_SEARCH = 'SEARCH';
const LABEL_DETAIL = 'DETAIL';

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * Derive a best-guess email from a company domain.
 * Returns null (not 'N/A') so callers can decide what to store.
 * Never guesses from google/facebook/social domains.
 */
function emailFromDomain(domain) {
    if (!domain || domain === 'N/A') return null;
    try {
        const host = new URL(domain).hostname.replace(/^www\./, '');
        const BAD  = ['google.', 'facebook.', 'linkedin.', 'instagram.',
                      'twitter.', 'youtube.', 'maps.', 'goo.gl', 'bit.ly',
                      'apple.', 'microsoft.', 'amazonaws.'];
        if (!host || host.length < 5 || BAD.some(b => host.includes(b))) return null;
        return `info@${host}`;
    } catch { return null; }
}

/** Regex fallback phone extraction from raw page text */
function phoneFromText(text = '') {
    const m = text.match(
        /(\+91[\s\-]?\d{5}[\s\-]?\d{5}|\+91[\s\-]?\d{10}|0\d{2,4}[\s\-]?\d{6,8}|\b\d{5}\s\d{5}\b|\b[6-9]\d{9}\b)/
    );
    return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}

/** Block heavy resources on a Playwright page to cut load time */
async function blockMedia(page) {
    await page.route(
        '**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2,ttf,otf,mp4,mp3,avi,mov}',
        r => r.abort()
    );
    await page.route('**/{ads,analytics,gtag,doubleclick,adservice}/**', r => r.abort());
    await page.route('**/www.google-analytics.com/**', r => r.abort());
    await page.route('**/googletagmanager.com/**', r => r.abort());
}

const BAD_NAMES = new Set([
    'Results', 'Google Maps', 'N/A', '', 'Maps', 'Search Results', 'Google',
]);

// ─── REQUEST HANDLER ─────────────────────────────────────────────────────────
async function requestHandler({ request, page, log, crawler }) {
    const { label } = request.userData;

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 1: SEARCH PAGE — scroll feed, enqueue all detail URLs
    // ══════════════════════════════════════════════════════════════════════════
    if (label === LABEL_SEARCH) {
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        await blockMedia(page);

        log.info('Phase 1: Loading search feed…');
        await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

        // Dismiss consent dialog
        for (const txt of ['Accept all', 'I agree']) {
            try {
                const btn = page.locator(`button:has-text("${txt}")`).first();
                if (await btn.isVisible({ timeout: 2500 })) { await btn.click(); break; }
            } catch { /* ok */ }
        }

        await page.waitForSelector('div[role="feed"]', { timeout: 20_000 })
            .catch(() => log.warning('Feed selector not found, continuing…'));

        // Scroll until we have enough cards
        let prevCount = 0, stall = 0;
        while (true) {
            const count = await page.$$eval('div.Nv2PK', els => els.length);
            log.info(`  feed cards: ${count}`);
            if (count >= numResults) break;
            if (count === prevCount) { if (++stall >= 6) { log.info('End of feed.'); break; } }
            else stall = 0;
            prevCount = count;
            await page.evaluate(() => {
                const feed = document.querySelector('div[role="feed"]') ||
                             document.querySelector('.m6QErb.DxyBCb');
                if (feed) feed.scrollTop = feed.scrollHeight;
                else window.scrollBy(0, 3000);
            });
            await page.waitForTimeout(1600);
        }

        // Collect URLs
        const hrefs = await page.$$eval(
            'a.hfpxzc',
            (els, max) => els.slice(0, max).map(a => a.href).filter(Boolean),
            numResults,
        );
        log.info(`✅ Collected ${hrefs.length} URLs — enqueueing for parallel scrape`);

        // Enqueue into the crawler's own queue — they will run concurrently
        await crawler.addRequests(
            hrefs.map(url => ({ url, userData: { label: LABEL_DETAIL } }))
        );
        return;
    }

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 2: DETAIL PAGE — extract all fields + LinkedIn from web results
    // ══════════════════════════════════════════════════════════════════════════
    if (label === LABEL_DETAIL) {
        if (totalSaved >= numResults) return;

        await blockMedia(page);
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
        await page.waitForSelector('h1', { timeout: 12_000 }).catch(() => {});
        await page.waitForTimeout(1000);

        // ── EXTRACT CORE DATA (single evaluate call for speed) ───────────────
        const raw = await page.evaluate(() => {
            const t = sel => document.querySelector(sel)?.textContent?.trim() || '';

            const name =
                t('h1.DUwDvf') || t('h1.fontHeadlineLarge') ||
                document.querySelector('h1')?.textContent?.trim() || 'N/A';

            const industry =
                t('button.DkEaL') ||
                t('.mgr77e button') ||
                document.querySelector('[jsaction*="category"]')?.textContent?.trim() ||
                t('span.fontBodyMedium button') || 'N/A';

            const addressEl =
                document.querySelector('[data-item-id^="address"]') ||
                document.querySelector('[aria-label^="Address:"]');
            const address = addressEl?.textContent?.trim() || 'N/A';

            // Phone from DOM (most accurate)
            const phoneEl =
                document.querySelector('[data-item-id^="phone:tel"]') ||
                document.querySelector('[aria-label^="Phone:"]') ||
                document.querySelector('[data-tooltip="Copy phone number"]');
            const phone = phoneEl?.textContent?.trim() || null;

            // Website from authority link
            const websiteEl =
                document.querySelector('a[data-item-id="authority"]') ||
                document.querySelector('a[aria-label^="Website:"]') ||
                document.querySelector('a[aria-label^="Website"]');
            const website = websiteEl?.href || 'N/A';

            // Services / highlights
            const svcEls = [
                ...document.querySelectorAll('.ah5Ghc span'),
                ...document.querySelectorAll('.e2moi span'),
            ];
            const services = svcEls
                .map(s => s.textContent.trim())
                .filter(s => s.length > 1 && s.length < 80)
                .slice(0, 8).join(', ') || 'N/A';

            // Star rating (aria-label is the most stable pattern)
            let stars = 'N/A';
            const ratingEl = document.querySelector('[aria-label*="stars"], [aria-label*="star"]');
            if (ratingEl) {
                const m = (ratingEl.getAttribute('aria-label') || '').match(/(\d+(?:\.\d+)?)\s*star/i);
                if (m) stars = m[1];
            }
            if (stars === 'N/A') {
                const num = document.querySelector('span.ceNzKf, span.fontDisplayLarge');
                if (num && /^\d+(?:\.\d+)?$/.test((num.textContent || '').trim())) {
                    stars = num.textContent.trim();
                }
            }

            // Review count
            let reviewCount = 'N/A';
            const revEl = document.querySelector('[aria-label*="reviews"], [aria-label*="review"]');
            if (revEl) {
                const m = (revEl.getAttribute('aria-label') || '').match(/([\d,]+)\s*review/i);
                if (m) reviewCount = m[1].replace(/,/g, '');
            }

            return { name, industry, address, phone, website, services, stars, reviewCount };
        });

        if (BAD_NAMES.has(raw.name)) {
            log.warning(`⚠ Skipped bad name: "${raw.name}"`);
            return;
        }

        // ── LINKEDIN from "Web results" section ─────────────────────────────
        //
        // When you open a Google Maps company page and scroll to the very bottom,
        // there is a "Web results" / "Search on Google" section that shows
        // organic search results for the company — including its LinkedIn page.
        // These render as standard <a href="https://www.linkedin.com/company/...">
        // anchor tags inside the detail pane once the section lazy-loads.
        //
        let linkedinUrl = 'N/A';
        try {
            // Scroll the left-hand detail pane to the bottom so web results load
            await page.evaluate(() => {
                // The scrollable detail container — try multiple selectors
                const pane =
                    document.querySelector('div[role="main"]') ||
                    document.querySelector('[jsaction*="pane"]') ||
                    document.querySelector('.m6QErb') ||
                    document.body;
                if (pane) pane.scrollTop = pane.scrollHeight;
            });
            // Wait for the "Web results" section to lazy-load
            await page.waitForTimeout(1800);

            // Second scroll to catch any further lazy content
            await page.evaluate(() => {
                const pane = document.querySelector('div[role="main"]') ||
                             document.querySelector('.m6QErb') || document.body;
                if (pane) pane.scrollTop = pane.scrollHeight;
            });
            await page.waitForTimeout(600);

            linkedinUrl = await page.evaluate(() => {
                /**
                 * Priority order:
                 * 1. Direct <a href="https://linkedin.com/company/..."> in page
                 * 2. Any href containing linkedin.com
                 * 3. Google redirect links (href includes /maps/redir or /url?q=)
                 *    — decode the destination param to find the real LinkedIn URL
                 */
                for (const a of document.querySelectorAll('a[href*="linkedin.com/company"]')) {
                    return a.href;
                }
                for (const a of document.querySelectorAll('a[href*="linkedin.com/in/"]')) {
                    return a.href;
                }
                for (const a of document.querySelectorAll('a[href*="linkedin"]')) {
                    const href = a.href || '';
                    // Try to decode Google redirect wrapper
                    try {
                        const url = new URL(href);
                        for (const p of ['url', 'q', 'dest', 'adurl']) {
                            const val = url.searchParams.get(p);
                            if (val && val.includes('linkedin.com')) return val;
                        }
                    } catch { /* ok */ }
                    return href; // return as-is if no redirect param
                }
                return null;
            }) || 'N/A';
        } catch (e) {
            log.debug(`LinkedIn scroll failed: ${e.message}`);
        }

        // ── PHONE fallback ───────────────────────────────────────────────────
        let phone = raw.phone;
        if (!phone || phone === 'Send to phone' || phone.length < 6) {
            const bodyText = await page.evaluate(() => document.body?.innerText || '');
            phone = phoneFromText(bodyText) || 'N/A';
        }

        // ── DOMAIN & EMAIL ───────────────────────────────────────────────────
        const domain  = (raw.website && !raw.website.includes('google.')) ? raw.website : 'N/A';
        // emailId: derived from company domain ONLY when domain is a real company site.
        // Set to 'N/A' if domain is unknown. Never fabricated from google/redirect URLs.
        const emailId = emailFromDomain(domain) || 'N/A';

        // ── SAVE ─────────────────────────────────────────────────────────────
        const record = {
            companyName:         raw.name,
            companyIndustry:     raw.industry,
            locationRegion:      location,
            exactAddress:        raw.address,
            servicesOffered:     (raw.services && raw.services !== 'N/A')
                                   ? raw.services : raw.industry,
            companyDomain:       domain,
            contactNumber:       phone,
            emailId,
            starRating:          raw.stars,
            reviewCount:         raw.reviewCount,
            linkedinUrl,
            totalCompaniesFound: ++totalSaved,
        };

        await Actor.pushData(record);
        log.info(
            `✔ [${totalSaved}] ${raw.name} | ⭐${raw.stars}(${raw.reviewCount}) | ` +
            `📞${phone} | 🔗${linkedinUrl !== 'N/A' ? '✓ ' + linkedinUrl.slice(0, 50) : '✗'}`
        );
    }
}

// ─── CRAWLER ─────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler,

    // ── CONCURRENCY ───────────────────────────────────────────────────────────
    // Phase 1 uses 1 tab. After enqueuing, up to 5 detail tabs run in parallel.
    // 5 is the safe limit for Google Maps + Apify residential proxies.
    minConcurrency: 1,
    maxConcurrency: 5,

    maxRequestsPerCrawl:        numResults + 10,
    navigationTimeoutSecs:      45,
    requestHandlerTimeoutSecs:  90,
    maxRequestRetries:          2,

    // ── BROWSER ───────────────────────────────────────────────────────────────
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--lang=en-US,en',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--blink-settings=imagesEnabled=false',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-sync',
            ],
        },
    },

    // Remove webdriver fingerprint before each navigation
    preNavigationHooks: [
        async ({ page }) => {
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
                window.chrome = { runtime: {} };
            });
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
        },
    ],

    // Session pool rotates sessions across proxy IPs for anti-detection
    useSessionPool:           true,
    persistCookiesPerSession: true,
    sessionPoolOptions: {
        maxPoolSize:    10,
        sessionOptions: { maxUsageCount: 5 },
    },
});

await crawler.run([{
    url:      SEARCH_URL,
    userData: { label: LABEL_SEARCH },
}]);

console.log(`\n🏁 Done. Total records saved: ${totalSaved}`);
await Actor.exit();
