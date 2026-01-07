const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';

// --- 1. THE CLIENT IMPLANT (Forcing Relative Paths) ---
const CLIENT_INJECTION = `
<script>
    console.log("--- PROXY V6: NUCLEAR REWRITE ACTIVE ---");
    // Force all fetch/XHR to be relative
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string' && input.startsWith('http')) {
            const url = new URL(input);
            if (url.hostname.includes('pkmn.gg')) {
                input = url.pathname + url.search;
            }
        }
        return originalFetch(input, init);
    };
</script>
`;

// --- 2. CONFIGURATION ---

const commonOptions = {
    target: TARGET_MAIN,
    changeOrigin: true,
    secure: true,
    cookieDomainRewrite: { "*": "" }, // Fix cookies
    selfHandleResponse: true, // We will manually handle the response
    onProxyReq: (proxyReq, req, res) => {
        // Force plain text (no gzip) so we can edit the text
        proxyReq.setHeader('Accept-Encoding', 'identity');
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
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

            // --- THE FIX: GLOBAL URL REPLACEMENT ---
            // We find EVERY instance of "https://www.pkmn.gg" in the code (HTML or JSON)
            // and replace it with your Render URL.
            const myHost = 'https://' + req.headers.host;
            
            // 1. Replace Main Domain
            const regexMain = new RegExp(TARGET_MAIN, 'g');
            bodyString = bodyString.replace(regexMain, myHost);

            // 2. Replace Socket Domain (to keep connections internal)
            const regexSocket = new RegExp(TARGET_SOCKET, 'g');
            bodyString = bodyString.replace(regexSocket, myHost);

            // 3. Handle Location Header Redirects (301/302)
            if (proxyRes.headers['location']) {
                let redirect = proxyRes.headers['location'];
                redirect = redirect.replace(TARGET_MAIN, myHost);
                res.setHeader('Location', redirect);
            }

            // 4. Inject Script (Only into HTML)
            if (contentType.includes('text/html')) {
                if (bodyString.includes('</body>')) {
                    bodyString = bodyString.replace('</body>', CLIENT_INJECTION + '</body>');
                } else {
                    bodyString += CLIENT_INJECTION;
                }
            }

            // 5. Clean up headers
            const headersToDelete = ['content-security-policy', 'x-frame-options', 'content-length'];
            Object.keys(proxyRes.headers).forEach(key => {
                if (!headersToDelete.includes(key.toLowerCase())) {
                    res.setHeader(key, proxyRes.headers[key]);
                }
            });

            // Send the modified body
            res.setHeader('Content-Length', Buffer.byteLength(bodyString));
            res.status(proxyRes.statusCode);
            res.end(bodyString);
        });
    }
};

// --- 3. ROUTES ---

// Redirect /proxy?url=... to root to cure old habits
app.use((req, res, next) => {
    if (req.url.startsWith('/proxy')) return res.redirect('/');
    next();
});

// Socket Handler
app.use('/socket.io', createProxyMiddleware({
    target: TARGET_SOCKET,
    changeOrigin: true,
    ws: true,
    onProxyReq: (proxyReq) => proxyReq.setHeader('Origin', TARGET_MAIN)
}));

// Main Handler
app.use('/', createProxyMiddleware(commonOptions));

app.listen(PORT, () => console.log(`--- PROXY V6 RUNNING ON ${PORT} ---`));
