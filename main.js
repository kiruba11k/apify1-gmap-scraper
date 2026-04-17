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
// Produces: "AI Companies in Bangalore, India with 500 to 1000 employees"
function buildQuery() {
    let base = (input.searchQuery || '').trim();
    if (!base) {
        base = industryFilter ? `${industryFilter} companies` : 'companies';
    }
    // Append location if not already present
    const cityName = location.split(',')[0].toLowerCase();
    if (!base.toLowerCase().includes(cityName)) {
        base += ` in ${location}`;
    }
    // Append employee range
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
function extractPhone(text = '') {
    const m = text.match(
        /(\+91[\s\-]?\d{5}[\s\-]?\d{5}|\+91[\s\-]?\d{10}|0\d{2,4}[\s\-]?\d{6,8}|\b\d{5}\s\d{5}\b|\b[6-9]\d{9}\b)/
    );
    return m ? m[0].replace(/\s+/g, ' ').trim() : 'N/A';
}

function emailFromDomain(domain = '') {
    if (!domain || domain === 'N/A') return 'N/A';
    try {
        const host = new URL(domain).hostname.replace(/^www\./, '');
        if (!host || host.includes('google.')) return 'N/A';
        return `info@${host}`;
    } catch { return 'N/A'; }
}

function guessEmployeeSize(text = '') {
    const t = text.toLowerCase();
    if (/\b(1[-–]10|1 to 10|startup)\b/.test(t))            return '1-10';
    if (/\b(11[-–]50|11 to 50)\b/.test(t))                   return '11-50';
    if (/\b(51[-–]200|51 to 200)\b/.test(t))                 return '51-200';
    if (/\b(201[-–]500|201 to 500)\b/.test(t))               return '201-500';
    if (/\b(501[-–]1000|501 to 1000|500 to 1000)\b/.test(t)) return '501-1000';
    if (/\b(1001[-–]5000|1001 to 5000)\b/.test(t))           return '1001-5000';
    if (/\b(5001|10000|enterprise|Fortune 500)\b/.test(t))   return '5001+';
    return 'N/A';
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
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--lang=en-US,en',
                '--disable-blink-features=AutomationControlled',
            ],
        },
    },

    async requestHandler({ page, log }) {
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        log.info(`▶  Navigating to search: ${startUrl}`);
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Dismiss consent dialog
        for (const label of ['Accept all', 'I agree']) {
            try {
                const btn = page.locator(`button:has-text("${label}")`).first();
                if (await btn.isVisible({ timeout: 3000 })) {
                    await btn.click();
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
            // div.Nv2PK = the result card container (confirmed via dev.to 2025 research)
            const count = await page.$$eval('div.Nv2PK', els => els.length);
            log.info(`  Cards loaded: ${count}`);
            if (count >= numResults) break;
            if (count === prevCount) {
                stall++;
                if (stall >= 6) { log.info('No more results to load.'); break; }
            } else { stall = 0; }
            prevCount = count;

            // Scroll inside the feed panel
            await page.evaluate(() => {
                const feed =
                    document.querySelector('div[role="feed"]') ||
                    document.querySelector('.m6QErb.DxyBCb');
                if (feed) feed.scrollTop = feed.scrollHeight;
                else window.scrollBy(0, 3000);
            });
            await page.waitForTimeout(2000);
        }

        // ── COLLECT LISTING URLs ──────────────────────────────────────────────
        // a.hfpxzc confirmed by multiple 2025 sources (ZenRows, dev.to, HasData)
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

                // h1.DUwDvf = place name heading (confirmed by ZenRows 2025)
                await page.waitForSelector('h1.DUwDvf, h1.fontHeadlineLarge', { timeout: 15000 })
                    .catch(() => {});
                await page.waitForTimeout(1500);

                const raw = await page.evaluate(() => {
                    const t  = sel => document.querySelector(sel)?.textContent?.trim() || '';

                    // Name: h1.DUwDvf confirmed by ZenRows Nov 2025
                    const name =
                        t('h1.DUwDvf') ||
                        t('h1.fontHeadlineLarge') ||
                        t('h1') || 'N/A';

                    // Category button in detail pane
                    const industry =
                        t('button.DkEaL') ||
                        t('.mgr77e button') ||
                        t('[jsaction*="pane.rating.category"]') ||
                        t('span.fontBodyMedium button') || 'N/A';

                    // Address: data-item-id="address" is stable
                    const addressEl =
                        document.querySelector('[data-item-id^="address"]') ||
                        document.querySelector('button[data-tooltip="Copy address"]');
                    const address = addressEl?.textContent?.trim() || 'N/A';

                    // Phone: data-item-id starts with "phone:tel"
                    const phoneEl =
                        document.querySelector('[data-item-id^="phone:tel"]') ||
                        document.querySelector('[data-tooltip="Copy phone number"]') ||
                        document.querySelector('[aria-label*="phone" i]') ||
                        document.querySelector('[aria-label*="Phone" i]');
                    const phone = phoneEl?.textContent?.trim() || 'N/A';

                    // Website: data-item-id="authority" confirmed ZenRows 2025
                    const websiteEl =
                        document.querySelector('a[data-item-id="authority"]') ||
                        document.querySelector('a[aria-label^="Website"]');
                    const website = websiteEl?.href || 'N/A';

                    // Services/highlights: .ah5Ghc confirmed by dev.to HasData 2025
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

                // Guard: skip if name is clearly a Google UI element
                if (!raw.name || raw.name === 'N/A' || raw.name === 'Results') {
                    log.warning(`  ⚠ Skipped card ${i + 1}: name resolved to "${raw.name}"`);
                    continue;
                }

                const phone        = raw.phone !== 'N/A' ? raw.phone : extractPhone(raw.fullText);
                const domain       = (raw.website && !raw.website.includes('google.')) ? raw.website : 'N/A';
                const emailId      = emailFromDomain(domain);
                const employeeSize = guessEmployeeSize(raw.industry + ' ' + raw.fullText);

                const record = {
                    companyName:         raw.name,
                    companyIndustry:     raw.industry,
                    locationRegion:      location,
                    exactAddress:        raw.address,
                    servicesOffered:     raw.services !== 'N/A' ? raw.services : raw.industry,
                    companyDomain:       domain,
                    contactNumber:       phone,
                    emailId,
                    employeeSize,
                    linkedinUrl:         `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(raw.name)}`,
                    totalCompaniesFound: totalSaved + 1,
                };

                await Actor.pushData(record);
                totalSaved++;
                log.info(`  ✔ [${totalSaved}] ${raw.name} | ${raw.industry} | ${phone} | ${raw.address}`);

            } catch (err) {
                log.warning(`  ⚠ Error on card ${i + 1}: ${err.message}`);
            }

            await page.waitForTimeout(800);
        }

        log.info(`\n✅ Extraction complete. Total companies: ${totalSaved}`);
    },
});

await crawler.run([{ url: startUrl }]);
await Actor.exit();
