const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURATION
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';

// --- THE TITANIUM BRAIN IMPLANT ---
const CLIENT_INJECTION = `
<script>
(function() {
    console.log("--- PROXY INTERCEPTOR V2 ACTIVE ---");

    // 1. KILL SERVICE WORKERS (The "Zombie" Killer)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function(registrations) {
            for(let registration of registrations) {
                console.log("Killing Service Worker:", registration);
                registration.unregister();
            }
        });
        navigator.serviceWorker.register = () => Promise.resolve();
    }

    // 2. INTERCEPT FETCH (Now handles Request Objects!)
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        let targetUrl = input;
        
        // Case A: Input is a simple string
        if (typeof input === 'string') {
            if (input.includes('pkmn.gg')) {
                input = input.replace('https://www.pkmn.gg', '')
                             .replace('https://sockets.pkmn.gg', '');
            }
        } 
        // Case B: Input is a Request Object (This was missing!)
        else if (input instanceof Request) {
            if (input.url.includes('pkmn.gg')) {
                const newUrl = input.url.replace('https://www.pkmn.gg', '')
                                        .replace('https://sockets.pkmn.gg', '');
                // We must create a new Request because the old one is immutable
                input = new Request(newUrl, input);
            }
        }
        
        return originalFetch(input, init);
    };

    // 3. INTERCEPT XMLHTTPREQUEST
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

// --- MANUAL RESPONSE HANDLER ---
const handleProxyRes = (proxyRes, req, res) => {
    let originalBody = [];
    proxyRes.on('data', (chunk) => originalBody.push(chunk));
    proxyRes.on('end', () => {
        const bodyBuffer = Buffer.concat(originalBody);
        let finalBody = bodyBuffer;
        const contentType = proxyRes.headers['content-type'] || '';

        // 1. STRIP TARGET CORS HEADERS
        // We delete these from the target response so they don't clash with ours
        delete proxyRes.headers['access-control-allow-origin'];
        delete proxyRes.headers['access-control-allow-methods'];
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['content-security-policy-report-only'];
        delete proxyRes.headers['x-frame-options'];

        // 2. COPY REMAINING HEADERS
        Object.keys(proxyRes.headers).forEach((key) => {
            if (key === 'content-length' || key === 'content-encoding') return;
            res.setHeader(key, proxyRes.headers[key]);
        });

        // 3. SET OUR PERMISSIVE HEADERS
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');

        // 4. INJECT SCRIPT
        if (contentType.includes('text/html')) {
            try {
                let bodyString = bodyBuffer.toString('utf8');
                // Inject immediately after head to capture early scripts
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
        proxyReq.removeHeader('Origin'); // Hide that we are a proxy
        proxyReq.removeHeader('Referer');
    },
    onProxyRes: handleProxyRes
};

// --- ROUTES ---

// 1. SOCKET.IO (High Priority)
// We capture anything starting with /socket.io
app.use('/socket.io', createProxyMiddleware({
    target: TARGET_SOCKET,
    changeOrigin: true,
    ws: true,
    logLevel: 'debug' 
}));

// 2. EVERYTHING ELSE
app.use('/', createProxyMiddleware({
    ...commonOptions,
    target: TARGET_MAIN,
}));

app.listen(PORT, () => console.log(`Titanium Proxy running on ${PORT}`));
