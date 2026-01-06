const express = require('express');
const httpProxy = require('http-proxy');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());

// Create Proxy
const proxy = httpProxy.createProxyServer({
    followRedirects: true,
    changeOrigin: true,
    selfHandleResponse: false,
    secure: false
});

proxy.on('error', (err, req, res) => {
    console.error("Proxy Error:", err);
    res.status(500).end();
});

proxy.on('proxyRes', (proxyRes, req, res) => {
    // 1. Remove Security Headers
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['content-security-policy-report-only'];
    delete proxyRes.headers['x-content-type-options'];

    // 2. Fix Redirects
    if (proxyRes.headers['location']) {
        let location = proxyRes.headers['location'];
        if (location.startsWith('http')) {
            const newUrl = new URL(location);
            // Secure cookie for cross-site usage
            res.cookie('target_site', newUrl.origin, { path: '/', sameSite: 'none', secure: true });
            proxyRes.headers['location'] = `https://web-prox.onrender.com/proxy?url=${encodeURIComponent(location)}`;
        }
    }

    // 3. Fix Set-Cookie for cross-site
    if (proxyRes.headers['set-cookie']) {
        proxyRes.headers['set-cookie'] = proxyRes.headers['set-cookie'].map(c => 
            c.replace(/Domain=[^;]+;/gi, '') + '; SameSite=None; Secure'
        );
    }
});

app.get('/', (req, res) => {
    res.send('Proxy Backend is Running. Use your local index.html file.');
});

app.use((req, res) => {
    if (req.url === '/favicon.ico') return res.status(404).end();

    let target = '';
    let reqPath = req.url;

    // Handle new request
    if (req.url.startsWith('/proxy')) {
        const queryUrl = req.query.url;
        if (!queryUrl) return res.status(400).send("No URL provided");
        
        try {
            const targetObj = new URL(queryUrl);
            target = targetObj.origin;
            reqPath = targetObj.pathname + targetObj.search;
            
            // IMPORTANT: Set cookie with SameSite: None for local file access
            res.cookie('target_site', target, { path: '/', sameSite: 'none', secure: true });
        } catch (e) {
            return res.status(400).send("Invalid URL");
        }
    } 
    // Handle Assets
    else {
        target = req.cookies.target_site;
        if (!target) return res.status(404).send("No session found");
    }

    req.url = reqPath;

    proxy.web(req, res, {
        target: target,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
            'Referer': target
        }
    });
});

app.listen(PORT, () => console.log(`Proxy running on ${PORT}`));
