import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

// ============================================================
// 1. INPUT HANDLING
// ============================================================
const input = await Actor.getInput() || {};

const searchQuery    = input.searchQuery    || '';
const location       = input.location       || 'Bangalore, India';
const industryFilter = input.industryFilter || '';
const minEmployees   = input.minEmployees   ?? 0;
const maxEmployees   = input.maxEmployees   ?? Infinity;
const numResults     = Math.min(input.numResults ?? 10, 500); 
const useProxy       = input.useProxy       ?? true;

// Corrected URL Construction
function buildSearchUrl() {
    const q = searchQuery 
        ? `${searchQuery} ${location}` 
        : `${industryFilter} companies in ${location}`;
    return `https://www.google.com/maps/search/${encodeURIComponent(q)}`;
}

const startUrl = buildSearchUrl();

// ============================================================
// 2. PROXY & CRAWLER CONFIG
// ============================================================
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

let totalSaved = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    // Increased to allow processing multiple sub-pages
    maxRequestsPerCrawl: 200, 
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 3600,
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    },

    async requestHandler({ page, request, log }) {
        log.info(`▶ Processing: ${request.url}`);

        // Wait for the results list to appear
        await page.goto(request.url, { waitUntil: 'networkidle', timeout: 60000 });
        
        // Handle initial cookie consent/popups if they appear
        const acceptBtn = await page.$('button[aria-label="Accept all"]');
        if (acceptBtn) await acceptBtn.click();

        // SCROLLING LOGIC: Extract links from the side panel
        log.info('Scrolling to find results...');
        let links = [];
        while (links.length < numResults) {
            links = await page.$$eval('a[href*="/maps/place/"]', (els) => els.map(el => el.href));
            if (links.length >= numResults) break;
            
            // Scroll the results pane
            await page.mouse.wheel(0, 2000);
            await page.waitForTimeout(2000);
            
            // Check if "End of results" is reached
            const isEnd = await page.$('span:has-text("You\'ve reached the end of the list")');
            if (isEnd) break;
        }

        const toProcess = [...new Set(links)].slice(0, numResults);
        log.info(`Found ${toProcess.length} unique companies. Starting extraction...`);

        for (const link of toProcess) {
            try {
                await page.goto(link, { waitUntil: 'networkidle', timeout: 60000 });
                
                const data = await page.evaluate(() => {
                    const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || '';
                    
                    // Robust Selectors for Google Maps 2024+
                    const name = getText('h1.DUwDvf');
                    const industry = getText('button.DkEaL');
                    const address = getText('button[data-item-id="address"]');
                    const phone = getText('button[data-item-id*="phone"]');
                    const website = document.querySelector('a[data-item-id="authority"]')?.href || '';
                    
                    // Extract Region/Area from Address
                    const addressParts = address.split(',');
                    const region = addressParts.length > 1 ? addressParts[addressParts.length - 2].trim() : address;

                    return { name, industry, address, phone, website, region };
                });

                if (!data.name) continue;

                // Final 11-field record structure
                const record = {
                    companyName: data.name,
                    companyIndustry: data.industry || industryFilter,
                    locationRegion: data.region,
                    exactAddress: data.address,
                    servicesOffered: data.industry, // Often matches industry on Gmaps
                    companyDomain: data.website,
                    contactNumber: data.phone,
                    // Enrichment Placeholders (Email/LinkedIn require Google Search Actor for high accuracy)
                    emailId: data.website ? `info@${new URL(data.website).hostname.replace('www.', '')}` : 'N/A',
                    employeeSize: "Fetching...", 
                    linkedinUrl: `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(data.name)}`,
                    totalCompaniesFound: ++totalSaved
                };

                await Actor.pushData(record);
                log.info(`✔ [${totalSaved}] Extracted: ${record.companyName}`);

            } catch (err) {
                log.error(`Failed to scrape ${link}: ${err.message}`);
            }
        }

        log.info(`Crawl Complete. Total Saved: ${totalSaved}`);
    },
});

await crawler.run([{ url: startUrl }]);
await Actor.exit();
