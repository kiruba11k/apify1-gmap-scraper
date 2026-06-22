import { Actor }         from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

// Track start time right at the beginning
const START_TIME = Date.now();
const DEFAULT_RUNTIME_MS = 300_000;
const SAFETY_BUFFER_MS = 45_000;
const timeoutAtRaw = process.env.ACTOR_TIMEOUT_AT || process.env.APIFY_TIMEOUT_AT || '';
const actorTimeoutAt = Number(timeoutAtRaw) || Date.parse(timeoutAtRaw) || 0;
const MAX_RUNTIME_MS = actorTimeoutAt > START_TIME
    ? Math.max(30_000, actorTimeoutAt - START_TIME - SAFETY_BUFFER_MS)
    : DEFAULT_RUNTIME_MS - SAFETY_BUFFER_MS; // stop before Apify hard-kills the run

// ─── INPUT ────────────────────────────────────────────────────────────────────
const input          = await Actor.getInput() || {};
const location       = (input.location       || 'Bangalore, India').trim();
const industryFilter = (input.industryFilter  || '').trim();
const minEmployees   =  input.minEmployees    ?? 0;
const maxEmployees   =  input.maxEmployees    ?? null;
const numResults     = Math.min(input.numResults ?? 50, 500);
const useProxy       =  input.useProxy        ?? true;

// ─── QUERY BUILDER ────────────────────────────────────────────────────────────
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
console.log(`⚙️  Target : ${numResults} results\n`);

// ─── PROXY ────────────────────────────────────────────────────────────────────
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

let totalSaved = 0;
let stopRequested = false;
const savedUrls = new Set();
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

function isNearTimeout() {
    return stopRequested || Date.now() - START_TIME > MAX_RUNTIME_MS;
}

async function saveRecord(raw, googleMapsLink, log) {
    if (totalSaved >= numResults || savedUrls.has(googleMapsLink) || BAD_NAMES.has(raw.name)) return false;

    const website = raw.website || 'N/A';
    const industry = raw.industry || 'Software company';
    const record = {
        companyName: raw.name,
        companyIndustry: industry,
        locationRegion: location,
        exactAddress: raw.address || 'N/A',
        servicesOffered: industry,
        companyDomain: website,
        googleMapsLink,
        contactNumber: raw.phone || 'N/A',
        emailId: emailFromDomain(website),
        starRating: raw.stars || 'N/A',
        reviewCount: raw.reviews || '0',
        totalCompaniesFound: ++totalSaved,
    };

    savedUrls.add(googleMapsLink);
    await Actor.pushData(record);
    log.info(`✔ [${totalSaved}] Saved: ${raw.name}`);
    return true;
}

Actor.on('aborting', () => {
    stopRequested = true;
});

// ─── REQUEST HANDLER ─────────────────────────────────────────────────────────
async function requestHandler({ request, page, log, crawler }) {
    const { label } = request.userData;

    // 🛑 TIME CHECK: If we are close to the 5-minute limit, exit early
    if (isNearTimeout()) {
        log.warning('⏳ Reaching automated QA 5-minute timeout! Stopping gracefully to preserve data...');
        return;
    }

    if (label === LABEL_SEARCH) {
        await blockMedia(page);
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

        const consentBtn = page.locator('button:has-text("Accept all"), button:has-text("I agree")').first();
        if (await consentBtn.isVisible()) await consentBtn.click();

        let prevCount = 0, stall = 0;
        while (true) {
            // Check runtime during scrolling loop too
            if (isNearTimeout()) break;

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

        const listResults = await page.$$eval('a.hfpxzc', (els, max) => els.slice(0, max).map((a) => ({
            name: a.getAttribute('aria-label')?.trim() || a.textContent?.trim() || 'N/A',
            url: a.href,
        })), numResults);
        const hrefs = listResults.map(({ url }) => url);

        for (const result of listResults) {
            if (isNearTimeout()) break;
            await saveRecord({
                name: result.name,
                industry: industryFilter || 'N/A',
                address: 'N/A',
                phone: 'N/A',
                website: 'N/A',
                stars: 'N/A',
                reviews: '0',
            }, result.url, log);
        }
        
        if (hrefs.length === 0) {
            log.warning('⚠️ No results found on Google Maps for this query.');
            return;
        }

        if (!isNearTimeout() && totalSaved < numResults) {
            await crawler.addRequests(hrefs
                .filter(url => !savedUrls.has(url))
                .map(url => ({ url, userData: { label: LABEL_DETAIL } })));
        }
        return;
    }

    if (label === LABEL_DETAIL) {
        if (totalSaved >= numResults || savedUrls.has(request.url) || isNearTimeout()) return;

        await blockMedia(page);
        await page.goto(request.url, { waitUntil: 'commit', timeout: 30_000 });

        const isBotCheck = await page.evaluate(() => document.title.includes('Before you continue') || !!document.querySelector('form[action*="consent.google.com"]'));
        if (isBotCheck) return;

        await page.waitForSelector('h1', { timeout: 7000 }).catch(() => {});

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

        await saveRecord(raw, request.url, log);
    }
}

// ─── CRAWLER ─────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler,
    maxConcurrency: 3,
    useSessionPool: true,
    persistCookiesPerSession: true,
    requestHandlerTimeoutSecs: 45,
    launchContext: {
        launchOptions: {
            args: ['--disable-blink-features=AutomationControlled', '--lang=en-US'],
        },
    },
});

await crawler.run([{ url: SEARCH_URL, userData: { label: LABEL_SEARCH } }]);
await Actor.exit();
