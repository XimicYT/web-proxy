const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// --- TARGETS ---
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';
const TARGET_NAKED = 'https://pkmn.gg'; // Catch cases without 'www'

// --- 1. CLIENT IMPLANT (Browser Logic) ---
const CLIENT_INJECTION = `
<script>
    console.log("--- PROXY V7: ROSETTA STONE ACTIVE ---");
    // Force relative paths for everything
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string' && input.includes('pkmn.gg')) {
            const url = new URL(input);
            input = url.pathname + url.search;
        }
        return originalFetch(input, init);
    };
    // Intercept form submissions just in case
    document.addEventListener('submit', (e) => {
        const form = e.target;
        if (form.action && form.action.includes('pkmn.gg')) {
            e.preventDefault();
            const actionUrl = new URL(form.action);
            const newPath = actionUrl.pathname + actionUrl.search;
            form.action = newPath;
            form.submit();
        }
    });
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
        // Force plain text so we can read and replace it
        proxyReq.setHeader('Accept-Encoding', 'identity');
        // Spoof as a real user
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
        // Hide our identity
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
    },
    onProxyRes: (proxyRes, req, res) => {
        let originalBody = [];
        proxyRes.on('data', (chunk) => originalBody.push(chunk));
        proxyRes.on('end', () => {
            const bodyBuffer = Buffer.concat(originalBody);
            let bodyString = bodyBuffer.toString('utf8');
            const contentType = proxyRes.headers['content-type'] || '';
            
            // --- THE FIX: MULTI-LEVEL REPLACEMENT ---
            // We replace every variation of the target URL with your Render URL
            const myHost = 'https://' + req.headers.host;
            const myHostEncoded = encodeURIComponent(myHost);
            const myHostEscaped = myHost.replace('/', '\\/');

            // Define the swap list
            const replacements = [
                // Standard
                { from: TARGET_MAIN, to: myHost },
                { from: TARGET_NAKED, to: myHost },
                { from: TARGET_SOCKET, to: myHost },
                // JSON Escaped (https:\/\/www.pkmn.gg)
                { from: TARGET_MAIN.replace('/', '\\/'), to: myHostEscaped },
                { from: TARGET_NAKED.replace('/', '\\/'), to: myHostEscaped },
                // URL Encoded (https%3A%2F%2F...)
                { from: encodeURIComponent(TARGET_MAIN), to: myHostEncoded },
                { from: encodeURIComponent(TARGET_NAKED), to: myHostEncoded }
            ];

            // Execute Swaps
            replacements.forEach(pair => {
                // Create a global regex for the 'from' pattern
                // We escape special regex characters (like dots and slashes)
                const regexSafe = pair.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); 
                const regex = new RegExp(regexSafe, 'g');
                bodyString = bodyString.replace(regex, pair.to);
            });

            // Handle Header Redirects (301/302)
            if (proxyRes.headers['location']) {
                let redirect = proxyRes.headers['location'];
                replacements.forEach(pair => {
                    if (redirect.includes(pair.from)) {
                        redirect = redirect.replace(pair.from, pair.to);
                    }
                });
                res.setHeader('Location', redirect);
            }

            // Inject Script (Only into HTML)
            if (contentType.includes('text/html')) {
                if (bodyString.includes('</body>')) {
                    bodyString = bodyString.replace('</body>', CLIENT_INJECTION + '</body>');
                } else {
                    bodyString += CLIENT_INJECTION;
                }
            }

            // Remove headers that cause issues
            const headersToDelete = ['content-security-policy', 'x-frame-options', 'content-length', 'transfer-encoding'];
            Object.keys(proxyRes.headers).forEach(key => {
                if (!headersToDelete.includes(key.toLowerCase())) {
                    res.setHeader(key, proxyRes.headers[key]);
                }
            });

            // Prevent caching so the user gets the new patched files
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');

            res.setHeader('Content-Length', Buffer.byteLength(bodyString));
            res.status(proxyRes.statusCode);
            res.end(bodyString);
        });
    }
};

// --- 3. ROUTES ---

// 1. Redirect /proxy habits
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

app.listen(PORT, () => console.log(`--- PROXY V7 (ROSETTA) RUNNING ON ${PORT} ---`));
