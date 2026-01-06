const express = require('express');
const httpProxy = require('http-proxy');
const cookieParser = require('cookie-parser');
const zlib = require('zlib'); // Built-in Node module

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());

// The Magic Script to inject into every page
// This overrides the browser's fetch and XHR tools to route everything through our proxy
const INJECTED_SCRIPT = `
<script>
(function() {
    console.log("--> Enterprise Proxy Interceptor Loaded <--");

    // Helper: Rewrite external URLs to go through our proxy
    function rewriteUrl(url) {
        if (!url) return url;
        // If it's an absolute URL (http...) and NOT our own domain, proxy it!
        if (typeof url === 'string' && url.startsWith('http') && !url.includes(window.location.host)) {
            console.log("Rewriting request to:", url);
            return '/proxy?url=' + encodeURIComponent(url);
        }
        return url;
    }

    // 1. Monkey Patch window.fetch
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === 'string') {
            input = rewriteUrl(input);
        } else if (input instanceof Request) {
            // Clone the request with the new URL
            input = new Request(rewriteUrl(input.url), input);
        }
        return originalFetch(input, init);
    };

    // 2. Monkey Patch XMLHttpRequest (This fixes the socket.io errors)
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        url = rewriteUrl(url);
        return originalOpen.call(this, method, url, ...args);
    };
})();
</script>
`;

const proxy = httpProxy.createProxyServer({
    followRedirects: true,
    changeOrigin: true,
    selfHandleResponse: true, // We will handle the output manually
    secure: false
});

proxy.on('error', (err, req, res) => {
    console.error("Proxy Error:", err);
    if (!res.headersSent) res.status(500).end();
});

proxy.on('proxyReq', (proxyReq, req, res, options) => {
    // CRITICAL: Tell the target server NOT to compress data (gzip).
    // We need plain text so we can inject our script.
    proxyReq.setHeader('Accept-Encoding', ''); 
});

proxy.on('proxyRes', (proxyRes, req, res) => {
    // 1. Clean up headers
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
    delete proxyRes.headers['content-security-policy-report-only'];
    delete proxyRes.headers['x-content-type-options'];
    
    // Remove content-length because we are adding our own script, changing the size
    delete proxyRes.headers['content-length'];

    // 2. Copy status and headers to our response
    res.writeHead(proxyRes.statusCode, proxyRes.headers);

    // 3. Handle the body
    let body = [];
    proxyRes.on('data', function (chunk) {
        body.push(chunk);
    });

    proxyRes.on('end', function () {
        // Combine all chunks
        let responseBody = Buffer.concat(body);
        
        // Check if this is an HTML page
        const contentType = proxyRes.headers['content-type'] || '';
        if (contentType.includes('text/html')) {
            try {
                let htmlString = responseBody.toString('utf8');
                // Inject our script right before the </head> tag
                htmlString = htmlString.replace('</head>', INJECTED_SCRIPT + '</head>');
                responseBody = Buffer.from(htmlString);
            } catch (e) {
                console.error("Error injecting script:", e);
            }
        }

        // Send the modified body to the user
        res.end(responseBody);
    });
});

app.get('/', (req, res) => {
    res.send('Proxy Backend Running. Double-click your index.html file now.');
});

app.use((req, res) => {
    if (req.url === '/favicon.ico') return res.status(404).end();

    let target = '';
    let reqPath = req.url;

    // Handle new request
    if (req.url.startsWith('/proxy')) {
        const queryUrl = req.query.url;
        if (!queryUrl) return res.status(400).send("No URL provided");
        
        try {
            const targetObj = new URL(queryUrl);
            target = targetObj.origin;
            reqPath = targetObj.pathname + targetObj.search;
            // Set cookie for subsequent requests
            res.cookie('target_site', target, { path: '/', sameSite: 'none', secure: true });
        } catch (e) {
            return res.status(400).send("Invalid URL");
        }
    } 
    // Handle Assets / Sub-resources
    else {
        target = req.cookies.target_site;
        if (!target) return res.status(404).send("No session found. Please go back to start.");
    }

    req.url = reqPath; // Update URL to just the path (e.g., /style.css)

    proxy.web(req, res, {
        target: target,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/110.0.0.0 Safari/537.36',
            'Referer': target,
            'Origin': target
        }
    });
});

app.listen(PORT, () => console.log(`Proxy running on ${PORT}`));
