const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const zlib = require('zlib'); // Added to handle compression if needed

const app = express();
const PORT = process.env.PORT || 3000;

// --- TARGETS ---
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';
const TARGET_NAKED = 'https://pkmn.gg';

// --- 1. CLIENT IMPLANT (The "History Hijack") ---
const CLIENT_INJECTION = `
<script>
    (function() {
        console.log("--- PROXY V10: ARCHITECT ACTIVE ---");
        const PROXY_ORIGIN = window.location.origin;

        // 1. Helper to clean URLs
        function cleanUrl(url) {
            if (typeof url === 'string' && url.includes('pkmn.gg')) {
                // Remove the domain, keep the path
                return url.replace(/https?:\\/\\/(www\\.)?pkmn\\.gg/g, PROXY_ORIGIN);
            }
            return url;
        }

        // 2. Hijack History (Next.js uses this for navigation)
        const originalPush = history.pushState;
        const originalReplace = history.replaceState;

        history.pushState = function(state, unused, url) {
            return originalPush.apply(this, [state, unused, cleanUrl(url)]);
        };
        history.replaceState = function(state, unused, url) {
            return originalReplace.apply(this, [state, unused, cleanUrl(url)]);
        };

        // 3. Hijack Window.Open
        const originalOpen = window.open;
        window.open = function(url, target, features) {
            return originalOpen.apply(this, [cleanUrl(url), target, features]);
        };

        // 4. Hijack Fetch (API Calls)
        const originalFetch = window.fetch;
        window.fetch = function(input, init) {
            if (typeof input === 'string') input = cleanUrl(input);
            // Also clean the body if it sends the URL to the server
            if (init && init.body && typeof init.body === 'string') {
                init.body = init.body.replace(/https?:\\/\\/(www\\.)?pkmn\\.gg/g, PROXY_ORIGIN);
            }
            return originalFetch(input, init);
        };

        // 5. Hijack XHR (Old Ajax)
        const originalXhrOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url) {
            return originalXhrOpen.apply(this, [method, cleanUrl(url)]);
        };
    })();
</script>
`;

// --- 2. CONFIGURATION ---

const commonOptions = {
    target: TARGET_MAIN,
    changeOrigin: true,
    secure: true,
    cookieDomainRewrite: { "*": "" },
    selfHandleResponse: true, 
    
    onProxyReq: (proxyReq, req, res) => {
        // Force identity so we don't have to unzip files (faster)
        proxyReq.setHeader('Accept-Encoding', 'identity');
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
    },

    onProxyRes: (proxyRes, req, res) => {
        const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
        const statusCode = proxyRes.statusCode;

        // --- A. HEADER CLEANUP ---
        
        // Fix Redirects (301/302)
        if (proxyRes.headers['location']) {
            let redirect = proxyRes.headers['location'];
            redirect = redirect.replace(TARGET_MAIN, '')
                               .replace(TARGET_SOCKET, '')
                               .replace(TARGET_NAKED, '');
            res.setHeader('Location', redirect);
        }

        // Remove blocking headers
        const headersToDelete = ['content-security-policy', 'x-frame-options', 'content-length', 'transfer-encoding'];
        Object.keys(proxyRes.headers).forEach(key => {
            if (!headersToDelete.includes(key.toLowerCase())) {
                res.setHeader(key, proxyRes.headers[key]);
            }
        });

        // --- B. THE INTELLIGENT SPLIT ---
        
        // WE REWRITE: HTML (Structure), JSON (Data), JS (Logic)
        // WE STREAM: Images, Fonts, CSS, Video (Speed)
        const isText = contentType.includes('text/') || 
                       contentType.includes('javascript') || 
                       contentType.includes('json') || 
                       contentType.includes('xml');

        if (isText) {
            // --- REWRITE MODE (Fixes the Magic Link) ---
            let originalBody = [];
            proxyRes.on('data', (chunk) => originalBody.push(chunk));
            
            proxyRes.on('end', () => {
                const bodyBuffer = Buffer.concat(originalBody);
                let bodyString = bodyBuffer.toString('utf8');
                const myHost = 'https://' + req.headers.host;

                try {
                    // 1. The "Rosetta Stone" Replacements
                    // Replaces: https://www.pkmn.gg, https://pkmn.gg, https%3A%2F%2F...
                    const targets = [TARGET_MAIN, TARGET_SOCKET, TARGET_NAKED];
                    
                    targets.forEach(target => {
                        // Standard: https://pkmn.gg
                        bodyString = bodyString.split(target).join(myHost);
                        
                        // Escaped: https:\/\/pkmn.gg (Common in JSON)
                        const escapedTarget = target.replace('/', '\\/');
                        const escapedHost = myHost.replace('/', '\\/');
                        bodyString = bodyString.split(escapedTarget).join(escapedHost);

                        // Encoded: https%3A%2F%2Fpkmn.gg (Common in URL params)
                        const encodedTarget = encodeURIComponent(target);
                        const encodedHost = encodeURIComponent(myHost);
                        bodyString = bodyString.split(encodedTarget).join(encodedHost);
                    });

                } catch (e) {
                    console.error("Rewrite Error:", e);
                }

                // 2. Inject Script (Only into HTML)
                if (contentType.includes('html')) {
                    // Inject immediately after <head> to run before any other script
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
            // --- STREAM MODE (Restores Speed) ---
            // Images, Fonts, etc. pass through untouched
            res.status(statusCode);
            proxyRes.pipe(res);
        }
    }
};

// --- ROUTES ---

// 1. Fix user habits
app.use((req, res, next) => {
    if (req.url.startsWith('/proxy')) return res.redirect('/');
    next();
});

// 2. Socket Proxy
app.use('/socket.io', createProxyMiddleware({
    target: TARGET_SOCKET,
    changeOrigin: true,
    ws: true,
    onProxyReq: (proxyReq) => proxyReq.setHeader('Origin', TARGET_MAIN)
}));

// 3. Main Proxy
app.use('/', createProxyMiddleware(commonOptions));

app.listen(PORT, () => console.log(`--- PROXY V10 (ARCHITECT) RUNNING ON ${PORT} ---`));
