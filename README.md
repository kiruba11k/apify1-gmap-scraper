# Google Maps Company Scraper (Apify Actor)

This Actor scrapes company profiles from Google Maps search results and exports structured business data.

It is designed for Apify deployment and can be uploaded directly as an Actor project.

## What it does

- Builds a Google Maps query from your input parameters.
- Opens the Google Maps search result list for that query.
- Scrolls the result feed until it collects enough place links.
- Visits each place detail page.
- Extracts normalized company fields.
- Stores data into the default Apify dataset.

## Extracted output fields

Each dataset item contains:

- `companyName`
- `companyIndustry`
- `locationRegion`
- `exactAddress`
- `servicesOffered`
- `companyDomain`
- `googleMapsLink`
- `contactNumber`
- `emailId`
- `starRating`
- `reviewCount`
- `totalCompaniesFound`

## Input schema

The Actor expects the following input fields (configured in `.actor/input_schema.json`):

- `searchQuery` (string, optional)
  - Main query term. If empty, query is auto-built.
- `location` (string, required)
  - City/region to search in.
- `industryFilter` (string, optional)
  - Used for auto-built query when `searchQuery` is empty.
- `minEmployees` (integer, optional, default `0`)
  - Appended to the query when greater than 0.
- `maxEmployees` (integer, optional)
  - Used with `minEmployees` for range query text.
- `numResults` (integer, required, default `50`, max `500`)
  - Number of places to extract.
- `useProxy` (boolean, default `true`)
  - Enables Apify Proxy configuration.

## Query-building behavior

Query logic:

1. Start with `searchQuery` if provided.
2. Otherwise use:
   - `"<industryFilter> companies"` when `industryFilter` is set, or
   - `"companies"` fallback.
3. Append `in <location>` unless the base query already includes the city name.
4. Append employee-size text:
   - `with <min> to <max> employees` when both min and max are provided.
   - `with <min>+ employees` when only min is provided.

## How scraping works

- Uses `PlaywrightCrawler` from Crawlee.
- Uses request labels:
  - `SEARCH` for the listing page.
  - `DETAIL` for each place URL.
- Blocks heavy media requests (images/fonts/icons) to reduce bandwidth.
- Handles common consent popups when visible.
- Scrolls the Maps feed progressively until either:
  - requested amount is collected, or
  - scrolling stalls repeatedly.
- Extracts detail page data using DOM selectors.
- Skips non-business or invalid titles (for example generic Maps pages).

## Anti-block and reliability settings

- Optional Apify Proxy support (`useProxy`).
- Session pool enabled.
- Persistent cookies per session enabled.
- Browser launch args include:
  - `--disable-blink-features=AutomationControlled`
  - `--lang=en-US`

## Tech stack

- Node.js (ES modules)
- Apify SDK (`apify`)
- Crawlee (`PlaywrightCrawler`)
- Playwright

## Project structure

- `main.js` – Actor logic and crawler flow.
- `package.json` – dependencies and startup command.
- `Dockerfile` – image build for Apify execution environment.
- `.actor/actor.json` – Actor metadata.
- `.actor/input_schema.json` – Apify input UI schema.

## Local run

1. Install dependencies:

```bash
npm install
```

2. Run:

```bash
npm start
```

3. Provide Actor input via Apify local tooling/environment as needed.

## Deploy to Apify

1. Keep this repository structure unchanged.
2. In Apify Console, create/import Actor from this source.
3. Ensure the platform uses:
   - `.actor/actor.json`
   - `.actor/input_schema.json`
   - `Dockerfile`
4. Run with your desired input JSON.
5. Open the Actor run dataset to download results.

## Example input

```json
{
  "searchQuery": "AI Companies",
  "location": "Bangalore, India",
  "industryFilter": "IT Services",
  "minEmployees": 500,
  "maxEmployees": 1000,
  "numResults": 20,
  "useProxy": true
}
```

## Notes

- Data quality depends on what each Google Maps place profile exposes publicly.
- `emailId` is inferred as `info@domain` when website domain is available.
- `contactNumber` may be parsed from page text when a direct phone selector is absent.
