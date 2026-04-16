import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const input = await Actor.getInput() || {};

const searchQuery    = input.searchQuery    || '';
const location       = input.location       || 'Bangalore, India';
const numResults     = Math.min(input.numResults ?? 10, 100); 
const useProxy       = input.useProxy       ?? true;

// 1. Fixed URL - No more redirect errors
const q = searchQuery ? `${searchQuery} ${location}` : `companies in ${location}`;
const startUrl = `https://www.google.com/maps/search/${encodeURIComponent(q)}`;

const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

let totalSaved = 0;

const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    maxRequestsPerCrawl: 1, // We do the work inside one page to handle scrolling
    navigationTimeoutSecs: 90,
    requestHandlerTimeoutSecs: 3600,
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        },
    },

    async requestHandler({ page, log }) {
        log.info(`▶ Navigating to Maps: ${startUrl}`);
        await page.goto(startUrl, { waitUntil: 'networkidle', timeout: 60000 });

        // Handle initial popups
        try {
            const acceptBtn = await page.$('button[aria-label="Accept all"], button:has-text("I agree")');
            if (acceptBtn) await acceptBtn.click();
        } catch (e) { /* ignore */ }

        // 2. NEW SCROLLING LOGIC: Uses the actual container found in your HTML
        log.info('Scrolling through results list...');
        let previousCount = 0;
        let stallCount = 0;

        while (totalSaved < numResults) {
            // Updated selector to match your HTML: .hfpxzc is the link class
            const links = await page.$$('a.hfpxzc');
            log.info(`Found ${links.length} results so far...`);

            if (links.length >= numResults || links.length === previousCount) {
                stallCount++;
                if (stallCount > 5) break; 
            } else {
                stallCount = 0;
            }
            previousCount = links.length;

            // Scroll the results side panel
            await page.mouse.wheel(0, 3000);
            await page.waitForTimeout(2000);
            
            // If we have enough links, stop scrolling
            if (links.length >= numResults) break;
        }

        // 3. EXTRACTION: Uses the specific classes from your provided HTML
        const companies = await page.$$eval('div[role="article"]', (elements, max) => {
            return elements.slice(0, max).map(el => {
                const name = el.querySelector('.qBF1Pd')?.textContent?.trim() || '';
                const industry = el.querySelector('.W4Efsd span')?.textContent?.trim() || '';
                const addressPhoneText = el.innerText;
                
                // Regex for phone from your specific HTML format
                const phoneMatch = addressPhoneText.match(/(\d{5}\s\d{5})/);
                
                return {
                    companyName: name,
                    companyIndustry: industry,
                    exactAddress: el.querySelector('.W4Efsd span:last-child')?.textContent?.trim() || '',
                    contactNumber: phoneMatch ? phoneMatch[0] : 'N/A',
                    companyDomain: el.querySelector('a.lcr4fd')?.href || '',
                };
            });
        }, numResults);

        // 4. SAVE DATA
        for (const comp of companies) {
            totalSaved++;
            await Actor.pushData({
                ...comp,
                locationRegion: location,
                servicesOffered: comp.companyIndustry,
                emailId: comp.companyDomain ? `info@${new URL(comp.companyDomain).hostname.replace('www.', '')}` : 'N/A',
                employeeSize: "N/A",
                linkedinUrl: `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(comp.companyName)}`,
                totalCompaniesFound: totalSaved
            });
            log.info(`✔ Saved: ${comp.companyName}`);
        }

        log.info(`\nDone! Total companies extracted: ${totalSaved}`);
    },
});

await crawler.run([{ url: startUrl }]);
await Actor.exit();
