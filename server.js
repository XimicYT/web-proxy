const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';

// --- 1. THE BRAIN IMPLANT (React-Safe Version) ---
// We inject this at the very END of the body so we don't break React Hydration in the <head>
const CLIENT_INJECTION = `
<script>
(function() {
    console.log("--- PROXY IMPLANT V5 ACTIVE ---");
    
    // Helper: Rewrite URLs to remove the target domain
    const rewriteUrl = (url) => {
        if (!url || typeof url !== 'string') return url;
        let newUrl = url.replace('${TARGET_MAIN}', '').replace('${TARGET_SOCKET}', '');
        // Fix double slashes if they occur (excluding http://)
        if (newUrl.startsWith('//')) newUrl = newUrl.substring(1);
        return newUrl;
    };

    // A. Nuke Service Workers (They prevent proxying)
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(regs => {
            regs.forEach(r => r.unregister());
        });
        navigator.serviceWorker.register = () => Promise.resolve();
    }

    // B. Intercept Fetch
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
})();
</script>
`;

// --- 2. CONFIGURATION ---

const commonOptions = {
    target: TARGET_MAIN,
    changeOrigin: true,
    secure: true,
    cookieDomainRewrite: { "*": "" }, // Allow cookies on our proxy domain
    onProxyReq: (proxyReq, req, res) => {
        proxyReq.setHeader('Accept-Encoding', 'identity'); // Force plain text
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
        
        // Remove headers that might trigger bot detection
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
    },
    selfHandleResponse: true,
    onProxyRes: (proxyRes, req, res) => {
        let originalBody = [];
        proxyRes.on('data', (chunk) => originalBody.push(chunk));
        proxyRes.on('end', () => {
            const bodyBuffer = Buffer.concat(originalBody);
            let finalBody = bodyBuffer;
            const contentType = proxyRes.headers['content-type'] || '';

            // 1. Handle Redirects (Fix the "Escape" issue)
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers['location']) {
                let redirect = proxyRes.headers['location'];
                redirect = redirect.replace(TARGET_MAIN, '').replace(TARGET_SOCKET, '');
                res.setHeader('Location', redirect);
            }

            // 2. Strip Security Headers
            const headersToDelete = ['content-security-policy', 'x-frame-options', 'strict-transport-security'];
            Object.keys(proxyRes.headers).forEach(key => {
                if (!headersToDelete.includes(key.toLowerCase()) && key !== 'content-length' && key !== 'content-encoding') {
                    res.setHeader(key, proxyRes.headers[key]);
                }
            });

            // 3. Inject Script (SAFE MODE: End of Body)
            if (contentType.includes('text/html')) {
                try {
                    let bodyStr = bodyBuffer.toString('utf8');
                    // We append BEFORE the closing body tag to avoid breaking React's Head
                    if (bodyStr.includes('</body>')) {
                        bodyStr = bodyStr.replace('</body>', CLIENT_INJECTION + '</body>');
                    } else {
                        bodyStr += CLIENT_INJECTION;
                    }
                    finalBody = Buffer.from(bodyStr);
                } catch (e) { console.error(e); }
            }

            res.status(proxyRes.statusCode);
            res.end(finalBody);
        });
    }
};

// --- 3. ROUTES ---

// Fix for the user's "Old URL" habit
// If they visit /proxy?url=..., redirect them to root
app.use((req, res, next) => {
    if (req.url.startsWith('/proxy')) {
        return res.redirect('/');
    }
    next();
});

// Socket.io Proxy
app.use('/socket.io', createProxyMiddleware({
    target: TARGET_SOCKET,
    changeOrigin: true,
    ws: true,
    onProxyReq: (proxyReq) => proxyReq.setHeader('Origin', TARGET_MAIN)
}));

// Main Site Proxy
app.use('/', createProxyMiddleware(commonOptions));

app.listen(PORT, () => console.log(`--- PROXY V5 RUNNING ON ${PORT} ---`));
