const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());

// --- THE NUCLEAR SCRIPT ---
// 1. Nukes Service Workers (Fixes workbox errors)
// 2. Intercepts fetch/XHR (Fixes socket.io errors)
const INJECTED_SCRIPT = `
<script>
(function() {
    console.warn("--- PROXY INTERCEPTOR ACTIVE ---");

    // 1. BLOCK SERVICE WORKERS
    // This forces the site to run in the main thread where we can control it
    if (navigator.serviceWorker) {
        navigator.serviceWorker.getRegistrations().then(regs => {
            regs.forEach(r => r.unregister());
        });
        Object.defineProperty(navigator, 'serviceWorker', {
            value: {
                register: () => Promise.reject(new Error("ServiceWorkers disabled by Proxy")),
                getRegistrations: () => Promise.resolve([]),
                ready: Promise.reject(new Error("Disabled"))
            },
            writable: false
        });
    }

    // 2. URL REWRITER
    function rewriteUrl(url) {
        if (!url) return url;
        
        // If it's a relative path (starts with /), leave it alone (it goes to our proxy automatically)
        if (typeof url === 'string' && url.startsWith('/')) return url;

        // If it's a full URL (http...) and NOT our proxy, rewrite it
        if (typeof url === 'string' && url.startsWith('http') && !url.includes(window.location.host)) {
            console.log("Proxying:", url);
            return window.location.origin + '/proxy?url=' + encodeURIComponent(url);
        }
        return url;
    }

    // 3. MONKEY PATCH FETCH
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            input = rewriteUrl(input);
        } else if (input instanceof Request) {
            input = new Request(rewriteUrl(input.url), input);
        }
        return originalFetch(input, init);
    };

    // 4. MONKEY PATCH XHR (Fixes Socket.io)
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        return originalOpen.call(this, method, rewriteUrl(url), ...args);
    };

})();
</script>
`;

// Helper: Get target from query param OR cookie
const getTarget = (req) => {
    if (req.query.url) {
        try { return new URL(req.query.url).origin; } catch (e) {}
    }
    return req.cookies.target_site || 'https://www.google.com';
};

// --- PROXY CONFIGURATION ---
const proxyOptions = {
    target: 'https://www.google.com', // Default fallback
    changeOrigin: true,
    selfHandleResponse: true,
    cookieDomainRewrite: { "*": "" }, // Allow cookies on our domain
    router: (req) => getTarget(req),  // Dynamic routing
    onProxyReq: (proxyReq, req, res) => {
        // Force the target to think we are a standard browser
        proxyReq.setHeader('Accept-Encoding', 'identity'); // Disable gzip so we can edit HTML
    },
    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        const targetOrigin = getTarget(req);

        // 1. OVERWRITE CORS HEADERS
        // We strip the target's strict rules and replace them with "Allow Everyone"
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

        // Delete problematic security headers
        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['content-security-policy-report-only'];
        delete proxyRes.headers['access-control-allow-origin']; // Remove original to avoid duplicates

        // 2. INJECT SCRIPT INTO HTML
        const contentType = proxyRes.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            let html = responseBuffer.toString('utf8');
            // Inject immediately after <head> to run before other scripts
            return html.replace('<head>', '<head>' + INJECTED_SCRIPT);
        }
        return responseBuffer;
    })
};

// --- ROUTES ---

// 1. Explicit Proxy Endpoint (/proxy?url=...)
app.use('/proxy', (req, res, next) => {
    if (req.query.url) {
        try {
            const urlObj = new URL(req.query.url);
            // Set cookie so future relative requests work
            res.cookie('target_site', urlObj.origin, { path: '/', sameSite: 'none', secure: true });
            
            // Fix the path for the proxy middleware
            req.url = urlObj.pathname + urlObj.search;
        } catch (e) {
            return res.status(400).send("Invalid URL");
        }
    }
    next();
}, createProxyMiddleware(proxyOptions));

// 2. Main Entry Point (Root)
app.get('/', (req, res) => {
    res.send('Proxy Running. Use your local index.html.');
});

// 3. Catch-All for Assets (scripts, images, API calls like /api/currency)
// If the page requests /api/currency, it hits this route.
app.use((req, res, next) => {
    if (!req.cookies.target_site) {
        return res.status(404).send("Session lost. Go back to start.");
    }
    next();
}, createProxyMiddleware(proxyOptions));

app.listen(PORT, () => console.log(`Proxy running on ${PORT}`));
