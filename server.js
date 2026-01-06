const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const zlib = require('zlib');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURATION
// NOTE: We don't need to hardcode your Render URL here anymore.
// The script below calculates it automatically.
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';

// --- THE BRAIN IMPLANT SCRIPT ---
// This script runs inside the user's browser, NOT on the server.
const CLIENT_INJECTION = `
<script>
(function() {
    console.log("--- PROXY INTERCEPTOR ACTIVE ---");

    // 1. KILL SERVICE WORKERS (Critical)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(registrations) {
            for(let registration of registrations) {
                console.log("Killing Service Worker:", registration);
                registration.unregister();
            }
        });
        // Disable future registration
        navigator.serviceWorker.register = () => Promise.resolve();
    }

    // 2. INTERCEPT FETCH REQUESTS
    const originalFetch = window.fetch;
    window.fetch = function(url, options) {
        if (typeof url === 'string') {
            // Redirect API calls to relative paths (which go to the proxy)
            if (url.includes('pkmn.gg')) {
                url = url.replace('https://www.pkmn.gg', '');
                url = url.replace('https://sockets.pkmn.gg', '');
            }
        }
        return originalFetch(url, options);
    };

    // 3. INTERCEPT XMLHTTPREQUEST (AJAX)
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string') {
            if (url.includes('pkmn.gg')) {
                url = url.replace('https://www.pkmn.gg', '');
                url = url.replace('https://sockets.pkmn.gg', '');
            }
        }
        return originalOpen.apply(this, arguments);
    };
})();
</script>
`;

// --- MANUAL RESPONSE HANDLER ---
const handleProxyRes = (proxyRes, req, res) => {
    let originalBody = [];
    proxyRes.on('data', (chunk) => originalBody.push(chunk));
    proxyRes.on('end', () => {
        const bodyBuffer = Buffer.concat(originalBody);
        let finalBody = bodyBuffer;
        const contentType = proxyRes.headers['content-type'] || '';

        // Copy headers (excluding ones we manage)
        Object.keys(proxyRes.headers).forEach((key) => {
            if (key === 'content-length' || key === 'content-encoding') return;
            res.setHeader(key, proxyRes.headers[key]);
        });

        // Set Access Headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.removeHeader('x-frame-options');
        res.removeHeader('content-security-policy');

        // INJECT THE SCRIPT into HTML pages
        if (contentType.includes('text/html')) {
            try {
                let bodyString = bodyBuffer.toString('utf8');
                // Insert our script right after <head>
                bodyString = bodyString.replace('<head>', '<head>' + CLIENT_INJECTION);
                // Also do a basic replace for the initial load
                bodyString = bodyString.replace(new RegExp(TARGET_MAIN, 'g'), ''); 
                finalBody = Buffer.from(bodyString);
            } catch (e) {
                console.error("Injection failed:", e);
            }
        }

        res.status(proxyRes.statusCode);
        res.end(finalBody);
    });
};

const commonOptions = {
    changeOrigin: true,
    selfHandleResponse: true,
    onProxyReq: (proxyReq, req, res) => {
        proxyReq.setHeader('Accept-Encoding', 'identity'); // No gzip
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
    },
    onProxyRes: handleProxyRes
};

// --- ROUTES ---

// Socket.io specific handling
app.use('/socket.io', createProxyMiddleware({
    target: TARGET_SOCKET,
    changeOrigin: true,
    ws: true, // Enable Websockets
    onProxyReq: (proxyReq) => {
        proxyReq.setHeader('Origin', TARGET_MAIN); // Fool the socket server
    }
}));

// Everything else
app.use('/', createProxyMiddleware({
    ...commonOptions,
    target: TARGET_MAIN,
}));

app.listen(PORT, () => console.log(`Injection Proxy running on ${PORT}`));
