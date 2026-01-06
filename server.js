const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const zlib = require('zlib'); // Included in Node.js standard library

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURATION
const PROXY_URL = 'https://web-prox.onrender.com'; // Make sure this matches your Render URL
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';

// --- HELPER: URL REWRITER ---
const rewriteBody = (body) => {
    if (typeof body !== 'string') return body;
    return body
        .replace(new RegExp(TARGET_MAIN, 'g'), PROXY_URL)
        .replace(new RegExp(TARGET_SOCKET, 'g'), PROXY_URL)
        .replace(/integrity="[^"]*"/g, ''); // Remove security checks
};

// --- MANUAL RESPONSE HANDLER ---
// This function manually processes the response to prevent Header crashes
const handleProxyRes = (proxyRes, req, res) => {
    let originalBody = [];

    // 1. Collect the data chunks as they arrive
    proxyRes.on('data', (chunk) => {
        originalBody.push(chunk);
    });

    // 2. Once all data is received, process it
    proxyRes.on('end', () => {
        const bodyBuffer = Buffer.concat(originalBody);
        let finalBody = bodyBuffer;
        const contentType = proxyRes.headers['content-type'] || '';

        // 3. Copy headers from the target to the client
        Object.keys(proxyRes.headers).forEach((key) => {
            // Skip these headers because we are modifying the content
            if (key === 'content-length' || key === 'content-encoding') return; 
            res.setHeader(key, proxyRes.headers[key]);
        });

        // 4. Force CORS and remove blocks
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.removeHeader('x-frame-options');
        res.removeHeader('content-security-policy');
        res.removeHeader('content-security-policy-report-only');

        // 5. If it's text/html/json, rewrite the URLs
        if (contentType.includes('text') || contentType.includes('application/javascript') || contentType.includes('application/json')) {
            try {
                let bodyString = bodyBuffer.toString('utf8');
                bodyString = rewriteBody(bodyString);
                finalBody = Buffer.from(bodyString);
            } catch (e) {
                console.error("Rewrite failed, sending original:", e);
            }
        }

        // 6. Send the final response
        res.status(proxyRes.statusCode);
        res.end(finalBody);
    });
};

const commonOptions = {
    changeOrigin: true,
    selfHandleResponse: true, // We are handling the response manually above
    onProxyReq: (proxyReq, req, res) => {
        // Ask for plain text (no gzip) so we can edit strings easily
        proxyReq.setHeader('Accept-Encoding', 'identity');
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
    },
    onProxyRes: handleProxyRes
};

// --- ROUTES ---

// 1. Socket.io Traffic
app.use('/socket.io', createProxyMiddleware({
    ...commonOptions,
    target: TARGET_SOCKET,
    ws: true 
}));

// 2. Main Traffic
app.use('/', createProxyMiddleware({
    ...commonOptions,
    target: TARGET_MAIN,
}));

app.listen(PORT, () => console.log(`Manual Rewriter Proxy running on ${PORT}`));
