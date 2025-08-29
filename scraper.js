const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

function generateErrorPage(message) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Miata Maestro - Error</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <div class="results-container">
    <div class="header">
      <div class="header-logo">
        <span class="marketplace-icon">🏪</span>
        Miata Marketplace
      </div>
    </div>
    
    <div class="main-content">
      <div class="search-card">
        <div class="search-title">❌ Error</div>
        <p style="color: #e41e3f; margin-bottom: 16px;">${message}</p>
        <div style="margin-top: 16px;">
          <a href="/search" class="back-btn">← Back to Search</a>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
  `;
}

// Ensure debug directory exists
function ensureDebugDir() {
  const debugDir = path.join(__dirname, 'debug');
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }
  return debugDir;
}

async function scrapeMarketplace(opts, sessionId, progressStore, updateProgress) {
  const isDebugMode = opts.debug === 'true';
  if (isDebugMode) {
    console.log('🐛 DEBUG MODE ENABLED - Will process only first 3 listings');
  }
  
  console.log('✅ Session and search params found, proceeding with scrape');
  
  // Initialize progress
  updateProgress(sessionId, 'initializing', 'Setting up scraping session...');
  let browser;
  
  try {
    updateProgress(sessionId, 'browser_start', 'Starting browser...');
    console.log('🚀 Starting browser...');
    browser = await puppeteer.launch({
      headless: opts.headless === 'true',
      userDataDir: './fb_user_data',
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=VizDisplayCompositor',
        '--disable-web-security',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ],
    });
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });
    
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      
      delete navigator.__proto__.webdriver;
      
      window.chrome = {
        runtime: {},
      };
    });
    
    const randomDelay = (min = 100, max = 300) => {
      const delay = Math.floor(Math.random() * (max - min + 1)) + min;
      console.log(`⏱️  Waiting ${delay}ms...`);
      return new Promise(resolve => setTimeout(resolve, delay));
    };
    
    const humanType = async (selector, text, delayRange = [5, 15]) => {
      const element = await page.$(selector);
      if (!element) {
        throw new Error(`Element ${selector} not found for typing`);
      }
      await element.click();
      await randomDelay(25, 50);
      for (const char of text) {
        await element.type(char);
        const delay = Math.floor(Math.random() * (delayRange[1] - delayRange[0] + 1)) + delayRange[0];
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    };

    updateProgress(sessionId, 'logging_in', 'Navigating to Facebook login...');
    console.log('🌐 Navigating to Facebook login...');
    await page.goto('https://www.facebook.com/login', { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });
    
    await randomDelay(1000, 2000);
    
    const currentUrl = page.url();
    console.log('📍 Current URL after navigation:', currentUrl);
    
    if (!currentUrl.includes('login')) {
      console.log('✅ Already logged in, proceeding to Marketplace...');
    } else {
      console.log('🔐 Need to log in...');
      
      try {
        await page.waitForSelector('input[name="email"]', { timeout: 10000 });
        console.log('✅ Found email input');
        
        console.log('⌨️  Typing email...');
        await humanType('input[name="email"]', opts.email);
        await randomDelay(200, 400);
        
        console.log('⌨️  Typing password...');
        await humanType('input[name="pass"]', opts.password);
        await randomDelay(50, 100);
        
        console.log('🖱️  Clicking login button...');
        await Promise.all([
          page.click('button[name="login"]'),
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
        ]);
        
        await randomDelay(100, 200);
        
      } catch (loginError) {
        console.error('❌ Login error:', loginError.message);
        await browser.close();
        throw new Error(`Login failed: ${loginError.message}`);
      }
      
      const postLoginUrl = page.url();
      console.log('📍 Post-login URL:', postLoginUrl);
      
      if (await page.$('input[name="approvals_code"]')) {
        console.log('❌ 2FA detected');
        await browser.close();
        throw new Error('Two-factor authentication detected. Please disable 2FA temporarily.');
      }
      
      if (postLoginUrl.includes('login') || postLoginUrl.includes('checkpoint')) {
        console.log('❌ Login failed or account restricted');
        await browser.close();
        throw new Error('Login failed or account restricted.');
      }
      
      updateProgress(sessionId, 'logging_in', 'Login successful!');
      console.log('✅ Login successful!');
    }

    updateProgress(sessionId, 'navigating', 'Building search URL and navigating to Marketplace...');
    console.log('🔍 Building direct search URL...');
    await randomDelay(100, 200);
    
    try {
      const baseUrl = 'https://www.facebook.com/marketplace/search';
      const searchParams = new URLSearchParams();
      
      searchParams.append('query', 'Miata');
      searchParams.append('sortBy', 'best_match');
      searchParams.append('exact', 'false');
      
      if (opts.yearMin && opts.yearMax) {
        searchParams.append('minYear', opts.yearMin);
        searchParams.append('maxYear', opts.yearMax);
      }
      
      if (opts.maxMileage) {
        searchParams.append('maxMileage', opts.maxMileage);
      }
      
      if (opts.maxPrice) {
        searchParams.append('maxPrice', opts.maxPrice);
      }
      
      const searchUrl = `${baseUrl}?${searchParams.toString()}`;
      console.log('🔗 Direct search URL:', searchUrl);
      
      await page.goto(searchUrl, { 
        waitUntil: 'networkidle2', 
        timeout: 60000 
      });
      
      await randomDelay(200, 350);
      
      updateProgress(sessionId, 'searching', 'Successfully navigated to search results!');
      console.log('✅ Successfully navigated to search results!');
      
    } catch (searchError) {
      console.error('❌ Direct search navigation error:', searchError.message);
      await browser.close();
      throw new Error(`Search navigation failed: ${searchError.message}`);
    }
    
    const possibleSelectors = [
      '[role="main"] [role="article"]',
      '[data-testid="marketplace-search-results"] > div > div',
      '.x9f619.x1n2onr6.x1ja2u2z > div',
      '[aria-label*="Collection of Marketplace items"]'
    ];
    
    let items = [];
    let selectorUsed = null;
    
    for (const selector of possibleSelectors) {
      try {
        await page.waitForSelector(selector, { timeout: 5000 });
        items = await page.$$(selector);
        if (items.length > 0) {
          selectorUsed = selector;
          console.log(`Found ${items.length} items using selector: ${selector}`);
          break;
        }
      } catch (e) {
        console.log(`Selector ${selector} not found, trying next...`);
      }
    }
    
    if (items.length === 0) {
      // Ensure debug directory exists and save screenshot there
      const debugDir = ensureDebugDir();
      const screenshotPath = path.join(debugDir, 'debug-marketplace.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await browser.close();
      throw new Error('No listings found. The page structure may have changed or there are no Miatas in your area.');
    }

    updateProgress(sessionId, 'searching', 'Extracting listing URLs from search results...');
    console.log('Extracting listing URLs...');
    const listingUrls = await page.evaluate(() => {
      const urls = new Set();
      
      const itemLinks = document.querySelectorAll('a[href*="/marketplace/item/"]');
      console.log(`Found ${itemLinks.length} item links with /marketplace/item/`);
      
      itemLinks.forEach(link => {
        const href = link.href;
        if (href.includes('/marketplace/item/') && href.match(/\/marketplace\/item\/\d+/)) {
          urls.add(href);
        }
      });
      
      if (urls.size < 5) {
        const allMarketplaceLinks = document.querySelectorAll('a[href*="marketplace"]');
        allMarketplaceLinks.forEach(link => {
          const href = link.href;
          if (href.match(/\/marketplace\/item\/\d+/) || 
              (href.includes('marketplace') && href.match(/\d{15,}/) && !href.includes('search'))) {
            urls.add(href);
          }
        });
      }
      
      return Array.from(urls);
    });

    const validListingUrls = listingUrls.filter(url => 
      url.includes('/marketplace/item/') && url.match(/\/marketplace\/item\/\d+/)
    );

    console.log(`Validated ${validListingUrls.length} listing URLs`);

    if (validListingUrls.length === 0) {
      await browser.close();
      throw new Error('No valid listing URLs found.');
    }

    const limit = isDebugMode ? 3 : +opts.limit;
    const urlsToScrape = validListingUrls.slice(0, limit);
    console.log(`Will scrape ${urlsToScrape.length} validated URLs`);

    updateProgress(sessionId, 'extracting', `Found ${urlsToScrape.length} listings to process. Starting extraction...`);
    const results = [];
    const storedListings = {};
    
    for (let i = 0; i < urlsToScrape.length; i++) {
      console.log(`\n🔍 Processing listing ${i + 1}/${urlsToScrape.length}...`);
      updateProgress(sessionId, 'extracting', `Processing listing ${i + 1}/${urlsToScrape.length}...`);
      const url = urlsToScrape[i];
      let detail = {
        id: `listing_${Date.now()}_${i}`,
        title: null,
        price: null,
        mileage: null,
        year: null,
        url,
        description: null,
        transmission: null,
        images: [],
        rawText: '',
      };
      
      try {
        const detailPage = await browser.newPage();
        await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await detailPage.setViewport({ width: 1366, height: 768 });
        await detailPage.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        await randomDelay(100, 200);

        await detailPage.waitForSelector('body', { timeout: 10000 });
        await new Promise(r => setTimeout(r, 500));

        const data = await detailPage.evaluate(() => {
          function isMiataRelated(text) {
            if (!text) return false;
            const lower = text.toLowerCase();
            return lower.includes('miata') || 
                   lower.includes('mx-5') || 
                   lower.includes('mx5') || 
                   lower.includes('roadster') ||
                   (lower.includes('mazda') && (lower.includes('convertible') || lower.includes('roadster')));
          }
          
          function isPartsOnly(title, description) {
            if (!title && !description) return true;
            
            const combinedText = `${title || ''} ${description || ''}`.toLowerCase();
            
            const strongPartsIndicators = [
              'part out', 'parting out', 'parts only', 'for parts',
              'parting', 'just parts', 'parts car'
            ];
            
            const carIndicators = [
              'runs', 'drives', 'running', 'driving', 'starts',
              'title', 'registered', 'insured', 'daily driver',
              'project car', 'convertible', 'complete car',
              'whole car', 'entire car', 'full car',
              'miles', 'mileage', 'manual', 'automatic',
              'engine runs', 'motor runs', 'street legal'
            ];
            
            const hasStrongPartsWords = strongPartsIndicators.some(indicator => combinedText.includes(indicator));
            const hasCarWords = carIndicators.some(indicator => combinedText.includes(indicator));
            
            return hasStrongPartsWords && !hasCarWords;
          }
          
          let title = null;
          const titleSelectors = [
            'h1[dir="auto"]',
            'span[dir="auto"][role="heading"]',
            '[data-testid*="title"]',
            'h1',
            'h2',
            '[role="heading"]',
            'span[dir="auto"]'
          ];
          
          for (const selector of titleSelectors) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
              if (el && el.innerText && el.innerText.trim().length > 3) {
                const text = el.innerText.trim();
                if (isMiataRelated(text) || !title) {
                  title = text;
                  if (isMiataRelated(text)) break;
                }
              }
            }
            if (title && isMiataRelated(title)) break;
          }
          
          let description = null;
          const descSelectors = [
            '[data-testid="marketplace_pdp_description"]',
            '[data-testid*="description"]',
            'div[role="main"] div[dir="auto"]',
            'div[role="main"] p',
            'div[role="main"] div:not(:empty)',
            '[role="article"] div[dir="auto"]',
            '.x1lliihq',
            '.x193iq5w'
          ];
          
          for (const selector of descSelectors) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
              if (el && el.innerText && el.innerText.trim().length > 20) {
                const text = el.innerText.trim();
                if (!description || (text.length > description.length && text.length > 50)) {
                  description = text;
                }
              }
            }
          }
          
          const images = [];
          const imageSelectors = [
            'img[src*="scontent"]',
            '[data-testid*="image"] img',
            '[role="main"] img',
            'img[alt*="vehicle"], img[alt*="car"], img[alt*="Miata"]'
          ];
          
          for (const selector of imageSelectors) {
            const imageElements = document.querySelectorAll(selector);
            for (const img of imageElements) {
              if (img.src && img.src.includes('http') && 
                  img.naturalWidth > 100 && img.naturalHeight > 100) {
                if (!images.includes(img.src)) {
                  images.push(img.src);
                }
              }
            }
          }
          
          if (!isMiataRelated(title) && !isMiataRelated(description)) {
            return { skip: true, reason: 'Not Miata related' };
          }
          
          if (isPartsOnly(title, description)) {
            return { skip: true, reason: 'Parts only' };
          }
          
          let price = null;
          const bodyText = document.body.innerText;
          const pricePatterns = [
            /\$([0-9,]+)(?:\.[0-9]{2})?/g,
            /Price[:\s]*\$?([0-9,]+)/i,
            /Asking[:\s]*\$?([0-9,]+)/i
          ];
          
          for (const pattern of pricePatterns) {
            const matches = bodyText.match(pattern);
            if (matches) {
              for (const match of matches) {
                const numStr = match.replace(/[^\d]/g, '');
                const num = parseInt(numStr, 10);
                if (num >= 500 && num <= 100000) {
                  price = num;
                  break;
                }
              }
              if (price) break;
            }
          }
          
          let year = null;
          const searchTexts = [title, description, bodyText].filter(Boolean);
          
          for (const text of searchTexts) {
            if (year) break;
            const yearMatches = text.match(/\b(19[89][0-9]|20[0-2][0-9])\b/g);
            if (yearMatches) {
              for (const yearStr of yearMatches) {
                const yearNum = parseInt(yearStr);
                if (yearNum >= 1989 && yearNum <= 2025) {
                  year = yearNum;
                  break;
                }
              }
            }
            
            if (!year) {
              const shortYearMatch = text.match(/'([0-9]{2})\b/g);
              if (shortYearMatch) {
                for (const match of shortYearMatch) {
                  const shortYear = parseInt(match.replace("'", ""));
                  let fullYear;
                  if (shortYear >= 89) {
                    fullYear = 1900 + shortYear;
                  } else if (shortYear <= 25) {
                    fullYear = 2000 + shortYear;
                  }
                  if (fullYear >= 1989 && fullYear <= 2025) {
                    year = fullYear;
                    break;
                  }
                }
              }
            }
          }
          
          let mileage = null;
          const mileagePatterns = [
            /(?:mileage|odometer|miles)[:\s]*([0-9,]+)(?:\s*(?:miles?|mi))?/gi,
            /(?:driven|has)[:\s]*([0-9,]+)\s*(?:miles?|mi)/gi,
            /([0-9,]+)\s*(?:miles?|mi)(?!\s*(?:away|from|radius|drive|distance|per|mpg|to))/gi,
            /([0-9,]+)k\s*(?:miles?|mi)/gi,
            /([0-9,]+)\s*k(?:\s*(?:miles?|mi))?(?!\s*(?:away|from|radius|drive|distance|per|mpg))/gi
          ];
          
          for (const text of searchTexts) {
            if (mileage !== null) break;
            
            for (const pattern of mileagePatterns) {
              const matches = [...text.matchAll(pattern)];
              
              for (const match of matches) {
                let rawMileage = match[1].replace(/,/g, '');
                
                if (text.substring(match.index + match[0].length - 1, match.index + match[0].length + 1).includes('k')) {
                  rawMileage = rawMileage + '000';
                }
                
                const mileageNum = parseInt(rawMileage, 10);
                
                if (mileageNum >= 1000 && mileageNum <= 500000) {
                  mileage = mileageNum;
                  break;
                }
              }
              
              if (mileage !== null) break;
            }
          }
          
          let transmission = null;
          const combinedText = `${title || ''} ${description || ''} ${bodyText}`.toLowerCase();
          
          const autoPatterns = [
            'automatic', 'auto', 'a/t', 'at ', ' at', 'torque converter',
            'slushbox', 'tiptronic', 'cvt', 'continuously variable'
          ];
          
          const manualPatterns = [
            'manual', 'stick', 'mt ', ' mt', 'm/t', '5 speed', '6 speed',
            '5-speed', '6-speed', 'clutch', 'stick shift', 'manual transmission',
            'standard', 'row your own'
          ];
          
          let autoScore = 0;
          let manualScore = 0;
          
          for (const pattern of autoPatterns) {
            if (combinedText.includes(pattern)) {
              autoScore += pattern === 'automatic' ? 3 : 1;
            }
          }
          
          for (const pattern of manualPatterns) {
            if (combinedText.includes(pattern)) {
              manualScore += pattern === 'manual' ? 3 : 1;
            }
          }
          
          if (manualScore > autoScore) {
            transmission = 'Manual';
          } else if (autoScore > manualScore) {
            transmission = 'Automatic';
          }
          
          return {
            title,
            year,
            price,
            mileage,
            transmission,
            description: description?.substring(0, 500),
            images: images.slice(0, 2), 
            skip: false
          };
        });

        if (data.skip) {
          console.log(`Skipping listing: ${data.reason}`);
          await detailPage.close();
          continue;
        }

        Object.assign(detail, data);
        await detailPage.close();

        if (!detail.title || detail.title.length < 5) {
          console.log('Skipping - invalid title');
          continue;
        }

        const titleLower = detail.title.toLowerCase();
        const descLower = (detail.description || '').toLowerCase();
        const isMiata = titleLower.includes('miata') || titleLower.includes('mx-5') || titleLower.includes('mx5') ||
                       descLower.includes('miata') || descLower.includes('mx-5') || descLower.includes('mx5');

        if (!isMiata) {
          console.log('Skipping - not a Miata:', detail.title);
          continue;
        }

        if (detail.year) {
          if (detail.year < +opts.yearMin || detail.year > +opts.yearMax) {
            console.log(`Skipping - year ${detail.year} outside range ${opts.yearMin}-${opts.yearMax}`);
            continue;
          }
        }

        if (detail.mileage && detail.mileage > +opts.maxMileage) {
          console.log(`Skipping - mileage ${detail.mileage} over limit ${opts.maxMileage}`);
          continue;
        }

        if (opts.maxPrice && detail.price && detail.price > +opts.maxPrice) {
          console.log(`Skipping - price $${detail.price} over limit $${opts.maxPrice}`);
          continue;
        }

        console.log(`Storing listing with ID: ${detail.id}`);
        storedListings[detail.id] = detail;
        
        results.push(detail);
        
      } catch (e) {
        console.log(`Error processing listing ${i + 1}:`, e.message);
        continue;
      }
    }

    await browser.close();
    updateProgress(sessionId, 'complete', `Successfully processed ${results.length} listings!`);
    console.log(`Successfully processed ${results.length} listings`);

    return { results, storedListings };

  } catch (err) {
    console.error('💥 MAJOR ERROR occurred during scraping:', err);
    
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        console.error('❌ Error while closing browser:', closeError.message);
      }
    }
    
    throw err;
  }
}

module.exports = {
  scrapeMarketplace,
  generateErrorPage
};