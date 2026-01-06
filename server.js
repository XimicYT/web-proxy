const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// This helps the proxy handle images, scripts, and css correctly
app.get('/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('No URL provided');

    try {
        const targetUrl = new URL(url);
        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });

        const contentType = response.headers.get('content-type');
        
        // If it's an image or font, just pipe it through
        if (!contentType || !contentType.includes('text/html')) {
            const buffer = await response.buffer();
            res.setHeader('Content-Type', contentType);
            return res.send(buffer);
        }

        // If it's HTML, we need to REWRITE links so they stay inside the proxy
        let body = await response.text();
        const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
        const proxyBase = `${req.protocol}://${req.get('host')}/proxy?url=`;

        // 1. Fix Absolute Paths (e.g., /_next/static...)
        body = body.replace(/(src|href|action)="\/(?!\/)/g, `$1="${proxyBase}${baseUrl}/`);
        
        // 2. Fix Protocol-relative Paths (e.g., //fonts.gstatic.com)
        body = body.replace(/(src|href)="\/\//g, `$1="${proxyBase}https://`);

        // 3. Fix CSS/JS files that are often missed
        body = body.replace(/url\(['"]?\/(?!\/)/g, `url(${proxyBase}${baseUrl}/`);

        res.setHeader('Content-Type', 'text/html');
        res.send(body);
    } catch (err) {
        res.status(500).send("Proxy Error: " + err.message);
    }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`Heavy Proxy running on ${PORT}`));
