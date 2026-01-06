const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());

// --- THE POLITE SPY SCRIPT (Prevents crash) ---
const INJECTED_SCRIPT = `
<script>
(function() {
    console.warn("--- PROXY INTERCEPTOR ACTIVE (SPY MODE) ---");
    const dummyRegistration = {
        active: { scriptURL: '', state: 'activated' },
        installing: null,
        waiting: null,
        scope: '/',
        unregister: () => Promise.resolve(true),
        update: () => Promise.resolve(true),
        onupdatefound: null
    };
    Object.defineProperty(navigator, 'serviceWorker', {
        value: {
            register: () => { console.log('Proxy: SW intercepted'); return Promise.resolve(dummyRegistration); },
            getRegistrations: () => Promise.resolve([]),
            addEventListener: () => {},
            removeEventListener: () => {},
            controller: null, 
            ready: Promise.resolve(dummyRegistration),
            startMessages: () => {}
        },
        writable: false
    });

    function rewriteUrl(url) {
        if (!url) return url;
        if (typeof url === 'string' && url.startsWith('/')) return url;
        if (typeof url === 'string' && url.startsWith('http') && !url.includes(window.location.host)) {
            return window.location.origin + '/proxy?url=' + encodeURIComponent(url);
        }
        return url;
    }

    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') input = rewriteUrl(input);
        else if (input instanceof Request) input = new Request(rewriteUrl(input.url), input);
        return originalFetch(input, init);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        return originalOpen.call(this, method, rewriteUrl(url), ...args);
    };
})();
</script>
`;

const getTarget = (req) => {
    if (req.query.url) {
        try { return new URL(req.query.url).origin; } catch (e) {}
    }
    return req.cookies.target_site || 'https://www.google.com';
};

const proxyOptions = {
    target: 'https://www.google.com',
    changeOrigin: true,
    selfHandleResponse: true,
    cookieDomainRewrite: { "*": "" },
    router: (req) => getTarget(req),
    
    // --- STEALTH MODE ---
    onProxyReq: (proxyReq, req, res) => {
        // 1. Strip headers that reveal we are a proxy
        proxyReq.removeHeader('Referer');
        proxyReq.removeHeader('Origin');
        
        // 2. Spoof a real browser User-Agent to avoid bot blocking
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // 3. Disable compression so we can edit HTML
        proxyReq.setHeader('Accept-Encoding', 'identity'); 
    },

    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        // Set loose CORS to allow everything
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

        // Remove security headers that break things
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['content-security-policy-report-only'];

        const contentType = proxyRes.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            let html = responseBuffer.toString('utf8');
            return html.replace('<head>', '<head>' + INJECTED_SCRIPT);
        }
        return responseBuffer;
    }),
    onError: (err, req, res) => {
        console.error("Proxy Error:", err);
        res.status(500).send("Proxy connectivity error.");
    }
};

// Route 1: Explicit Proxy
app.use('/proxy', (req, res, next) => {
    if (req.query.url) {
        try {
            const urlObj = new URL(req.query.url);
            // Force cookie set immediately
            res.cookie('target_site', urlObj.origin, { path: '/', sameSite: 'none', secure: true });
            
            // Rewrite URL for the proxy middleware
            req.url = urlObj.pathname + urlObj.search;
        } catch (e) { return res.status(400).send("Invalid URL"); }
    }
    next();
}, createProxyMiddleware(proxyOptions));

// Route 2: Debug Health Check
app.get('/health', (req, res) => res.send('Proxy is alive'));

// Route 3: Root
app.get('/', (req, res) => {
    res.send('Proxy Backend Active. Open your local index.html.');
});

// Route 4: Catch-All (Assets/API)
app.use((req, res, next) => {
    if (!req.cookies.target_site) {
        // If we lost the cookie, try to recover using Referer or default
        console.log("Missing cookie for:", req.url);
        return res.status(404).send("Session lost. Please reload from the start.");
    }
    next();
}, createProxyMiddleware(proxyOptions));

app.listen(PORT, () => console.log(`Proxy running on ${PORT}`));
