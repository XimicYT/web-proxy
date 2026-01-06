const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURATION
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';

// --- 1. PRE-FLIGHT INTERCEPTOR (The Doorman) ---
// This answers "Yes" to every browser security check (OPTIONS request)
// immediately, so the browser never gets a "No" from the real server.
app.use((req, res, next) => {
    // precise CORS headers for the browser
    const origin = req.headers.origin || '*';
    
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, *');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
        return res.sendStatus(200); // Stop here and say "OK"
    }
    next(); // Continue to the proxy for other requests
});

// --- 2. THE BRAIN IMPLANT (Client-Side Script) ---
const CLIENT_INJECTION = `
<script>
(function() {
    console.log("--- PROXY INTERCEPTOR V3: SCORCHED EARTH ---");

    // KILL SERVICE WORKERS
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(registrations) {
            for(let registration of registrations) {
                registration.unregister();
            }
        });
        navigator.serviceWorker.register = () => Promise.resolve();
    }

    // OVERRIDE FETCH
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        // If it's a Request object, recreate it to modify the URL
        if (input instanceof Request) {
            if (input.url.includes('pkmn.gg')) {
                const newUrl = input.url.replace('https://www.pkmn.gg', '')
                                        .replace('https://sockets.pkmn.gg', '');
                input = new Request(newUrl, input);
            }
        } 
        // If it's a string URL
        else if (typeof input === 'string') {
            if (input.includes('pkmn.gg')) {
                input = input.replace('https://www.pkmn.gg', '')
                             .replace('https://sockets.pkmn.gg', '');
            }
        }
        return originalFetch(input, init);
    };

    // OVERRIDE XMLHTTPREQUEST
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string' && url.includes('pkmn.gg')) {
            url = url.replace('https://www.pkmn.gg', '')
                     .replace('https://sockets.pkmn.gg', '');
        }
        return originalOpen.apply(this, arguments);
    };
})();
</script>
`;

// --- 3. PROXY RESPONSE HANDLER ---
const handleProxyRes = (proxyRes, req, res) => {
    let originalBody = [];
    proxyRes.on('data', (chunk) => originalBody.push(chunk));
    proxyRes.on('end', () => {
        const bodyBuffer = Buffer.concat(originalBody);
        let finalBody = bodyBuffer;
        const contentType = proxyRes.headers['content-type'] || '';

        // NUKE TARGET CORS HEADERS
        // We remove these to prevent "Invalid Header" errors
        const headersToRemove = [
            'access-control-allow-origin',
            'access-control-allow-methods',
            'access-control-allow-headers',
            'access-control-allow-credentials',
            'content-security-policy',
            'content-security-policy-report-only',
            'x-frame-options',
            'strict-transport-security'
        ];
        headersToRemove.forEach(header => delete proxyRes.headers[header]);

        // RE-APPLY OUR HEADERS (Just in case)
        const origin = req.headers.origin || '*';
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');

        // COPY THE REST
        Object.keys(proxyRes.headers).forEach((key) => {
            if (key === 'content-length' || key === 'content-encoding') return;
            // Don't copy headers we just deleted
            if (headersToRemove.includes(key.toLowerCase())) return;
            res.setHeader(key, proxyRes.headers[key]);
        });

        // INJECT SCRIPT INTO HTML
        if (contentType.includes('text/html')) {
            try {
                let bodyString = bodyBuffer.toString('utf8');
                bodyString = bodyString.replace('<head>', '<head>' + CLIENT_INJECTION);
                finalBody = Buffer.from(bodyString);
            } catch (e) {
                console.error("Injection error:", e);
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
        proxyReq.setHeader('Accept-Encoding', 'identity');
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
        proxyReq.removeHeader('Cookie'); // Optional: Clear cookies if authentication isn't needed immediately
    },
    onProxyRes: handleProxyRes
};

// --- ROUTES ---

// Socket.io
app.use('/socket.io', createProxyMiddleware({
    target: TARGET_SOCKET,
    changeOrigin: true,
    ws: true
}));

// Main Traffic
app.use('/', createProxyMiddleware({
    ...commonOptions,
    target: TARGET_MAIN,
}));

app.listen(PORT, () => console.log(`Scorched Earth Proxy running on ${PORT}`));
