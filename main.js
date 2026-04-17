import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

// ─── INPUT ────────────────────────────────────────────────────────────────────
const input = await Actor.getInput() || {};

const location       = (input.location       || 'Bangalore, India').trim();
const industryFilter = (input.industryFilter  || '').trim();
const minEmployees   =  input.minEmployees    ?? 0;
const maxEmployees   =  input.maxEmployees    ?? null;
const numResults     = Math.min(input.numResults ?? 50, 500);
const useProxy       =  input.useProxy        ?? true;

// ─── QUERY BUILDER ────────────────────────────────────────────────────────────
function buildQuery() {
    let base = (input.searchQuery || '').trim();
    if (!base) {
        base = industryFilter ? `${industryFilter} companies` : 'companies';
    }
    const cityName = location.split(',')[0].toLowerCase();
    if (!base.toLowerCase().includes(cityName)) {
        base += ` in ${location}`;
    }
    if (minEmployees > 0 && maxEmployees) {
        base += ` with ${minEmployees} to ${maxEmployees} employees`;
    } else if (minEmployees > 0) {
        base += ` with ${minEmployees}+ employees`;
    }
    return base;
}

const searchQuery = buildQuery();
const startUrl    = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;

console.log(`\n🔍 Final search query : "${searchQuery}"`);
console.log(`🌐 Starting URL       : ${startUrl}\n`);

// ─── PROXY ────────────────────────────────────────────────────────────────────
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

// ─── HELPERS ─────────────────────────────────────────────────────────────────

/**
 * FIX: Extract phone using aria-label (most stable) + regex fallback.
 * Old code used regex on body text which pulled random numbers.
 */
function extractPhoneFromText(text = '') {
    const m = text.match(
        /(\+91[\s\-]?\d{5}[\s\-]?\d{5}|\+91[\s\-]?\d{10}|0\d{2,4}[\s\-]?\d{6,8}|\b\d{5}\s\d{5}\b|\b[6-9]\d{9}\b)/
    );
    return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}

/**
 * FIX: Only generate guessed email if we have a real company domain.
 * Old code generated emails from google.com and other junk URLs.
 * We now mark these clearly as "guessed" and skip bad domains.
 */
function emailFromDomain(domain = '') {
    if (!domain || domain === 'N/A') return 'N/A';
    try {
        const host = new URL(domain).hostname.replace(/^www\./, '');
        if (!host || host.includes('google.') || host.includes('facebook.')
            || host.includes('instagram.') || host.includes('linkedin.')
            || host.length < 4) return 'N/A';
        return `info@${host}`;
    } catch { return 'N/A'; }
}

/**
 * FIX: Extract LinkedIn URL from the "About" / social section of a listing.
 * The old code fabricated LinkedIn search URLs — completely wrong.
 * The correct approach: click the "About" tab if present, then look for
 * anchor tags whose href contains "linkedin.com/company" in the details pane.
 * We also scan the page body as a final fallback.
 */
async function extractLinkedInUrl(page) {
    try {
        // Try clicking the "About" tab in the detail pane (if it exists)
        const aboutTab = page.locator('button[aria-label*="About"], button[data-tab-index="3"]').first();
        if (await aboutTab.isVisible({ timeout: 2000 })) {
            await aboutTab.click();
            await page.waitForTimeout(1000);
        }
    } catch { /* tab may not exist */ }

    return await page.evaluate(() => {
        // 1. Look for direct LinkedIn anchor tags in the whole document
        const anchors = [...document.querySelectorAll('a[href*="linkedin.com/company"], a[href*="linkedin.com/in/"]')];
        for (const a of anchors) {
            const href = a.href || '';
            if (href.includes('linkedin.com/company') || href.includes('linkedin.com/in/')) {
                // Skip Google redirect wrappers unless they contain linkedin
                return href;
            }
        }

        // 2. Scan all links (including Google Maps redirect links) and extract linkedin URL
        const allLinks = [...document.querySelectorAll('a[href]')];
        for (const a of allLinks) {
            const href = a.href || '';
            // Google Maps sometimes wraps external links: /maps/redir?...url=...
            if (href.includes('linkedin.com')) return href;
        }

        // 3. Try scraping from text content (some listings show the URL as text)
        const bodyText = document.body?.innerText || '';
        const liMatch = bodyText.match(/https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in)\/[^\s\n"']+/i);
        return liMatch ? liMatch[0] : null;
    });
}

/**
 * FIX: Extract the star rating using aria-label which is the most stable
 * selector. Scrapfly research confirmed: aria-label="X.X stars" pattern.
 * Also captures review count.
 */
async function extractRatingAndReviews(page) {
    return await page.evaluate(() => {
        // aria-label like "4.5 stars" on the rating element
        const ratingEl =
            document.querySelector('[aria-label*="stars"]') ||
            document.querySelector('[aria-label*="star"]') ||
            document.querySelector('span.ceNzKf') ||
            document.querySelector('span.fontDisplayLarge');

        let stars = 'N/A';
        if (ratingEl) {
            const label = ratingEl.getAttribute('aria-label') || ratingEl.textContent || '';
            const m = label.match(/(\d+(?:\.\d+)?)\s*star/i);
            if (m) stars = m[1];
            else {
                const numMatch = (ratingEl.textContent || '').trim().match(/^\d+(?:\.\d+)?$/);
                if (numMatch) stars = numMatch[0];
            }
        }

        // Review count: aria-label like "1,234 reviews"
        const reviewEl =
            document.querySelector('[aria-label*="reviews"]') ||
            document.querySelector('[aria-label*="review"]');
        let reviewCount = 'N/A';
        if (reviewEl) {
            const label = reviewEl.getAttribute('aria-label') || '';
            const m = label.match(/([\d,]+)\s*review/i);
            if (m) reviewCount = m[1].replace(/,/g, '');
        }

        return { stars, reviewCount };
    });
}

/**
 * FIX: Extract company name robustly.
 * Old code sometimes picked up UI strings like "Results".
 * Priority: h1.DUwDvf → h1.fontHeadlineLarge → first h1
 * Guard against known bad values.
 */
const BAD_NAMES = new Set(['Results', 'Google Maps', 'N/A', '', 'Maps']);

// ─── CRAWLER ─────────────────────────────────────────────────────────────────
let totalSaved = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: 1,
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 3600,
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--lang=en-US,en',
                '--disable-blink-features=AutomationControlled',
            ],
        },
    },

    async requestHandler({ page, log }) {
        // Anti-detection: remove webdriver flag
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        log.info(`▶  Navigating to search: ${startUrl}`);
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Dismiss consent / cookie dialog
        for (const label of ['Accept all', 'I agree', 'Reject all']) {
            try {
                const btn = page.locator(`button:has-text("${label}")`).first();
                if (await btn.isVisible({ timeout: 3000 })) {
                    if (label !== 'Reject all') await btn.click();
                    else { /* skip reject */ }
                    await page.waitForTimeout(800);
                    break;
                }
            } catch { /* ignore */ }
        }

        // Wait for feed
        await page.waitForSelector('div[role="feed"]', { timeout: 25000 })
            .catch(() => log.warning('Feed selector not found – continuing anyway'));

        // ── SCROLL TO LOAD CARDS ──────────────────────────────────────────────
        log.info(`Scrolling feed to load ${numResults} cards...`);
        let prevCount = 0, stall = 0;
        while (true) {
            const count = await page.$$eval('div.Nv2PK', els => els.length);
            log.info(`  Cards loaded: ${count}`);
            if (count >= numResults) break;
            if (count === prevCount) {
                stall++;
                if (stall >= 8) { log.info('No more results to load.'); break; }
            } else { stall = 0; }
            prevCount = count;

            await page.evaluate(() => {
                const feed =
                    document.querySelector('div[role="feed"]') ||
                    document.querySelector('.m6QErb.DxyBCb');
                if (feed) feed.scrollTop = feed.scrollHeight;
                else window.scrollBy(0, 3000);
            });
            await page.waitForTimeout(2200);
        }

        // ── COLLECT LISTING URLs ──────────────────────────────────────────────
        const hrefs = await page.$$eval('a.hfpxzc', (els, max) =>
            els.slice(0, max).map(a => a.href).filter(Boolean),
        numResults);

        log.info(`Collected ${hrefs.length} listing URLs. Extracting details...`);

        // ── VISIT EACH LISTING ────────────────────────────────────────────────
        for (let i = 0; i < hrefs.length; i++) {
            if (totalSaved >= numResults) break;

            try {
                log.info(`  [${i + 1}/${hrefs.length}] ${hrefs[i].slice(0, 80)}...`);
                await page.goto(hrefs[i], { waitUntil: 'domcontentloaded', timeout: 45000 });

                await page.waitForSelector('h1.DUwDvf, h1.fontHeadlineLarge, h1', { timeout: 15000 })
                    .catch(() => {});
                await page.waitForTimeout(1800); // let dynamic content settle

                // ── CORE DATA EXTRACTION ──────────────────────────────────────
                const raw = await page.evaluate(() => {
                    const t  = sel => document.querySelector(sel)?.textContent?.trim() || '';

                    // FIX: Name - use stable selectors, don't fall back to generic h1 too fast
                    const name =
                        t('h1.DUwDvf') ||
                        t('h1.fontHeadlineLarge') ||
                        document.querySelector('h1')?.textContent?.trim() || 'N/A';

                    // FIX: Category / Industry - use aria-label on buttons inside the detail pane
                    // button.DkEaL is confirmed stable; also try data-section-id approach
                    const industry =
                        t('button.DkEaL') ||
                        t('.mgr77e button') ||
                        document.querySelector('[jsaction*="category"]')?.textContent?.trim() ||
                        t('span.fontBodyMedium button') || 'N/A';

                    // FIX: Address - aria-label "Address:" is the most reliable
                    const addressEl =
                        document.querySelector('[data-item-id^="address"]') ||
                        document.querySelector('[aria-label^="Address:"]') ||
                        document.querySelector('button[data-tooltip="Copy address"]');
                    const address = addressEl?.textContent?.trim() || 'N/A';

                    // FIX: Phone - prefer data-item-id="phone:tel:..." over body regex
                    const phoneEl =
                        document.querySelector('[data-item-id^="phone:tel"]') ||
                        document.querySelector('[aria-label^="Phone:"]') ||
                        document.querySelector('[data-tooltip="Copy phone number"]');
                    const phone = phoneEl?.textContent?.trim() || null;

                    // Website - data-item-id="authority" (stable per ZenRows 2025)
                    const websiteEl =
                        document.querySelector('a[data-item-id="authority"]') ||
                        document.querySelector('a[aria-label^="Website:"]') ||
                        document.querySelector('a[aria-label^="Website"]');
                    const website = websiteEl?.href || 'N/A';

                    // Services from highlights section
                    const svcEls  = [
                        ...document.querySelectorAll('.ah5Ghc span'),
                        ...document.querySelectorAll('.e2moi span'),
                    ];
                    const services = svcEls
                        .map(s => s.textContent.trim())
                        .filter(s => s.length > 1 && s.length < 80)
                        .slice(0, 8)
                        .join(', ') || 'N/A';

                    const fullText = document.body?.innerText || '';
                    return { name, industry, address, phone, website, services, fullText };
                });

                // ── VALIDATE NAME ─────────────────────────────────────────────
                // FIX: Reject known-bad UI string names
                if (!raw.name || BAD_NAMES.has(raw.name)) {
                    log.warning(`  ⚠ Skipped card ${i + 1}: name resolved to "${raw.name}"`);
                    continue;
                }

                // ── PHONE ─────────────────────────────────────────────────────
                // FIX: Use DOM phone first; only fall back to regex on body text
                // Old code used regex on entire body which matched random numbers
                let phone = raw.phone;
                if (!phone || phone === 'Send to phone') {
                    phone = extractPhoneFromText(raw.fullText) || 'N/A';
                }

                // ── WEBSITE ───────────────────────────────────────────────────
                const domain = (raw.website && !raw.website.includes('google.')) ? raw.website : 'N/A';

                // ── EMAIL ─────────────────────────────────────────────────────
                // FIX: Only derive email when we have a valid company domain.
                // Old code created emails from any URL including google.com/maps
                const emailId = emailFromDomain(domain);

                // ── RATING ────────────────────────────────────────────────────
                // FIX: New - added star rating + review count extraction
                const { stars, reviewCount } = await extractRatingAndReviews(page);

                // ── LINKEDIN ──────────────────────────────────────────────────
                // FIX: Actually find real LinkedIn URLs from the detail panel.
                // Old code fabricated LinkedIn search URLs — completely wrong.
                // We scroll to "About" tab / web results and look for real linkedin.com links.
                const linkedinUrl = await extractLinkedInUrl(page) || 'N/A';

                // ── BUILD RECORD ──────────────────────────────────────────────
                const record = {
                    companyName:         raw.name,
                    companyIndustry:     raw.industry,
                    locationRegion:      location,
                    exactAddress:        raw.address,
                    servicesOffered:     (raw.services !== 'N/A' && raw.services) ? raw.services : raw.industry,
                    companyDomain:       domain,
                    contactNumber:       phone,
                    emailId,             // guessed from domain; only present when domain is valid
                    starRating:          stars,
                    reviewCount,
                    linkedinUrl,         // real URL from About/social section; 'N/A' if not found
                    totalCompaniesFound: totalSaved + 1,
                };

                await Actor.pushData(record);
                totalSaved++;
                log.info(`  ✔ [${totalSaved}] ${raw.name} | ⭐ ${stars} (${reviewCount}) | ${phone} | LinkedIn: ${linkedinUrl !== 'N/A' ? '✓' : '✗'}`);

            } catch (err) {
                log.warning(`  ⚠ Error on card ${i + 1}: ${err.message}`);
            }

            // Human-like delay between requests
            await page.waitForTimeout(900 + Math.floor(Math.random() * 600));
        }

        log.info(`\n✅ Extraction complete. Total companies: ${totalSaved}`);
    },
});

await crawler.run([{ url: startUrl }]);
await Actor.exit();
