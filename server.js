const express = require('express');
const httpProxy = require('http-proxy');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const proxy = httpProxy.createProxyServer({});
const PORT = process.env.PORT || 3000;

app.use(cookieParser());

// 1. Main UI
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. The Proxy Logic
app.all('/proxy', (req, res) => {
    let target = req.query.url;

    // If no URL in query, check our cookie to see where we are
    if (!target && req.cookies.current_site) {
        target = req.cookies.current_site + req.url.replace('/proxy', '');
    }

    if (!target) return res.status(400).send("No target specified.");

    const targetUrl = new URL(target);
    
    // Save the site root in a cookie so sub-resources (CSS/JS) know where to go
    res.cookie('current_site', targetUrl.origin, { path: '/' });

    proxy.web(req, res, {
        target: targetUrl.origin,
        changeOrigin: true,
        selfHandleResponse: false,
        followRedirects: true
    }, (e) => {
        res.status(500).send("Proxy Error: " + e.message);
    });
});

// 3. Catch-all for assets (Next.js, images, etc.)
app.all('*', (req, res) => {
    const targetBase = req.cookies.current_site;
    if (targetBase) {
        proxy.web(req, res, { target: targetBase, changeOrigin: true });
    } else {
        res.status(404).send("Please enter a URL first.");
    }
});

app.listen(PORT, () => console.log(`Heavy Proxy running on ${PORT}`));
