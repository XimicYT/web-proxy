const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURATION
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';

// --- 1. THE BRAIN IMPLANT (Client-Side) ---
// This runs in the browser to rewrite fetch/XHR requests
const CLIENT_INJECTION = `
<script>
(function() {
    console.log("--- PROXY INTERCEPTOR V3 ACTIVE ---");

    // A. Disable Service Workers to prevent caching original site logic
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(registrations) {
            for(let registration of registrations) {
                registration.unregister();
            }
        });
        navigator.serviceWorker.register = () => Promise.resolve();
    }

    // B. Intercept FETCH requests
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        // Handle Request objects (e.g. from React)
        if (input instanceof Request) {
            if (input.url.includes('pkmn.gg')) {
                const newUrl = input.url.replace('https://www.pkmn.gg', '')
                                        .replace('https://sockets.pkmn.gg', '');
                // Clone the request with the new URL
                input = new Request(newUrl, input);
            }
        } 
        // Handle string URLs
        else if (typeof input === 'string') {
            if (input.includes('pkmn.gg')) {
                input = input.replace('https://www.pkmn.gg', '')
                             .replace('https://sockets.pkmn.gg', '');
            }
        }
        return originalFetch(input, init);
    };

    // C. Intercept XHR (older AJAX) requests
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

// --- 2. CORS PRE-FLIGHT HANDLER ---
// We answer the browser's "Can I connect?" questions immediately.
// We do NOT forward these to the target.
app.use((req, res, next) => {
    // If we simply use '*', browsers get mad if credentials (cookies) are used.
    // So we just echo back whatever origin the browser claims to be.
    const origin = req.headers.origin || '*';
    
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, *');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // If it's an OPTIONS request, send 200 OK and stop.
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// --- 3. PROXY RESPONSE MODIFIER ---
const handleProxyRes = (proxyRes, req, res) => {
    let originalBody = [];
    proxyRes.on('data', (chunk) => originalBody.push(chunk));
    proxyRes.on('end', () => {
        const bodyBuffer = Buffer.concat(originalBody);
        let finalBody = bodyBuffer;
        const contentType = proxyRes.headers['content-type'] || '';

        // --- THE KEY FIX: HEADER STRIPPING ---
        // We delete the headers from pkmn.gg that were causing the crash.
        const headersToDelete = [
            'access-control-allow-origin',
            'access-control-allow-methods',
            'access-control-allow-headers',
            'access-control-allow-credentials',
            'content-security-policy',
            'content-security-policy-report-only',
            'strict-transport-security',
            'x-frame-options'
        ];
        headersToDelete.forEach(header => delete proxyRes.headers[header]);

        // Copy valid headers (excluding the ones we just deleted)
        Object.keys(proxyRes.headers).forEach((key) => {
            if (key === 'content-length' || key === 'content-encoding') return;
            if (headersToDelete.includes(key.toLowerCase())) return; // Double check
            res.setHeader(key, proxyRes.headers[key]);
        });

        // Re-apply OUR permissive headers to the response
        const origin = req.headers.origin || '*';
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');

        // Inject the script if it's an HTML page
        if (contentType.includes('text/html')) {
            try {
                let bodyString = bodyBuffer.toString('utf8');
                bodyString = bodyString.replace('<head>', '<head>' + CLIENT_INJECTION);
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
        // We ask for plain text (no gzip) so we can edit the HTML
        proxyReq.setHeader('Accept-Encoding', 'identity');
        // We spoof the User Agent so we look like a real Chrome browser
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        // We remove Origin/Referer so pkmn.gg doesn't know it's being proxied
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
    },
    onProxyRes: handleProxyRes
};

// --- ROUTES ---

// Socket.io Traffic
app.use('/socket.io', createProxyMiddleware({
    target: TARGET_SOCKET,
    changeOrigin: true,
    ws: true,
    onProxyReq: (proxyReq) => {
        proxyReq.setHeader('Origin', TARGET_MAIN); // Fool the socket server
    }
}));

// Main Traffic
app.use('/', createProxyMiddleware({
    ...commonOptions,
    target: TARGET_MAIN,
}));

app.listen(PORT, () => console.log(`Scorched Earth Proxy running on ${PORT}`));
