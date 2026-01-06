const express = require('express');
const httpProxy = require('http-proxy');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());

// Create the Proxy
const proxy = httpProxy.createProxyServer({
    followRedirects: true,
    changeOrigin: true,
    selfHandleResponse: false,
    secure: false // Ignores SSL certificate errors from target
});

// --- ERROR HANDLING ---
proxy.on('error', (err, req, res) => {
    console.error("Proxy Error:", err);
    res.status(500).end();
});

// --- THE MAGIC: HEADER MANIPULATION ---
proxy.on('proxyRes', (proxyRes, req, res) => {
    // 1. Delete headers that block iframes
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['content-security-policy-report-only'];
    delete proxyRes.headers['x-content-type-options'];

    // 2. Fix Redirects (301/302)
    // If the site tries to redirect to https://google.com, we capture it
    // and force it back through our proxy URL.
    if (proxyRes.headers['location']) {
        let location = proxyRes.headers['location'];
        if (location.startsWith('http')) {
            const newUrl = new URL(location);
            res.cookie('target_site', newUrl.origin, { path: '/' });
            proxyRes.headers['location'] = `/proxy?url=${encodeURIComponent(location)}`;
        }
    }

    // 3. Fix Cookies
    // If the site sets a cookie for ".pkmn.gg", we strip the domain
    // so your localhost browser accepts it.
    if (proxyRes.headers['set-cookie']) {
        proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(c => 
            c.replace(/Domain=[^;]+;/gi, '')
        );
    }
});

// --- ROUTE 1: THE UI ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- ROUTE 2: THE PROXY HANDLER ---
app.use((req, res) => {
    // Ignore favicon requests to keep logs clean
    if (req.url === '/favicon.ico') return res.status(404).end();

    let target = '';
    let reqPath = req.url;

    // A. Is this a new request from the search bar?
    if (req.url.startsWith('/proxy')) {
        const queryUrl = req.query.url;
        if (!queryUrl) return res.status(400).send("No URL provided");
        
        try {
            const targetObj = new URL(queryUrl);
            target = targetObj.origin; // https://pkmn.gg
            reqPath = targetObj.pathname + targetObj.search; // /cards/charizard
            
            // Save this new target in a cookie so assets (css/js) know where to go
            res.cookie('target_site', target, { path: '/' });
        } catch (e) {
            return res.status(400).send("Invalid URL");
        }
    } 
    // B. Or is this a background asset (CSS, JS, Images)?
    else {
        target = req.cookies.target_site;
        if (!target) {
            // If we don't know where to go, go back to home
            return res.redirect('/');
        }
    }

    console.log(`[${req.method}] Proxying to: ${target}${reqPath}`);

    // Set the URL manually to ensure the target receives the correct path
    req.url = reqPath;

    proxy.web(req, res, {
        target: target,
        headers: {
            // Spoof User Agent to look like a real PC, not a bot
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
            'Referer': target
        }
    });
});

app.listen(PORT, () => {
    console.log(`\n>>> ENTERPRISE PROXY RUNNING ON PORT ${PORT}`);
    console.log(`>>> Open http://localhost:${PORT}\n`);
});
