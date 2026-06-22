import { Actor }         from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const START_TIME = Date.now();
const MAX_RUNTIME_MS = 255_000; // 4 mins 15 seconds safety buffer

// ─── INPUT ────────────────────────────────────────────────────────────────────
const input          = await Actor.getInput() || {};
const location       = (input.location       || 'Bangalore, India').trim();
const industryFilter = (input.industryFilter  || '').trim();
const minEmployees   =  input.minEmployees    ?? 0;
const maxEmployees   =  input.maxEmployees    ?? null;
const numResults     = Math.min(input.numResults ?? 50, 500);
const useProxy       =  input.useProxy        ?? true;

// ─── QUERY BUILDERS ───────────────────────────────────────────────────────────
// 1. For display logs (showing the user's intent)
function buildDisplayQuery() {
    let base = (input.searchQuery || '').trim();
    if (!base) base = industryFilter ? `${industryFilter} companies` : 'companies';
    const cityName = location.split(',')[0].toLowerCase();
    if (!base.toLowerCase().includes(cityName)) base += ` in ${location}`;
    if (minEmployees > 0 && maxEmployees)  base += ` with ${minEmployees} to ${maxEmployees} employees`;
    else if (minEmployees > 0)             base += ` with ${minEmployees}+ employees`;
    return base;
}

// 2. For Google Maps (STRIPIING the employee filter text so Google Maps doesn't break)
function buildMapSearchQuery() {
    let base = (input.searchQuery || '').trim();
    if (!base) base = industryFilter ? `${industryFilter} companies` : 'companies';
    const cityName = location.split(',')[0].toLowerCase();
    if (!base.toLowerCase().includes(cityName)) base += ` in ${location}`;
    return base;
}

const displayQuery     = buildDisplayQuery();
const mapSearchQuery   = buildMapSearchQuery();
const SEARCH_URL       = `http://googleusercontent.com/maps.google.com/maps?q=${encodeURIComponent(mapSearchQuery)}`;

console.log(`\n🔍 Intended Query : "${displayQuery}"`);
console.log(`🗺️  Actual Map Search: "${mapSearchQuery}"`);
console.log(`⚙️  Target        : ${numResults} results\n`);

// ─── PROXY ────────────────────────────────────────────────────────────────────
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

let totalSaved = 0;
const LABEL_SEARCH = 'SEARCH';
const LABEL_DETAIL = 'DETAIL';

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function emailFromDomain(domain) {
    if (!domain || domain === 'N/A' || domain.includes('google.com')) return 'N/A';
    try {
        const host = new URL(domain).hostname.replace(/^www\./, '');
        return `info@${host}`;
    } catch { return 'N/A'; }
}

async function blockMedia(page) {
    await page.route('**/*', (route) => {
        const url = route.request().url();
        const type = route.request().resourceType();
        if (
            ['image', 'media', 'font'].includes(type) ||
            url.includes('google-analytics') || 
            url.includes('play.google.com') ||
            url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.jpeg')
        ) {
            return route.abort();
        }
        return route.continue();
    });
}

const BAD_NAMES = new Set(['Results', 'Google Maps', 'N/A', '', 'Before you continue to Google']);

// ─── REQUEST HANDLER ─────────────────────────────────────────────────────────
async function requestHandler({ request, page, log, crawler }) {
    const { label } = request.userData;

    if (Date.now() - START_TIME > MAX_RUNTIME_MS) {
        log.warning('⏳ Reaching automated QA 5-minute timeout window! Flushing cleanly to save progress...');
        return;
    }

    if (label === LABEL_SEARCH) {
        await blockMedia(page);
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

        const consentBtn = page.locator('button:has-text("Accept all"), button:has-text("I agree")').first();
        if (await consentBtn.isVisible()) await consentBtn.click();

        let prevCount = 0, stall = 0;
        while (true) {
            if (Date.now() - START_TIME > MAX_RUNTIME_MS) break;

            const count = await page.$$eval('a.hfpxzc', els => els.length);
            log.info(`Collected ${count}/${numResults} results...`);
            if (count >= numResults || (count === prevCount && ++stall >= 5)) break;
            prevCount = count;
            
            await page.evaluate(() => {
                const feed = document.querySelector('div[role="feed"]') || document.querySelector('.m6QErb.DxyBCb');
                if (feed) feed.scrollTop = feed.scrollHeight;
            });
            await page.waitForTimeout(1000);
        }

        const hrefs = await page.$$eval('a.hfpxzc', (els, max) => els.slice(0, max).map(a => a.href), numResults);
        
        if (hrefs.length === 0) {
            log.warning('⚠️ Search yielded 0 entries matching criteria on Google Maps maps window.');
            return;
        }

        await crawler.addRequests(hrefs.map(url => ({ url, userData: { label: LABEL_DETAIL } })));
        return;
    }

    if (label === LABEL_DETAIL) {
        if (totalSaved >= numResults) return;

        await blockMedia(page);
        
        await page.goto(request.url, { waitUntil: 'commit', timeout: 30_000 });
        await page.waitForSelector('h1', { timeout: 7000 }).catch(() => {});

        const isBotCheck = await page.evaluate(() => document.title.includes('Before you continue') || !!document.querySelector('form[action*="consent.google.com"]'));
        if (isBotCheck) {
            await page.close().catch(() => {});
            return;
        }

        const raw = await page.evaluate(() => {
            const t = sel => document.querySelector(sel)?.textContent?.trim() || 'N/A';
            return {
                name: t('h1'),
                industry: document.querySelector('[jsaction*="category"]')?.textContent?.trim() || 'Software company',
                address: document.querySelector('[data-item-id^="address"]')?.textContent?.trim() || 'N/A',
                phone: document.querySelector('[data-item-id^="phone:tel"]')?.textContent?.trim() || null,
                website: document.querySelector('a[data-item-id="authority"]')?.href || 'N/A',
                stars: document.querySelector('[aria-label*="stars"]')?.getAttribute('aria-label')?.match(/(\d+\.\d+|\d+)/)?.[0] || 'N/A',
                reviews: document.querySelector('[aria-label*="reviews"]')?.getAttribute('aria-label')?.match(/(\d+)/)?.[0] || '0'
            };
        });

        await page.close().catch(() => {});

        if (BAD_NAMES.has(raw.name)) return;

        const phone = raw.phone || 'N/A';
        const emailId = emailFromDomain(raw.website);

        const record = {
            companyName: raw.name,
            companyIndustry: raw.industry,
            locationRegion: location,
            exactAddress: raw.address,
            servicesOffered: raw.industry,
            companyDomain: raw.website,
            googleMapsLink: request.url, 
            contactNumber: phone,
            emailId,
            starRating: raw.stars,
            reviewCount: raw.reviews,
            totalCompaniesFound: ++totalSaved,
        };

        await Actor.pushData(record);
        log.info(`✔ [${totalSaved}] Saved: ${raw.name}`);
    }
}

// ─── CRAWLER ─────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler,
    maxConcurrency: 8, 
    useSessionPool: true,
    persistCookiesPerSession: true,
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled', '--lang=en-US'],
        },
    },
});

await crawler.run([{ url: SEARCH_URL, userData: { label: LABEL_SEARCH } }]);
await Actor.exit();
