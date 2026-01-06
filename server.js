const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. THE SPY SCRIPT (Service Worker Killer)
// We keep this. It stops the site from crashing when we block the Service Worker.
const INJECTED_SCRIPT = `
<script>
(function() {
    console.warn("--- PROXY: DEDICATED MODE ACTIVE ---");
    
    // Fake Service Worker to prevent crash
    const dummy = {
        active: { scriptURL: '', state: 'activated' },
        scope: '/',
        unregister: () => Promise.resolve(true),
        addEventListener: () => {}, 
        removeEventListener: () => {}
    };
    Object.defineProperty(navigator, 'serviceWorker', {
        value: {
            register: () => Promise.resolve(dummy),
            getRegistrations: () => Promise.resolve([]),
            addEventListener: () => {},
            controller: null,
            ready: Promise.resolve(dummy)
        }
    });
})();
</script>
`;

// 2. CONFIGURATION: Hardcoded Targets
const MAIN_TARGET = 'https://www.pkmn.gg';
const SOCKET_TARGET = 'https://sockets.pkmn.gg';

// 3. COMMON PROXY SETTINGS
// We use these headers to fool the server into thinking we are a real user, not a proxy.
const commonProxyOptions = {
    changeOrigin: true,
    ws: true, // Enable WebSocket support
    onProxyReq: (proxyReq, req, res) => {
        // Strip headers that reveal the proxy
        proxyReq.removeHeader('Referer');
        proxyReq.removeHeader('Origin');
        // Spoof User-Agent
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        // Disable compression so we can inject our script
        proxyReq.setHeader('Accept-Encoding', 'identity');
    },
    onProxyRes: (proxyRes, req, res) => {
        // Fix CORS so the browser accepts the answer
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        // Kill security headers that prevent embedding
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
    }
};

// 4. ROUTE A: GAME TRAFFIC (Socket.io)
// If the URL contains "socket.io", send it to the game server.
app.use('/socket.io', createProxyMiddleware({
    ...commonProxyOptions,
    target: SOCKET_TARGET,
}));

// 5. ROUTE B: MAIN WEBSITE
// Everything else goes to the main website.
app.use('/', createProxyMiddleware({
    ...commonProxyOptions,
    target: MAIN_TARGET,
    selfHandleResponse: true, // We need to handle response to inject script
    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        // Apply common headers first
        res.setHeader('Access-Control-Allow-Origin', '*');
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];

        const contentType = proxyRes.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            // Inject our Spy Script into HTML pages
            let html = responseBuffer.toString('utf8');
            return html.replace('<head>', '<head>' + INJECTED_SCRIPT);
        }
        return responseBuffer;
    })
}));

app.listen(PORT, () => console.log(`Dedicated Proxy running on ${PORT}`));
