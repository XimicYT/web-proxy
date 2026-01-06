const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURATION
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';

// --- 1. THE BRAIN IMPLANT (Client-Side) ---
// This script is injected into every HTML page to hijack fetch, XHR, and WebSockets
const CLIENT_INJECTION = `
<script>
(function() {
    console.log("--- PROXY IMPLANT V4 ACTIVE ---");
    const TARGET_MAIN = '${TARGET_MAIN}';
    const TARGET_SOCKET = '${TARGET_SOCKET}';

    // Helper to rewrite URLs from absolute to relative
    const rewriteUrl = (url) => {
        if (!url || typeof url !== 'string') return url;
        // Rewrite main domain
        let newUrl = url.replace(TARGET_MAIN, '');
        // Rewrite socket domain (crucial for games)
        newUrl = newUrl.replace(TARGET_SOCKET, '');
        return newUrl;
    };

    // A. Disable Service Workers (They bypass proxies)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(regs => {
            regs.forEach(r => r.unregister());
        });
        navigator.serviceWorker.register = () => Promise.resolve();
    }

    // B. Intercept FETCH
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            input = rewriteUrl(input);
        } else if (input instanceof Request) {
            input = new Request(rewriteUrl(input.url), input);
        }
        return originalFetch(input, init);
    };

    // C. Intercept XHR
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        return originalOpen.apply(this, [method, rewriteUrl(url)]);
    };

    // D. Intercept WebSocket (The "Game" Layer)
    const OriginalWebSocket = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        // Rewrite wss://sockets.pkmn.gg to wss://your-proxy.com/socket.io...
        // But since we are proxying, we usually just want relative paths or current host
        let newUrl = url;
        if (url.includes('sockets.pkmn.gg')) {
            // We force it to talk to OUR server, which forwards to theirs
            newUrl = url.replace('wss://sockets.pkmn.gg', window.location.origin.replace('http', 'ws'));
            // If the original path didn't have /socket.io, we might need to adjust, 
            // but usually direct replacement works if proxy is set up right.
        }
        return new OriginalWebSocket(newUrl, protocols);
    };
})();
</script>
`;

// --- 2. COMMON PROXY OPTIONS ---
const commonOptions = {
    changeOrigin: true,
    secure: true, // Validate SSL to target
    cookieDomainRewrite: {
        "*": "" // Rewrite ALL cookies to match the current domain (Render)
    },
    onProxyReq: (proxyReq, req, res) => {
        // 1. Force plain text so we can inject script
        proxyReq.setHeader('Accept-Encoding', 'identity');
        
        // 2. Spoof User Agent
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
        
        // 3. Remove headers that reveal we are a proxy
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
        proxyReq.removeHeader('Cookie'); // We manually manage cookies if needed, but standard pass-through is usually best. 
        // ACTUALLY: Let browser send cookies, but we rely on cookieDomainRewrite to ensure browser HAS them.
        
        // If the client sent us a cookie, forward it.
    },
    selfHandleResponse: true, // We want to edit the response
    onProxyRes: (proxyRes, req, res) => {
        let originalBody = [];
        
        // Capture data
        proxyRes.on('data', (chunk) => originalBody.push(chunk));
        
        proxyRes.on('end', () => {
            const bodyBuffer = Buffer.concat(originalBody);
            let finalBody = bodyBuffer;
            const contentType = proxyRes.headers['content-type'] || '';
            const statusCode = proxyRes.statusCode;

            // 1. Handle Redirects (301, 302, 307, 308)
            // If the target says "Go to pkmn.gg/login", we say "Go to /login"
            if (statusCode >= 300 && statusCode < 400 && proxyRes.headers['location']) {
                let redirectLoc = proxyRes.headers['location'];
                redirectLoc = redirectLoc.replace(TARGET_MAIN, '');
                redirectLoc = redirectLoc.replace(TARGET_SOCKET, '');
                res.setHeader('Location', redirectLoc);
            }

            // 2. Strip Security Headers (Allow iframe, allow scripts)
            const headersToDelete = [
                'content-security-policy',
                'content-security-policy-report-only',
                'strict-transport-security',
                'x-frame-options',
                'x-content-type-options'
            ];
            
            // Copy headers from target to client
            Object.keys(proxyRes.headers).forEach((key) => {
                if (key === 'content-length') return; // We calculate new length
                if (key === 'content-encoding') return; // We decoded it
                if (headersToDelete.includes(key.toLowerCase())) return;
                res.setHeader(key, proxyRes.headers[key]);
            });

            // 3. Inject Script (Only into HTML)
            if (contentType.includes('text/html')) {
                try {
                    let bodyString = bodyBuffer.toString('utf8');
                    // Inject immediately after <head> for earliest execution
                    bodyString = bodyString.replace('<head>', '<head>' + CLIENT_INJECTION);
                    finalBody = Buffer.from(bodyString);
                } catch (e) {
                    console.error("Injection failed", e);
                }
            }

            res.status(statusCode);
            res.end(finalBody);
        });
    }
};

// --- 3. ROUTES ---

// Helper route to check if proxy is alive
app.get('/health-check', (req, res) => res.send('Proxy is active'));

// SOCKET.IO TRAFFIC
// We map /socket.io requests to the socket target
app.use('/socket.io', createProxyMiddleware({
    target: TARGET_SOCKET,
    changeOrigin: true,
    ws: true, // Enable WebSocket proxying
    logLevel: 'debug',
    cookieDomainRewrite: { "*": "" },
    onProxyReq: (proxyReq) => {
        // Sockets are picky. We MUST pretend to be the main site.
        proxyReq.setHeader('Origin', TARGET_MAIN);
    }
}));

// MAIN TRAFFIC
// Everything else goes to the main site
app.use('/', createProxyMiddleware({
    target: TARGET_MAIN,
    ...commonOptions
}));

app.listen(PORT, () => {
    console.log(`--- ENTERPRISE PROXY RUNNING ON PORT ${PORT} ---`);
    console.log(`Target: ${TARGET_MAIN}`);
});
