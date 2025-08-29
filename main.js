#!/usr/bin/env node
const express = require('express');
const session = require('express-session');
const { evaluateListing, generateLowballMessage } = require('./llm');
const { scrapeMarketplace, generateErrorPage } = require('./scraper');

const app = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); 
app.use(session({
  secret: 'miata-scraper-secret-key-change-in-production',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    maxAge: 24 * 60 * 60 * 1000, 
    secure: false,
    httpOnly: true
  }
}));

// Store progress for each session
const progressStore = new Map();

// Function to update progress for a session
function updateProgress(sessionId, step, details = '') {
  const progress = {
    step,
    details,
    timestamp: new Date().toISOString()
  };
  progressStore.set(sessionId, progress);
  
  // Send SSE update if client is connected
  const clients = progressStore.get(`${sessionId}_clients`) || [];
  clients.forEach(client => {
    if (client && !client.destroyed) {
      client.write(`data: ${JSON.stringify(progress)}\n\n`);
    }
  });
}

// SSE endpoint for progress updates
app.get('/progress', (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).send('Unauthorized');
  }

  const sessionId = req.sessionID;
  
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  // Store client connection
  if (!progressStore.has(`${sessionId}_clients`)) {
    progressStore.set(`${sessionId}_clients`, []);
  }
  progressStore.get(`${sessionId}_clients`).push(res);

  // Send initial progress if available
  const currentProgress = progressStore.get(sessionId);
  if (currentProgress) {
    res.write(`data: ${JSON.stringify(currentProgress)}\n\n`);
  }

  // Handle client disconnect
  req.on('close', () => {
    const clients = progressStore.get(`${sessionId}_clients`) || [];
    const index = clients.indexOf(res);
    if (index > -1) {
      clients.splice(index, 1);
    }
  });
});


app.post('/evaluate-listing', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { listingId } = req.body;
  console.log('Evaluating listing ID:', listingId);
  
  if (!req.session.storedListings) {
    return res.status(404).json({ error: 'No stored listings found in session' });
  }
  
  console.log('Available stored listings:', Object.keys(req.session.storedListings));
  
  const listing = req.session.storedListings[listingId];
  
  if (!listing) {
    return res.status(404).json({ error: `Listing ${listingId} not found. Available listings: ${Object.keys(req.session.storedListings).join(', ')}` });
  }

  console.log('Found listing:', listing.title);

  const config = req.session.llmConfig;
  if (!config) {
    return res.status(400).json({ error: 'LLM configuration not found' });
  }
  
  if (config.provider === 'none') {
    return res.status(400).json({ error: 'AI features are disabled. Please select an LLM provider to use evaluation features.' });
  }
  
  try {
    const evaluation = await evaluateListing(listing, config.provider, config);
    
    // Extract lowball price from evaluation
    const lowballMatch = evaluation.match(/<strong>Lowball:<\/strong>\s*\$([0-9,]+)/);
    const lowballPrice = lowballMatch ? lowballMatch[1].replace(/,/g, '') : null;
    
    // Store the lowball price in the listing data for later use
    if (lowballPrice) {
      listing.lowballPrice = parseInt(lowballPrice);
      req.session.storedListings[listingId] = listing;
    }
    
    res.json({ evaluation });
  } catch (error) {
    console.error('Evaluation error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/analyze-all', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  if (!req.session.storedListings) {
    return res.status(404).json({ error: 'No stored listings found in session' });
  }

  const config = req.session.llmConfig;
  if (!config) {
    return res.status(400).json({ error: 'LLM configuration not found' });
  }
  
  if (config.provider === 'none') {
    return res.status(400).json({ error: 'AI features are disabled. Please select an LLM provider to use evaluation features.' });
  }

  const results = {};
  const listingIds = Object.keys(req.session.storedListings);
  let processed = 0;

  try {
    // Process all listings in parallel
    const evaluationPromises = listingIds.map(async (listingId) => {
      const listing = req.session.storedListings[listingId];
      try {
        const evaluation = await evaluateListing(listing, config.provider, config);
        
        // Extract lowball price from evaluation
        const lowballMatch = evaluation.match(/<strong>Lowball:<\/strong>\s*\$([0-9,]+)/);
        const lowballPrice = lowballMatch ? lowballMatch[1].replace(/,/g, '') : null;
        
        // Store the lowball price in the listing data
        if (lowballPrice) {
          listing.lowballPrice = parseInt(lowballPrice);
          req.session.storedListings[listingId] = listing;
        }
        
        results[listingId] = { evaluation, error: null };
        processed++;
      } catch (error) {
        console.error(`Error evaluating listing ${listingId}:`, error);
        results[listingId] = { evaluation: null, error: error.message };
        processed++;
      }
    });

    await Promise.all(evaluationPromises);
    res.json({ results, processed, total: listingIds.length });
    
  } catch (error) {
    console.error('Analyze all error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/scrape-more', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  if (!req.session.searchParams) {
    return res.status(400).json({ error: 'No previous search parameters found' });
  }

  // Create modified search params for additional scraping
  const opts = { 
    ...req.session.searchParams, 
    limit: 10 // Scrape 10 more cars
  };

  try {
    console.log('🔍 Starting scrape-more with params:', { limit: opts.limit, provider: opts.provider });
    const { results, storedListings } = await scrapeMarketplace(opts, req.sessionID, progressStore, updateProgress);
    
    console.log('✅ Scrape-more completed successfully. Found', results.length, 'results');
    
    // Merge new results with existing stored listings (avoid duplicates)
    if (!req.session.storedListings) {
      req.session.storedListings = {};
    }
    
    // Only add listings that don't already exist
    const newListings = {};
    let actualNewCount = 0;
    Object.entries(storedListings).forEach(([id, listing]) => {
      if (!req.session.storedListings[id]) {
        req.session.storedListings[id] = listing;
        newListings[id] = listing;
        actualNewCount++;
      }
    });
    
    console.log(`📊 Merged results: ${actualNewCount} new listings, ${Object.keys(req.session.storedListings).length} total`);
    
    res.json({ 
      results: results.filter(r => newListings[r.id]), // Only return actually new results
      newCount: actualNewCount,
      totalCount: Object.keys(req.session.storedListings).length
    });
    
  } catch (error) {
    console.error('💥 Scrape more error:', error);
    
    // Send a more detailed error response
    res.status(500).json({ 
      error: `Failed to scrape additional listings: ${error.message}`,
      details: error.stack
    });
  }
});

app.post('/generate-lowball', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: 'Not logged in' });
  }

  const { listingId } = req.body;
  console.log('Generating lowball message for listing ID:', listingId);
  
  if (!req.session.storedListings) {
    return res.status(404).json({ error: 'No stored listings found in session' });
  }
  
  const listing = req.session.storedListings[listingId];
  
  if (!listing) {
    return res.status(404).json({ error: `Listing ${listingId} not found` });
  }

  console.log('Found listing for lowball message:', listing.title);

  const config = req.session.llmConfig;
  if (!config) {
    return res.status(400).json({ error: 'LLM configuration not found' });
  }
  
  if (config.provider === 'none') {
    return res.status(400).json({ error: 'AI features are disabled. Please select an LLM provider to use lowball generation features.' });
  }
  
  try {
    const lowballMessage = await generateLowballMessage(listing, config.provider, config);
    res.json({ message: lowballMessage });
  } catch (error) {
    console.error('Lowball message generation error:', error);
    res.status(500).json({ error: error.message });
  }
});
app.get('/', (req, res) => {
  if (req.session.loggedIn) {
    return res.redirect('/search');
  }
  
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Miata Maestro - Login</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode">
    <span id="theme-icon">🌙</span>
  </button>
  <div class="login-container">
    <div class="login-box">
      <div class="logo">🏎️</div>
      <div class="tagline">Miata Maestro</div>
      <p class="text-muted" style="margin-bottom: 24px; font-size: 17px;">
        Find your perfect NA Miata on Facebook Marketplace
      </p>
      
      <form method="POST" action="/login">
        <div class="form-group">
          <input type="email" name="email" class="form-input" placeholder="Email address" required>
        </div>
        <div class="form-group">
          <input type="password" name="password" class="form-input" placeholder="Password" required>
        </div>
        <button type="submit" class="btn-primary">Log In</button>
      </form>
      
      <div class="divider"></div>
      
      <p class="text-muted" style="font-size: 14px; line-height: 1.4;">
        Your Facebook credentials are used only to access Marketplace and are not stored.
      </p>
    </div>
  </div>

  <script>
    function toggleTheme() {
      const body = document.body;
      const themeIcon = document.getElementById('theme-icon');
      const currentTheme = body.getAttribute('data-theme');
      
      if (currentTheme === 'dark') {
        body.removeAttribute('data-theme');
        themeIcon.textContent = '🌙';
        localStorage.setItem('theme', 'light');
      } else {
        body.setAttribute('data-theme', 'dark');
        themeIcon.textContent = '☀️';
        localStorage.setItem('theme', 'dark');
      }
    }

    // Load saved theme
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
      document.getElementById('theme-icon').textContent = '☀️';
    }
  </script>
</body>
</html>
  `);
});
app.post('/login', (req, res) => {
  req.session.credentials = {
    email: req.body.email,
    password: req.body.password
  };
  req.session.loggedIn = true;
  res.redirect('/search');
});
app.get('/search', (req, res) => {
  if (!req.session.loggedIn) {
    return res.redirect('/');
  }
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Miata Maestro - Search</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode">
    <span id="theme-icon">🌙</span>
  </button>
  <div class="search-container">
    <div class="header">
      <div class="header-logo">
        <span class="marketplace-icon">🏪</span>
        Miata Marketplace
      </div>
      <form method="POST" action="/logout" style="margin: 0;">
        <button type="submit" class="logout-btn">Log Out</button>
      </form>
    </div>
    <div class="main-content">
      <div class="search-card">
        <div class="search-title">🔍 Search Parameters</div>
        <form method="POST" action="/scrape">
          <div class="form-row">
            <div>
              <label class="form-label">ZIP Code</label>
              <input type="text" name="zip" class="form-input" value="90210" required>
            </div>
            <div>
              <label class="form-label">Search Radius (miles)</label>
              <input type="number" name="radius" class="form-input" value="50" min="1" max="500" required>
            </div>
          </div>
          <div class="form-row">
            <div>
              <label class="form-label">Min Year</label>
              <input type="number" name="yearMin" class="form-input" value="1990" min="1989" max="1997" required>
            </div>
            <div>
              <label class="form-label">Max Year</label>
              <input type="number" name="yearMax" class="form-input" value="1997" min="1989" max="1997" required>
            </div>
          </div>
          <div class="form-row">
            <div>
              <label class="form-label">Max Mileage</label>
              <input type="number" name="maxMileage" class="form-input" value="100000" min="0" step="1000" required>
            </div>
            <div>
              <label class="form-label">Max Price (optional)</label>
              <input type="number" name="maxPrice" class="form-input" placeholder="No limit" min="0" step="100">
            </div>
          </div>
          <div class="form-row">
            <div>
              <label class="form-label">Number of Results</label>
              <input type="number" name="limit" class="form-input" value="20" min="1" max="100" required>
            </div>
            <div>
              <label class="form-label">Browser Mode</label>
              <select name="headless" class="form-select">
                <option value="true">Headless (faster)</option>
                <option value="false">Visible (debugging)</option>
              </select>
            </div>
          </div>
          
          <div class="form-row single">
            <div>
              <label class="form-label">LLM Provider (for on-demand evaluation)</label>
              <select name="provider" class="form-select">
                <option value="none">None (Disable AI Features)</option>
                <option value="ollama">Ollama (Local)</option>
                <option value="gpt-oss">llama3.1:8b</option>
              </select>
            </div>
          </div>
          <div class="form-row" id="llm-config">
            <div>
              <label class="form-label">Ollama Port</label>
              <input type="number" name="ollamaPort" class="form-input" value="11434" min="1" max="65535">
            </div>
            <div>
              <label class="form-label">llama3.1:8b URL</label>
              <input type="url" name="gptossUrl" class="form-input" value="http://localhost:8000/v1/complete">
            </div>
          </div>
          <button type="submit" class="search-btn">🚗 Find My Miata</button>
        </form>
      </div>
      <div class="search-card">
        <div class="search-title">ℹ️ About This Search</div>
        <p class="text-muted" style="line-height: 1.5;">
          This tool searches Facebook Marketplace for first-generation Mazda Miatas (NA, 1989-1997). 
          After finding listings, you can click "Get AI Evaluation" on individual listings for detailed analysis using llama3.1:8b.
        </p>
      </div>

      <div class="search-card">
        <div class="search-title">🗺️ Roadmap</div>
        <div class="text-muted" style="line-height: 1.6;">
          <h4 style="color: var(--clr-primary); margin: 12px 0 8px 0;">✅ Recently Added</h4>
          <ul style="margin: 0 0 16px 20px;">
            <li>Dark mode support with theme persistence</li>
            <li>CSV export functionality for listings data</li>
            <li>Enhanced AI evaluation with lowball message generation</li>
          </ul>
          
          <h4 style="color: var(--clr-secondary); margin: 12px 0 8px 0;">🔨 Coming Soon</h4>
          <ul style="margin: 0 0 16px 20px;">
            <li>Price history tracking and alerts</li>
            <li>Advanced filtering (color, transmission, modifications)</li>
            <li>Saved searches and email notifications</li>
            <li>Multiple marketplace support (AutoTrader, Cars.com)</li>
          </ul>
          
          <h4 style="color: var(--clr-accent); margin: 12px 0 8px 0;">💡 Future Ideas</h4>
          <ul style="margin: 0 0 8px 20px;">
            <li>Mobile app for iOS and Android</li>
            <li>VIN decoder integration</li>
            <li>Community reviews and ratings</li>
            <li>Market value estimation AI</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
  <script>
    const providerSelect = document.querySelector('select[name="provider"]');
    const ollamaField = document.querySelector('input[name="ollamaPort"]').parentElement;
    const gptossField = document.querySelector('input[name="gptossUrl"]').parentElement;
    const llmConfigRow = document.getElementById('llm-config');
    function toggleLLMFields() {
      if (providerSelect.value === 'none') {
        llmConfigRow.style.display = 'none';
      } else if (providerSelect.value === 'ollama') {
        llmConfigRow.style.display = 'flex';
        ollamaField.style.display = 'block';
        gptossField.style.display = 'none';
      } else {
        llmConfigRow.style.display = 'flex';
        ollamaField.style.display = 'none';
        gptossField.style.display = 'block';
      }
    }
    providerSelect.addEventListener('change', toggleLLMFields);
    toggleLLMFields();

    function toggleTheme() {
      const body = document.body;
      const themeIcon = document.getElementById('theme-icon');
      const currentTheme = body.getAttribute('data-theme');
      
      if (currentTheme === 'dark') {
        body.removeAttribute('data-theme');
        themeIcon.textContent = '🌙';
        localStorage.setItem('theme', 'light');
      } else {
        body.setAttribute('data-theme', 'dark');
        themeIcon.textContent = '☀️';
        localStorage.setItem('theme', 'dark');
      }
    }

    // Load saved theme
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
      document.getElementById('theme-icon').textContent = '☀️';
    }
  </script>
</body>
</html>
  `);
});
app.post('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});
app.get('/scrape-results', async (req, res) => {
  console.log('🔍 Scrape-results endpoint called');
  
  if (!req.session.loggedIn) {
    console.log('❌ No login session found, redirecting to login');
    return res.redirect('/');
  }
  if (!req.session.searchParams) {
    console.log('❌ No search params found in session, redirecting to search');
    return res.redirect('/search');
  }
  const opts = { ...req.session.searchParams, debug: req.query.debug };
  
  try {
    const { results, storedListings } = await scrapeMarketplace(opts, req.sessionID, progressStore, updateProgress);
    
    // Store results in session
    req.session.storedListings = storedListings;
    
    const listingsHtml = results.map(r => `
      <div class="listing" data-listing-id="${r.id}">
        <div class="listing-title">
          <a href="${r.url}" target="_blank">${r.title}</a>
        </div>
        <div class="listing-meta">
          <span class="price">$${r.price?.toLocaleString() || 'N/A'}</span>
          ${r.year ? ` • ${r.year}` : ''}
          ${r.transmission ? ` • ${r.transmission}` : ''}
        </div>
        
        <div class="listing-details">
          <strong>Mileage:</strong> ${r.mileage !== undefined && r.mileage !== null ? r.mileage.toLocaleString() + ' miles' : 'N/A'}<br>
          ${r.description ? `<strong>Description:</strong> ${r.description.substring(0, 200)}${r.description.length > 200 ? '...' : ''}` : ''}
        </div>
        
        ${r.images && r.images.length > 0 ? `
          <div class="listing-images">
            ${r.images.map(img => `<img src="${img}" alt="Car image" loading="lazy">`).join('')}
          </div>
        ` : ''}
        
        ${opts.provider !== 'none' ? `
          <button class="evaluate-btn" onclick="evaluateListing('${r.id}')">
            🤖 Get AI Evaluation
          </button>
          
          <div class="evaluation" id="evaluation-${r.id}">
            <strong>🤖 AI Analysis:</strong>
            <p id="evaluation-text-${r.id}"></p>
            <button class="lowball-btn" onclick="generateLowballMessage('${r.id}')" style="display: none;">
              💬 Generate Lowball Message
            </button>
            <div class="lowball-message" id="lowball-${r.id}" style="display: none;">
              <strong>💬 Lowball Message:</strong>
              <p id="lowball-text-${r.id}"></p>
              <button class="copy-btn" onclick="copyLowballMessage('${r.id}')">
                📋 Copy Message
              </button>
            </div>
          </div>
        ` : ''}
      </div>
    `).join('');

    req.session.llmConfig = {
      provider: opts.provider,
      ollamaPort: opts.ollamaPort,
      gptossUrl: opts.gptossUrl
    };

    const isDebugMode = opts.debug === 'true';
    return res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Miata Maestro - Results</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode">
    <span id="theme-icon">🌙</span>
  </button>
  <div class="results-container">
    <div class="header">
      <div class="header-logo">
        <span class="marketplace-icon">🏪</span>
        Miata Marketplace
      </div>
      <form method="POST" action="/logout" style="margin: 0;">
        <button type="submit" class="logout-btn">Log Out</button>
      </form>
    </div>
    
    <div class="main-content">
      <a href="/search" class="back-btn">← New Search</a>
      
      <div class="search-card">
        <div class="search-title">🏎️ Found ${results.length} Miata${results.length === 1 ? '' : 's'}</div>
        <p class="text-muted">
          Searched within ${opts.radius} miles of ${opts.zip} • 
          ${opts.yearMin}-${opts.yearMax} • 
          Under ${parseInt(opts.maxMileage).toLocaleString()} miles
          ${opts.maxPrice ? ` • Under $${parseInt(opts.maxPrice).toLocaleString()}` : ''}
          ${isDebugMode ? ' • DEBUG MODE (limited results)' : ''}
        </p>
        ${opts.provider !== 'none' ? `
          <p class="text-secondary" style="font-weight: 600; margin-top: 8px;">
            Click "Get AI Evaluation" on any listing for detailed analysis using llama3.2:3b!
          </p>
        ` : ''}
      </div>
      
      <div class="action-buttons" style="margin-bottom: 20px;">
        ${opts.provider !== 'none' ? `
          <button class="action-btn" onclick="analyzeAllListings()" id="analyze-all-btn">
            🤖 Analyze All Listings
          </button>
        ` : ''}
        <button class="action-btn" onclick="scrapeMoreListings()" id="scrape-more-btn">
          🔍 Scrape 10 More Cars
        </button>
        <button class="csv-export-btn" onclick="exportToCSV()" id="csv-export-btn" ${results.length === 0 ? 'disabled' : ''}>
          📊 Export to CSV
        </button>
      </div>
      
      ${listingsHtml}
      
      ${results.length === 0 ? `
        <div class="search-card">
          <div class="search-title">😔 No Results Found</div>
          <p class="text-muted">
            Try expanding your search radius, increasing the maximum mileage, 
            or adjusting the year range to find more Miatas.
          </p>
        </div>
      ` : ''}
    </div>
  </div>
  
  <script>
    async function evaluateListing(listingId) {
      const button = document.querySelector('[data-listing-id="' + listingId + '"] .evaluate-btn');
      const evaluationDiv = document.getElementById('evaluation-' + listingId);
      const evaluationText = document.getElementById('evaluation-text-' + listingId);
      const lowballBtn = document.querySelector('[data-listing-id="' + listingId + '"] .lowball-btn');
      
      button.innerHTML = '<span class="mini-spinner"></span>Analyzing...';
      button.disabled = true;
      
      try {
        const response = await fetch('/evaluate-listing', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            listingId: listingId
          })
        });
        
        const data = await response.json();
        
        if (data.error) {
          evaluationText.innerHTML = 'Error: ' + data.error;
        } else {
          evaluationText.innerHTML = data.evaluation.replace(/\\n/g, '<br>');
          lowballBtn.style.display = 'inline-block';
        }
        
        evaluationDiv.classList.add('show');
        
      } catch (error) {
        evaluationText.innerHTML = 'Failed to get evaluation: ' + error.message;
        evaluationDiv.classList.add('show');
      } finally {
        button.innerHTML = '✅ Evaluated';
        button.style.background = '#27ae60';
      }
    }

    async function generateLowballMessage(listingId) {
      const button = document.querySelector('[data-listing-id="' + listingId + '"] .lowball-btn');
      const lowballDiv = document.getElementById('lowball-' + listingId);
      const lowballText = document.getElementById('lowball-text-' + listingId);
      
      button.innerHTML = '<span class="mini-spinner"></span>Generating...';
      button.disabled = true;
      
      try {
        const response = await fetch('/generate-lowball', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            listingId: listingId
          })
        });
        
        const data = await response.json();
        
        if (data.error) {
          lowballText.innerHTML = 'Error: ' + data.error;
        } else {
          lowballText.textContent = data.message;
        }
        
        lowballDiv.style.display = 'block';
        
      } catch (error) {
        lowballText.innerHTML = 'Failed to generate message: ' + error.message;
        lowballDiv.style.display = 'block';
      } finally {
        button.innerHTML = '✅ Generated';
        button.style.background = '#27ae60';
      }
    }

    async function copyLowballMessage(listingId) {
      const button = document.querySelector('[data-listing-id="' + listingId + '"] .copy-btn');
      const lowballText = document.getElementById('lowball-text-' + listingId);
      
      try {
        const textContent = lowballText.textContent || lowballText.innerText;
        await navigator.clipboard.writeText(textContent);
        
        button.innerHTML = '✅ Copied!';
        button.classList.add('copied');
        
        setTimeout(() => {
          button.innerHTML = '📋 Copy Message';
          button.classList.remove('copied');
        }, 2000);
        
      } catch (error) {
        const textArea = document.createElement('textarea');
        textArea.value = lowballText.textContent || lowballText.innerText;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        
        button.innerHTML = '✅ Copied!';
        button.classList.add('copied');
        
        setTimeout(() => {
          button.innerHTML = '📋 Copy Message';
          button.classList.remove('copied');
        }, 2000);
      }
    }

    async function analyzeAllListings() {
      const button = document.getElementById('analyze-all-btn');
      const originalText = button.innerHTML;
      
      button.innerHTML = '<span class="mini-spinner"></span>Analyzing all listings...';
      button.disabled = true;
      
      try {
        const response = await fetch('/analyze-all', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          }
        });
        
        const data = await response.json();
        
        if (data.error) {
          alert('Error: ' + data.error);
          return;
        }
        
        // Update all listing evaluations with the results
        Object.keys(data.results).forEach(listingId => {
          const result = data.results[listingId];
          const evaluationDiv = document.getElementById('evaluation-' + listingId);
          const evaluationText = document.getElementById('evaluation-text-' + listingId);
          const lowballBtn = document.querySelector('[data-listing-id="' + listingId + '"] .lowball-btn');
          const evaluateBtn = document.querySelector('[data-listing-id="' + listingId + '"] .evaluate-btn');
          
          if (result.error) {
            evaluationText.innerHTML = 'Error: ' + result.error;
          } else {
            evaluationText.innerHTML = result.evaluation.replace(/\\n/g, '<br>');
            if (lowballBtn) lowballBtn.style.display = 'inline-block';
          }
          
          if (evaluationDiv) evaluationDiv.classList.add('show');
          if (evaluateBtn) {
            evaluateBtn.innerHTML = '✅ Evaluated';
            evaluateBtn.style.background = '#27ae60';
          }
        });
        
        button.innerHTML = '✅ All Analyzed (' + data.processed + '/' + data.total + ')';
        button.style.background = '#27ae60';
        
      } catch (error) {
        alert('Failed to analyze listings: ' + error.message);
        button.innerHTML = originalText;
        button.disabled = false;
      }
    }

    async function scrapeMoreListings() {
      const button = document.getElementById('scrape-more-btn');
      const originalText = button.innerHTML;
      
      button.innerHTML = '<span class="mini-spinner"></span>Scraping more listings...';
      button.disabled = true;
      
      try {
        const response = await fetch('/scrape-more', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          }
        });
        
        const data = await response.json();
        
        if (data.error) {
          console.error('Scrape more error response:', data);
          alert('Error: ' + data.error);
          button.innerHTML = originalText;
          button.disabled = false;
          return;
        }
        
        console.log('Scrape more success:', data);
        
        // Check if we actually got new listings
        if (data.newCount === 0) {
          button.innerHTML = '⚠️ No new listings found';
          button.style.background = '#f39c12';
          setTimeout(() => {
            button.innerHTML = originalText;
            button.style.background = '';
            button.disabled = false;
          }, 3000);
          return;
        }
        
        // Add new listings to the page
        const mainContent = document.querySelector('.main-content');
        const actionButtons = document.querySelector('.action-buttons');
        
        data.results.forEach(result => {
          const listingHtml = \`
            <div class="listing" data-listing-id="\${result.id}">
              <div class="listing-title">
                <a href="\${result.url}" target="_blank">\${result.title}</a>
              </div>
              <div class="listing-meta">
                <span class="price">$\${result.price?.toLocaleString() || 'N/A'}</span>
                \${result.year ? \` • \${result.year}\` : ''}
                \${result.transmission ? \` • \${result.transmission}\` : ''}
              </div>
              
              <div class="listing-details">
                <strong>Mileage:</strong> \${result.mileage !== undefined && result.mileage !== null ? result.mileage.toLocaleString() + ' miles' : 'N/A'}<br>
                \${result.description ? \`<strong>Description:</strong> \${result.description.substring(0, 200)}\${result.description.length > 200 ? '...' : ''}\` : ''}
              </div>
              
              \${result.images && result.images.length > 0 ? \`
                <div class="listing-images">
                  \${result.images.map(img => \`<img src="\${img}" alt="Car image" loading="lazy">\`).join('')}
                </div>
              \` : ''}
              
              \${${opts.provider !== 'none' ? 'true' : 'false'} ? \`
                <button class="evaluate-btn" onclick="evaluateListing('\${result.id}')">
                  🤖 Get AI Evaluation
                </button>
                
                <div class="evaluation" id="evaluation-\${result.id}">
                  <strong>🤖 AI Analysis:</strong>
                  <p id="evaluation-text-\${result.id}"></p>
                  <button class="lowball-btn" onclick="generateLowballMessage('\${result.id}')" style="display: none;">
                    💬 Generate Lowball Message
                  </button>
                  <div class="lowball-message" id="lowball-\${result.id}" style="display: none;">
                    <strong>💬 Lowball Message:</strong>
                    <p id="lowball-text-\${result.id}"></p>
                    <button class="copy-btn" onclick="copyLowballMessage('\${result.id}')">
                      📋 Copy Message
                    </button>
                  </div>
                </div>
              \` : ''}
            </div>
          \`;
          
          // Insert new listing after the action buttons
          actionButtons.insertAdjacentHTML('afterend', listingHtml);
        });
        
        // Update button text with new count
        button.innerHTML = \`✅ Added \${data.newCount} more (Total: \${data.totalCount})\`;
        button.style.background = '#27ae60';
        
        // Update the search card title
        const searchTitle = document.querySelector('.search-title');
        if (searchTitle && searchTitle.textContent.includes('Found')) {
          searchTitle.textContent = searchTitle.textContent.replace(/Found \\d+/, \`Found \${data.totalCount}\`);
        }
        
      } catch (error) {
        alert('Failed to scrape more listings: ' + error.message);
        button.innerHTML = originalText;
        button.disabled = false;
      }
    }

    function toggleTheme() {
      const body = document.body;
      const themeIcon = document.getElementById('theme-icon');
      const currentTheme = body.getAttribute('data-theme');
      
      if (currentTheme === 'dark') {
        body.removeAttribute('data-theme');
        themeIcon.textContent = '🌙';
        localStorage.setItem('theme', 'light');
      } else {
        body.setAttribute('data-theme', 'dark');
        themeIcon.textContent = '☀️';
        localStorage.setItem('theme', 'dark');
      }
    }

    function exportToCSV() {
      // Get all listing data from the page
      const listings = [];
      const listingElements = document.querySelectorAll('[data-listing-id]');
      
      if (listingElements.length === 0) {
        alert('No listings found to export!');
        return;
      }
      
      listingElements.forEach(element => {
        const titleElement = element.querySelector('.listing-title a');
        const title = titleElement ? titleElement.textContent.trim() : 'N/A';
        
        const detailsElement = element.querySelector('.listing-details');
        const details = detailsElement ? detailsElement.textContent.replace(/\\n/g, ' ').trim() : 'N/A';
        
        const priceElement = element.querySelector('.price');
        const price = priceElement ? priceElement.textContent.trim() : 'N/A';
        
        const link = titleElement ? titleElement.href : 'N/A';
        
        const evaluationElement = element.querySelector('#evaluation-text-' + element.getAttribute('data-listing-id'));
        const evaluationText = evaluationElement && evaluationElement.textContent.trim() !== '' ? 
          evaluationElement.textContent.replace(/\\n/g, ' ').trim() : 'Not evaluated';
        
        const metaElement = element.querySelector('.listing-meta');
        const meta = metaElement ? metaElement.textContent.replace('$' + (price.replace('$', '')), '').trim() : 'N/A';
        
        listings.push({
          title,
          price,
          meta,
          details,
          evaluation: evaluationText,
          link
        });
      });

      // Create CSV content
      const headers = ['Title', 'Price', 'Year/Transmission', 'Details', 'AI Evaluation', 'Link'];
      const csvContent = [
        headers.join(','),
        ...listings.map(listing => [
          '"' + listing.title.replace(/"/g, '""') + '"',
          '"' + listing.price.replace(/"/g, '""') + '"',
          '"' + listing.meta.replace(/"/g, '""') + '"',
          '"' + listing.details.replace(/"/g, '""') + '"',
          '"' + listing.evaluation.replace(/"/g, '""') + '"',
          '"' + listing.link.replace(/"/g, '""') + '"'
        ].join(','))
      ].join('\\n');

      // Create and download the file
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', 'miata-listings-' + new Date().toISOString().split('T')[0] + '.csv');
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      
      // Show success message
      const button = document.getElementById('csv-export-btn');
      const originalText = button.innerHTML;
      button.innerHTML = '✅ Exported ' + listings.length + ' listings';
      button.style.background = '#27ae60';
      
      setTimeout(() => {
        button.innerHTML = originalText;
        button.style.background = '';
      }, 3000);
    }

    // Load saved theme
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
      document.getElementById('theme-icon').textContent = '☀️';
    }
  </script>
</body>
</html>
    `);

  } catch (err) {
    console.error('💥 MAJOR ERROR occurred during scraping:', err);
    
    return res.status(500).send(generateErrorPage(`
      <strong>Scraping failed with error:</strong><br>
      ${err.message}<br><br>
      <strong>Debug information:</strong><br>
      • Check the console output for detailed logs<br>
      • Error occurred at: ${new Date().toISOString()}<br><br>
      <strong>Common solutions:</strong><br>
      • Run in non-headless mode to see what's happening<br>
      • Check if your Facebook account is restricted<br>
      • Verify Marketplace access in your region
    `));
  }
});

app.post('/scrape', async (req, res) => {
  if (!req.session.loggedIn) {
    return res.redirect('/');
  }
  
  const opts = { ...req.body, ...req.session.credentials };
  req.session.searchParams = opts;
  
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Miata Maestro - Searching...</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode">
    <span id="theme-icon">🌙</span>
  </button>
  <div class="results-container">
    <div class="header">
      <div class="header-logo">
        <span class="marketplace-icon">🏪</span>
        Miata Marketplace
      </div>
    </div>
    
    <div class="main-content">
      <div class="loading">
        <div class="spinner">
          <div class="racecar-track">
            <div class="track-lines"></div>
          </div>
          <div class="racecar">
            <div class="racecar-wheels"></div>
          </div>
        </div>
        <h2 id="status-title">Searching for Miatas...</h2>
        <p id="status-details">This may take a few minutes while we scrape listings. AI evaluation using llama3.2:3b will be available on-demand for each result.</p>
        <div style="margin-top: 20px;">
          <button onclick="startScraping()" class="search-btn" id="startBtn">
            🚀 Start Scraping
          </button>
          <button onclick="endEarly()" class="search-btn" style="background-color: #e41e3f; margin-left: 10px;" id="endBtn">
            🛑 End Early (Debug)
          </button>
        </div>
      </div>
    </div>
  </div>
  
  <script>
    let eventSource = null;
    
    function connectToProgress() {
      eventSource = new EventSource('/progress');
      
      eventSource.onmessage = function(event) {
        const progress = JSON.parse(event.data);
        const titleElement = document.getElementById('status-title');
        const detailsElement = document.getElementById('status-details');
        
        // Update the title based on the step
        switch(progress.step) {
          case 'initializing':
            titleElement.textContent = 'Initializing...';
            break;
          case 'browser_start':
            titleElement.textContent = 'Starting browser...';
            break;
          case 'logging_in':
            titleElement.textContent = 'Logging into Facebook...';
            break;
          case 'navigating':
            titleElement.textContent = 'Navigating to Marketplace...';
            break;
          case 'searching':
            titleElement.textContent = 'Searching listings...';
            break;
          case 'extracting':
            titleElement.textContent = 'Extracting listing details...';
            break;
          case 'processing':
            titleElement.textContent = 'Processing results...';
            break;
          case 'complete':
            titleElement.textContent = 'Search complete!';
            break;
          default:
            titleElement.textContent = 'Searching for Miatas...';
        }
        
        // Update details if provided
        if (progress.details) {
          detailsElement.textContent = progress.details;
        }
      };
      
      eventSource.onerror = function(event) {
        console.log('SSE connection error:', event);
      };
    }
    
    function startScraping() {
      const btn = document.getElementById('startBtn');
      const endBtn = document.getElementById('endBtn');
      btn.disabled = true;
      endBtn.disabled = true;
      btn.innerHTML = '⏳ Scraping in progress...';
      
      // Start listening for progress updates
      connectToProgress();
      
      // Start the actual scraping process
      window.location.href = '/scrape-results';
    }
    
    function endEarly() {
      const btn = document.getElementById('startBtn');
      const endBtn = document.getElementById('endBtn');
      btn.disabled = true;
      endBtn.disabled = true;
      endBtn.innerHTML = '⏳ Setting up debug mode...';
      
      // Start listening for progress updates
      connectToProgress();
      
      window.location.href = '/scrape-results?debug=true';
    }

    function toggleTheme() {
      const body = document.body;
      const themeIcon = document.getElementById('theme-icon');
      const currentTheme = body.getAttribute('data-theme');
      
      if (currentTheme === 'dark') {
        body.removeAttribute('data-theme');
        themeIcon.textContent = '🌙';
        localStorage.setItem('theme', 'light');
      } else {
        body.setAttribute('data-theme', 'dark');
        themeIcon.textContent = '☀️';
        localStorage.setItem('theme', 'dark');
      }
    }

    // Load saved theme
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
      document.getElementById('theme-icon').textContent = '☀️';
    }
  </script>
</body>
</html>
  `);
});

app.get('/test', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Miata Maestro - System Test</title>
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  <button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode">
    <span id="theme-icon">🌙</span>
  </button>
  <div class="results-container">
    <div class="header">
      <div class="header-logo">
        <span class="marketplace-icon">🔧</span>
        System Test
      </div>
    </div>
    
    <div class="main-content">
      <div class="search-card">
        <div class="search-title">✅ System Status</div>
        <p style="color: #42b883; margin-bottom: 16px;">
          Server is running successfully!<br>
          Node.js version: ${process.version}<br>
          Current time: ${new Date().toISOString()}<br>
          LLM: llama3.2:3b via Ollama
        </p>
        <a href="/" class="back-btn">← Back to Login</a>
      </div>
    </div>
  </div>

  <script>
    function toggleTheme() {
      const body = document.body;
      const themeIcon = document.getElementById('theme-icon');
      const currentTheme = body.getAttribute('data-theme');
      
      if (currentTheme === 'dark') {
        body.removeAttribute('data-theme');
        themeIcon.textContent = '🌙';
        localStorage.setItem('theme', 'light');
      } else {
        body.setAttribute('data-theme', 'dark');
        themeIcon.textContent = '☀️';
        localStorage.setItem('theme', 'dark');
      }
    }

    // Load saved theme
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme === 'dark') {
      document.body.setAttribute('data-theme', 'dark');
      document.getElementById('theme-icon').textContent = '☀️';
    }
  </script>
</body>
</html>
  `);
});


const PORT = 3000;
app.listen(PORT, () => console.log(`🚀 Miata Maestro server running on http://localhost:${PORT}`));