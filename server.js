const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// CONFIGURATION
const PROXY_URL = 'https://web-prox.onrender.com'; // YOUR Render URL
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';

// --- HELPER: URL REWRITER ---
// This function searches through the code and replaces the real links with our proxy links.
const rewriteBody = (body) => {
    if (typeof body !== 'string') return body;
    return body
        .replace(new RegExp(TARGET_MAIN, 'g'), PROXY_URL)       // Replace https://www.pkmn.gg -> https://web-prox...
        .replace(new RegExp(TARGET_SOCKET, 'g'), PROXY_URL)     // Replace https://sockets.pkmn.gg -> https://web-prox...
        .replace(/integrity="[^"]*"/g, '');                     // Remove security checks (SRI) so our changes are accepted
};

// --- PROXY OPTIONS ---
const commonOptions = {
    changeOrigin: true,
    secure: true,
    ws: true,
    autoRewrite: true,
    followRedirects: true,
    cookieDomainRewrite: { "*": "" }, // Ensure cookies stick to our proxy
    
    onProxyReq: (proxyReq, req, res) => {
        // 1. Tell the server we want PLAIN TEXT (no gzip) so we can edit it
        proxyReq.setHeader('Accept-Encoding', 'identity');
        
        // 2. Masquerade as a normal user
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
    },

    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        // 3. Fix CORS Headers (Allow Everything)
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');

        // 4. Remove Blocking Headers
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['content-security-policy-report-only'];
        delete proxyRes.headers['x-frame-options'];
        
        // 5. Rewrite the Content
        const contentType = proxyRes.headers['content-type'] || '';
        if (contentType.includes('text/') || contentType.includes('application/javascript') || contentType.includes('application/json')) {
            let body = responseBuffer.toString('utf8');
            body = rewriteBody(body);
            return body;
        }
        return responseBuffer;
    })
};

// --- ROUTES ---

// 1. Socket.io Traffic (Redirects to game server)
app.use('/socket.io', createProxyMiddleware({
    ...commonOptions,
    target: TARGET_SOCKET,
}));

// 2. Main Traffic (Redirects to website)
app.use('/', createProxyMiddleware({
    ...commonOptions,
    target: TARGET_MAIN,
}));

app.listen(PORT, () => console.log(`Rewriter Proxy running on ${PORT}`));
