const express = require('express');
const fetch = require('node-fetch');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// --- THE LOGIC ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// This matches ANY path (e.g., /_next/static, /api/auth)
app.get('*', async (req, res) => {
    // Get the target URL from the query or reconstruct it
    let targetUrl = req.query.url;

    // If there's no URL in query, the browser is likely requesting a sub-resource (like a CSS file)
    // We need to know what the 'Referer' was to know which site to proxy
    if (!targetUrl) {
        const referer = req.headers.referer;
        if (referer && referer.includes('url=')) {
            const originSite = new URL(referer).searchParams.get('url');
            const originUrl = new URL(originSite);
            targetUrl = originUrl.origin + req.url;
        } else {
            return res.status(404).send('Not found');
        }
    }

    try {
        const response = await fetch(targetUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                'Accept': req.headers.accept
            }
        });

        const contentType = response.headers.get('content-type');
        
        // If it's NOT HTML, just stream the data (images, scripts, fonts)
        if (!contentType || !contentType.includes('text/html')) {
            const buffer = await response.buffer();
            res.setHeader('Content-Type', contentType);
            // Force HTTPS for everything to kill 'Mixed Content' errors
            res.setHeader('Content-Security-Policy', 'upgrade-insecure-requests');
            return res.send(buffer);
        }

        // If it IS HTML, inject a <base> tag. 
        // This tells the browser: "If you see a link like /style.css, look at the target site, not my server"
        let body = await response.text();
        const targetObj = new URL(targetUrl);
        const baseTag = `<head><base href="${targetObj.origin}${targetObj.pathname}">`;
        body = body.replace('<head>', baseTag);

        // Kill any scripts that try to break out of iframes
        body = body.replace(/window\.top !== window\.self/g, 'false');
        body = body.replace(/if \(top !== self\)/g, 'if (false)');

        res.setHeader('Content-Type', 'text/html');
        res.send(body);
    } catch (err) {
        res.status(500).send("Proxy error: " + err.message);
    }
});

app.listen(PORT, () => console.log(`Ultimate Proxy active on ${PORT}`));
