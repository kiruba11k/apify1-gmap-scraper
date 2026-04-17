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

function phoneFromText(text = '') {
    const m = text.match(/(\+91[\s\-]?\d{5}[\s\-]?\d{5}|\+91[\s\-]?\d{10}|0\d{2,4}[\s\-]?\d{6,8})/);
    return m ? m[0].trim() : 'N/A';
}

async function blockMedia(page) {
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,woff,woff2}', r => r.abort());
}

const BAD_NAMES = new Set(['Results', 'Google Maps', 'N/A', '', 'Before you continue to Google']);

// ─── REQUEST HANDLER ─────────────────────────────────────────────────────────
async function requestHandler({ request, page, log, crawler }) {
    const { label } = request.userData;

    if (label === LABEL_SEARCH) {
        await blockMedia(page);
        await page.goto(request.url, { waitUntil: 'networkidle', timeout: 60_000 });

        const consentBtn = page.locator('button:has-text("Accept all"), button:has-text("I agree")').first();
        if (await consentBtn.isVisible()) await consentBtn.click();

        let prevCount = 0, stall = 0;
        while (true) {
            const count = await page.$$eval('a.hfpxzc', els => els.length);
            log.info(`Collected ${count}/${numResults} results...`);
            if (count >= numResults || (count === prevCount && ++stall >= 5)) break;
            prevCount = count;
            await page.evaluate(() => {
                const feed = document.querySelector('div[role="feed"]') || document.querySelector('.m6QErb.DxyBCb');
                if (feed) feed.scrollTop = feed.scrollHeight;
            });
            await page.waitForTimeout(1500);
        }

        const hrefs = await page.$$eval('a.hfpxzc', (els, max) => els.slice(0, max).map(a => a.href), numResults);
        await crawler.addRequests(hrefs.map(url => ({ url, userData: { label: LABEL_DETAIL } })));
        return;
    }

    if (label === LABEL_DETAIL) {
        if (totalSaved >= numResults) return;

        await blockMedia(page);
        await page.goto(request.url, { waitUntil: 'domcontentloaded', timeout: 40_000 });

        const isBotCheck = await page.evaluate(() => document.title.includes('Before you continue') || !!document.querySelector('form[action*="consent.google.com"]'));
        if (isBotCheck) return;

        await page.waitForSelector('h1', { timeout: 10_000 }).catch(() => {});

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

        if (BAD_NAMES.has(raw.name)) return;

        const phone = raw.phone || phoneFromText(await page.evaluate(() => document.body.innerText)) || 'N/A';
        const emailId = emailFromDomain(raw.website);

        const record = {
            companyName: raw.name,
            companyIndustry: raw.industry,
            locationRegion: location,
            exactAddress: raw.address,
            servicesOffered: raw.industry,
            companyDomain: raw.website,
            googleMapsLink: request.url, // Dedicated column for the place URL
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
    maxConcurrency: 5,
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
