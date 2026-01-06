const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');
const cookieParser = require('cookie-parser');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());

// --- THE POLITE SPY SCRIPT ---
// instead of breaking the Service Worker, we pretend it works perfectly.
// This prevents the "addEventListener is not a function" crash.
const INJECTED_SCRIPT = `
<script>
(function() {
    console.warn("--- PROXY INTERCEPTOR ACTIVE (SPY MODE) ---");

    // 1. FAKE SERVICE WORKER (The "Spy")
    // We create a dummy object that looks exactly like a real Service Worker
    // so the website code runs happily, but nothing actually happens.
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
            // When site asks to register, say "Sure!" but do nothing
            register: () => { 
                console.log('Proxy: Service Worker registration intercepted (Fake Success)');
                return Promise.resolve(dummyRegistration); 
            },
            // When site asks for existing workers, give them nothing or the dummy
            getRegistrations: () => Promise.resolve([]),
            // When site adds listeners, just nod and smile
            addEventListener: (type, listener) => { 
                console.log('Proxy: SW Listener ignored for ' + type); 
            },
            removeEventListener: () => {},
            // Important: Tell the site there is NO controller handling the page currently
            controller: null, 
            ready: Promise.resolve(dummyRegistration),
            startMessages: () => {}
        },
        writable: false,
        configurable: false
    });

    // 2. URL REWRITER & FETCH INTERCEPTOR
    function rewriteUrl(url) {
        if (!url) return url;
        // If relative, leave it alone
        if (typeof url === 'string' && url.startsWith('/')) return url;
        // If external, route through proxy
        if (typeof url === 'string' && url.startsWith('http') && !url.includes(window.location.host)) {
            console.log("Proxying request:", url);
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
    onProxyReq: (proxyReq, req, res) => {
        proxyReq.setHeader('Accept-Encoding', 'identity'); // Disable gzip
    },
    onProxyRes: responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
        const targetOrigin = getTarget(req);

        // Allow CORS for everyone
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

        delete proxyRes.headers['x-frame-options'];
        delete proxyRes.headers['content-security-policy'];
        delete proxyRes.headers['content-security-policy-report-only'];

        const contentType = proxyRes.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            let html = responseBuffer.toString('utf8');
            // Inject Spy Script
            return html.replace('<head>', '<head>' + INJECTED_SCRIPT);
        }
        return responseBuffer;
    })
};

// Routes
app.use('/proxy', (req, res, next) => {
    if (req.query.url) {
        try {
            const urlObj = new URL(req.query.url);
            res.cookie('target_site', urlObj.origin, { path: '/', sameSite: 'none', secure: true });
            req.url = urlObj.pathname + urlObj.search;
        } catch (e) { return res.status(400).send("Invalid URL"); }
    }
    next();
}, createProxyMiddleware(proxyOptions));

app.get('/', (req, res) => {
    res.send('Proxy Active. Run your index.html locally.');
});

app.use((req, res, next) => {
    if (!req.cookies.target_site) return res.status(404).send("Session lost.");
    next();
}, createProxyMiddleware(proxyOptions));

app.listen(PORT, () => console.log(`Proxy running on ${PORT}`));
