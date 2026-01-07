const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';
const TARGET_NAKED = 'https://pkmn.gg';

// --- 1. THE "BRAIN IMPLANT" (Client-Side Protection) ---
// This runs in your browser to catch any redirects that slip through.
const CLIENT_INJECTION = `
<script>
    (function() {
        console.log("--- PROXY V11 ACTIVE ---");
        const PROXY_ORIGIN = window.location.origin;

        // Helper: Clean URLs
        function clean(url) {
            if (typeof url === 'string' && url.includes('pkmn.gg')) {
                return url.replace(/https?:\\/\\/(www\\.)?pkmn\\.gg/g, PROXY_ORIGIN);
            }
            return url;
        }

        // 1. Trap Fetch Requests (API calls)
        const originalFetch = window.fetch;
        window.fetch = async function(input, init) {
            if (typeof input === 'string') input = clean(input);
            if (init && init.body && typeof init.body === 'string') {
                // Fix the body if it sends the wrong URL to the server
                init.body = init.body.replace(/https?:\\/\\/(www\\.)?pkmn\\.gg/g, PROXY_ORIGIN);
            }
            return originalFetch(input, init);
        };

        // 2. Trap XHR (Old Ajax calls)
        const originalOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            return originalOpen.apply(this, [method, clean(url)]);
        };

        // 3. Trap History (Prevent URL bar changes)
        const originalPush = history.pushState;
        history.pushState = function(state, title, url) {
            return originalPush.apply(this, [state, title, clean(url)]);
        };
        const originalReplace = history.replaceState;
        history.replaceState = function(state, title, url) {
            return originalReplace.apply(this, [state, title, clean(url)]);
        };
        
        // 4. Trap Window Open
        const originalWindowOpen = window.open;
        window.open = function(url, target, features) {
            return originalWindowOpen.apply(this, [clean(url), target, features]);
        };
    })();
</script>
`;

// --- 2. PROXY LOGIC ---

const commonOptions = {
    target: TARGET_MAIN,
    changeOrigin: true,
    secure: true,
    cookieDomainRewrite: { "*": "" },
    selfHandleResponse: true, // We control the output

    onProxyReq: (proxyReq, req, res) => {
        // Force plain text so we can rewrite it
        proxyReq.setHeader('Accept-Encoding', 'identity');
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
    },

    onProxyRes: (proxyRes, req, res) => {
        const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
        const statusCode = proxyRes.statusCode;

        // --- A. ALWAYS FIX HEADERS ---
        // Fix redirects (Location header)
        if (proxyRes.headers['location']) {
            let redirect = proxyRes.headers['location'];
            redirect = redirect.replace(TARGET_MAIN, '')
                               .replace(TARGET_SOCKET, '')
                               .replace(TARGET_NAKED, '');
            res.setHeader('Location', redirect);
        }

        // Remove blocking security headers
        const headersToDelete = ['content-security-policy', 'x-frame-options', 'content-length', 'transfer-encoding'];
        Object.keys(proxyRes.headers).forEach(key => {
            if (!headersToDelete.includes(key.toLowerCase())) {
                res.setHeader(key, proxyRes.headers[key]);
            }
        });

        // --- B. DECIDE: REWRITE OR STREAM? ---
        // We MUST rewrite JS, JSON, and HTML to stop the redirect.
        // We MUST STREAM Images/Fonts to keep it fast.
        
        const isCodeOrText = contentType.includes('text/') || 
                             contentType.includes('javascript') || 
                             contentType.includes('json') || 
                             contentType.includes('xml') ||
                             contentType.includes('application/x-javascript');

        if (isCodeOrText) {
            // --- REWRITE MODE (The Fix) ---
            let originalBody = [];
            proxyRes.on('data', (chunk) => originalBody.push(chunk));
            
            proxyRes.on('end', () => {
                const bodyBuffer = Buffer.concat(originalBody);
                let bodyString = bodyBuffer.toString('utf8');
                const myHost = 'https://' + req.headers.host;

                try {
                    // 1. REPLACEMENT: Main Targets
                    const targets = [TARGET_MAIN, TARGET_NAKED, TARGET_SOCKET];
                    targets.forEach(t => {
                        bodyString = bodyString.split(t).join(myHost);
                    });

                    // 2. REPLACEMENT: JSON Escaped (https:\/\/...)
                    const escapedHost = myHost.replace('/', '\\/');
                    targets.forEach(t => {
                        const escapedT = t.replace('/', '\\/');
                        bodyString = bodyString.split(escapedT).join(escapedHost);
                    });

                    // 3. REPLACEMENT: URL Encoded (https%3A%2F%2F...)
                    const encodedHost = encodeURIComponent(myHost);
                    targets.forEach(t => {
                        const encodedT = encodeURIComponent(t);
                        bodyString = bodyString.split(encodedT).join(encodedHost);
                    });

                } catch (e) {
                    console.error("Rewrite failed:", e);
                }

                // 4. INJECT IMPLANT (HTML Only)
                // We inject in <head> to run before the site loads
                if (contentType.includes('html')) {
                    if (bodyString.includes('<head>')) {
                        bodyString = bodyString.replace('<head>', '<head>' + CLIENT_INJECTION);
                    } else {
                        bodyString = CLIENT_INJECTION + bodyString;
                    }
                }

                res.setHeader('Content-Length', Buffer.byteLength(bodyString));
                res.status(statusCode);
                res.end(bodyString);
            });

        } else {
            // --- STREAM MODE (The Speed) ---
            // Pipe binary data (images, fonts, videos) instantly
            res.status(statusCode);
            proxyRes.pipe(res);
        }
    }
};

// --- ROUTES ---

// 1. Redirect old habits
app.use((req, res, next) => {
    if (req.url.startsWith('/proxy')) return res.redirect('/');
    next();
});

// 2. Socket Handler
app.use('/socket.io', createProxyMiddleware({
    target: TARGET_SOCKET,
    changeOrigin: true,
    ws: true,
    onProxyReq: (proxyReq) => proxyReq.setHeader('Origin', TARGET_MAIN)
}));

// 3. Main Site Handler
app.use('/', createProxyMiddleware(commonOptions));

app.listen(PORT, () => console.log(`--- PROXY V11 RUNNING ON ${PORT} ---`));
