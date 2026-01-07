const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// --- TARGETS ---
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';
const TARGET_NAKED = 'https://pkmn.gg';

// --- 1. CLIENT IMPLANT (Handles the rest) ---
// Since we aren't rewriting JS files server-side anymore (for speed),
// this script works harder to catch fetches on the fly.
const CLIENT_INJECTION = `
<script>
    console.log("--- PROXY V8: SPEED STREAM ACTIVE ---");
    
    // 1. Force Relative Fetching
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string' && input.includes('pkmn.gg')) {
            try {
                const url = new URL(input);
                // Keep the path and query, discard the domain
                input = url.pathname + url.search;
            } catch(e) {}
        }
        return originalFetch(input, init);
    };

    // 2. Catch XHR (Old Ajax)
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string' && url.includes('pkmn.gg')) {
            try {
                const u = new URL(url);
                url = u.pathname + u.search;
            } catch(e) {}
        }
        return originalOpen.apply(this, arguments);
    };
</script>
`;

// --- 2. PROXY CONFIGURATION ---

const commonOptions = {
    target: TARGET_MAIN,
    changeOrigin: true,
    secure: true,
    cookieDomainRewrite: { "*": "" },
    selfHandleResponse: true, // We handle the stream manually
    
    onProxyReq: (proxyReq, req, res) => {
        // We only need Identity (plain text) for HTML/JSON. 
        // For others, we don't care, but keeping it consistent avoids compression headaches.
        proxyReq.setHeader('Accept-Encoding', 'identity');
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
    },

    onProxyRes: (proxyRes, req, res) => {
        const contentType = proxyRes.headers['content-type'] || '';
        const statusCode = proxyRes.statusCode;

        // --- A. PREPARE HEADERS ---
        
        // 1. Handle Redirects (Header Rewriting)
        // This runs for EVERY request, so redirects are always fixed.
        if (proxyRes.headers['location']) {
            let redirect = proxyRes.headers['location'];
            // Replace all target variations with our relative path
            redirect = redirect.replace(TARGET_MAIN, '')
                               .replace(TARGET_SOCKET, '')
                               .replace(TARGET_NAKED, '');
            res.setHeader('Location', redirect);
        }

        // 2. Strip Security Headers
        const headersToDelete = ['content-security-policy', 'x-frame-options', 'content-length', 'transfer-encoding'];
        Object.keys(proxyRes.headers).forEach(key => {
            if (!headersToDelete.includes(key.toLowerCase())) {
                res.setHeader(key, proxyRes.headers[key]);
            }
        });

        // --- B. DECIDE: BUFFER OR STREAM? ---

        // We ONLY buffer and rewrite HTML (the page) and JSON (the API responses).
        // Everything else (JS, CSS, Images) flows through instantly.
        const shouldRewrite = contentType.includes('text/html') || contentType.includes('application/json');

        if (shouldRewrite) {
            // --- SLOW PATH: BUFFER & REWRITE (For Page & API) ---
            let originalBody = [];
            proxyRes.on('data', (chunk) => originalBody.push(chunk));
            
            proxyRes.on('end', () => {
                const bodyBuffer = Buffer.concat(originalBody);
                let bodyString = bodyBuffer.toString('utf8');
                const myHost = 'https://' + req.headers.host;

                try {
                    // 1. Simple Replace for "https://www.pkmn.gg" -> "https://my-proxy.com"
                    // We use a global Replace for the main domains
                    const regexMain = new RegExp(TARGET_MAIN, 'g');
                    const regexNaked = new RegExp(TARGET_NAKED, 'g');
                    const regexSocket = new RegExp(TARGET_SOCKET, 'g');
                    
                    bodyString = bodyString.replace(regexMain, myHost)
                                           .replace(regexNaked, myHost)
                                           .replace(regexSocket, myHost);

                    // 2. JSON Fix: Handle escaped slashes "https:\/\/..."
                    // This is crucial for the Magic Link JSON response
                    const escapedTarget = TARGET_MAIN.replace('/', '\\/');
                    const escapedMyHost = myHost.replace('/', '\\/');
                    const regexEscaped = new RegExp(escapedTarget, 'g');
                    bodyString = bodyString.replace(regexEscaped, escapedMyHost);

                } catch (e) {
                    console.error("Rewrite Error:", e);
                }

                // 3. Inject Script (Only for HTML)
                if (contentType.includes('text/html')) {
                    if (bodyString.includes('</body>')) {
                        bodyString = bodyString.replace('</body>', CLIENT_INJECTION + '</body>');
                    } else {
                        bodyString += CLIENT_INJECTION;
                    }
                }

                res.setHeader('Content-Length', Buffer.byteLength(bodyString));
                res.status(statusCode);
                res.end(bodyString);
            });

        } else {
            // --- FAST PATH: STREAM (For JS, CSS, Images) ---
            // Just pipe the data directly. Zero latency.
            res.status(statusCode);
            proxyRes.pipe(res);
        }
    }
};

// --- ROUTES ---

// Redirect /proxy habits
app.use((req, res, next) => {
    if (req.url.startsWith('/proxy')) return res.redirect('/');
    next();
});

// Socket Proxy
app.use('/socket.io', createProxyMiddleware({
    target: TARGET_SOCKET,
    changeOrigin: true,
    ws: true,
    onProxyReq: (proxyReq) => proxyReq.setHeader('Origin', TARGET_MAIN)
}));

// Main Proxy
app.use('/', createProxyMiddleware(commonOptions));

app.listen(PORT, () => console.log(`--- PROXY V8 (SPEEDSTER) RUNNING ON ${PORT} ---`));
