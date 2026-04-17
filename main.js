import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

// ─── INPUT ────────────────────────────────────────────────────────────────────
const input = await Actor.getInput() || {};

const location      = input.location       || 'Bangalore, India';
const industryFilter= (input.industryFilter || '').trim();
const minEmployees  = input.minEmployees    ?? 0;
const maxEmployees  = input.maxEmployees    ?? null;
const numResults    = Math.min(input.numResults ?? 50, 500);
const useProxy      = input.useProxy        ?? true;

// ─── BUILD NATURAL-LANGUAGE QUERY ─────────────────────────────────────────────
// Produces a query like: "AI companies in Bangalore with 500 to 1000 employees"
function buildQuery() {
    if (input.searchQuery && input.searchQuery.trim()) {
        return input.searchQuery.trim();
    }
    let q = industryFilter ? `${industryFilter} companies` : 'companies';
    q += ` in ${location}`;
    if (minEmployees > 0 && maxEmployees) {
        q += ` with ${minEmployees} to ${maxEmployees} employees`;
    } else if (minEmployees > 0) {
        q += ` with ${minEmployees}+ employees`;
    }
    return q;
}

const searchQuery = buildQuery();
const startUrl    = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;

console.log(`🔍 Search query : "${searchQuery}"`);
console.log(`🌐 Starting URL : ${startUrl}`);

// ─── PROXY ────────────────────────────────────────────────────────────────────
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

// ─── HELPERS ──────────────────────────────────────────────────────────────────
/** Derive a plausible employee-size label from the category / description text. */
function guessEmployeeSize(text = '') {
    const t = text.toLowerCase();
    if (/\b(startup|1-10|1 to 10)\b/.test(t))       return '1-10';
    if (/\b(11[-–]50|11 to 50|small)\b/.test(t))     return '11-50';
    if (/\b(51[-–]200|51 to 200)\b/.test(t))         return '51-200';
    if (/\b(201[-–]500|201 to 500|mid)\b/.test(t))   return '201-500';
    if (/\b(501[-–]1000|501 to 1000)\b/.test(t))     return '501-1000';
    if (/\b(1001[-–]5000|1001 to 5000|large)\b/.test(t)) return '1001-5000';
    if (/\b(5001|enterprise|Fortune)\b/.test(t))     return '5001+';
    return 'N/A';
}

/** Extract phone – handles Indian formats: +91-XXXXX-XXXXX, 0XXX-XXXXXXX, 10-digit */
function extractPhone(text = '') {
    const m = text.match(
        /(\+91[\s\-]?\d{5}[\s\-]?\d{5}|0\d{2,4}[\s\-]\d{6,8}|\b\d{5}\s\d{5}\b|\b[6-9]\d{9}\b)/
    );
    return m ? m[0].trim() : 'N/A';
}

/** Build a guess-email from a domain string. */
function emailFromDomain(domain = '') {
    try {
        const host = new URL(domain).hostname.replace(/^www\./, '');
        return `info@${host}`;
    } catch {
        return 'N/A';
    }
}

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
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=en-US'],
        },
    },

    async requestHandler({ page, log }) {
        // Force English UI so selectors stay consistent
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        log.info(`▶ Navigating to: ${startUrl}`);
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Dismiss cookie / consent dialog
        for (const sel of [
            'button[aria-label="Accept all"]',
            'button:has-text("I agree")',
            'button:has-text("Accept all")',
        ]) {
            try {
                const btn = await page.$(sel);
                if (btn) { await btn.click(); await page.waitForTimeout(1000); break; }
            } catch { /* ignore */ }
        }

        // Wait for the results panel to load
        await page.waitForSelector('div[role="feed"], div.section-result', { timeout: 20000 })
            .catch(() => log.warning('Feed selector timeout – continuing anyway'));

        // ── SCROLL RESULTS PANEL ────────────────────────────────────────────
        log.info(`Scrolling to collect ${numResults} results...`);

        const feedSel = 'div[role="feed"]';
        let prevCount = 0, stall = 0;

        while (totalSaved < numResults) {
            const links = await page.$$('a.hfpxzc');
            log.info(`  Found ${links.length} listing cards`);

            if (links.length >= numResults) break;

            if (links.length === prevCount) {
                stall++;
                if (stall >= 6) { log.info('No more results – stopping scroll.'); break; }
            } else {
                stall = 0;
            }
            prevCount = links.length;

            // Scroll inside the feed panel
            await page.evaluate((sel) => {
                const feed = document.querySelector(sel);
                if (feed) feed.scrollTop += 3000;
                else window.scrollBy(0, 3000);
            }, feedSel);

            await page.waitForTimeout(2000);
        }

        // ── CLICK EACH CARD & EXTRACT DETAIL ────────────────────────────────
        log.info('Extracting details from each card…');
        const cards = await page.$$('a.hfpxzc');
        const toProcess = cards.slice(0, numResults);

        for (let i = 0; i < toProcess.length; i++) {
            if (totalSaved >= numResults) break;

            try {
                // Re-query cards after navigation back
                const freshCards = await page.$$('a.hfpxzc');
                if (!freshCards[i]) continue;

                log.info(`  [${i + 1}/${toProcess.length}] Clicking card…`);
                await freshCards[i].click();

                // Wait for detail pane
                await page.waitForSelector('h1.DUwDvf, h1[data-attrid]', { timeout: 12000 })
                    .catch(() => {});
                await page.waitForTimeout(1500);

                const data = await page.evaluate(() => {
                    const getText = (sel) =>
                        document.querySelector(sel)?.textContent?.trim() || '';
                    const getHref = (sel) =>
                        document.querySelector(sel)?.href || '';

                    // ── Name ─────────────────────────────────────────────────
                    const name =
                        getText('h1.DUwDvf') ||
                        getText('h1[data-attrid]') ||
                        getText('h1') || 'N/A';

                    // ── Category / Industry ───────────────────────────────────
                    // The category button is the most reliable industry source
                    const industry =
                        getText('button.DkEaL') ||
                        getText('[jsaction*="category"]') ||
                        getText('.mgr77e button') ||
                        'N/A';

                    // ── Address ───────────────────────────────────────────────
                    // The address row has a data-item-id starting with "address"
                    const addressEl =
                        document.querySelector('[data-item-id^="address"]') ||
                        document.querySelector('button[data-tooltip="Copy address"]');
                    const address = addressEl?.textContent?.trim() || 'N/A';

                    // ── Phone ─────────────────────────────────────────────────
                    const phoneEl =
                        document.querySelector('[data-item-id^="phone"]') ||
                        document.querySelector('button[data-tooltip="Copy phone number"]');
                    const phone = phoneEl?.textContent?.trim() || 'N/A';

                    // ── Website ───────────────────────────────────────────────
                    const websiteEl =
                        document.querySelector('a[data-item-id="authority"]') ||
                        document.querySelector('a[aria-label^="Website"]');
                    const website = websiteEl?.href || 'N/A';

                    // ── Full page text (for fallback parsing) ─────────────────
                    const fullText = document.body.innerText || '';

                    return { name, industry, address, phone, website, fullText };
                });

                // ── Post-process ──────────────────────────────────────────────
                const contactNumber = data.phone !== 'N/A'
                    ? data.phone
                    : extractPhone(data.fullText);

                const domain = data.website !== 'N/A' ? data.website : 'N/A';

                const emailId = domain !== 'N/A' ? emailFromDomain(domain) : 'N/A';

                const employeeSize = guessEmployeeSize(
                    data.industry + ' ' + data.fullText
                );

                const linkedinUrl =
                    `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(data.name)}`;

                totalSaved++;

                const record = {
                    companyName:         data.name,
                    companyIndustry:     data.industry,
                    locationRegion:      location,
                    exactAddress:        data.address,
                    servicesOffered:     data.industry,   // best available from Maps
                    companyDomain:       domain,
                    contactNumber,
                    emailId,
                    employeeSize,
                    linkedinUrl,
                    totalCompaniesFound: totalSaved,
                };

                await Actor.pushData(record);
                log.info(`  ✔ [${totalSaved}] ${data.name} | ${data.industry} | ${contactNumber}`);

                // Go back to results list
                await page.goBack({ waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(1000);

            } catch (err) {
                log.warning(`  ⚠ Error on card ${i + 1}: ${err.message}`);
                try {
                    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 20000 });
                    await page.waitForTimeout(1000);
                } catch { /* ignore navigation error */ }
            }
        }

        log.info(`\n Done! Total companies extracted: ${totalSaved}`);
    },
});

await crawler.run([{ url: startUrl }]);
await Actor.exit();
