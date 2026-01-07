const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 3000;

// --- TARGETS ---
const TARGET_MAIN = 'https://www.pkmn.gg';
const TARGET_SOCKET = 'https://sockets.pkmn.gg';
const TARGET_NAKED = 'https://pkmn.gg';

// --- 1. THE TRAP (Client-Side Injection) ---
const CLIENT_INJECTION = `
<script>
    console.log("--- PROXY V9: PINCER TRAP ACTIVE ---");
    
    const PROXY_ORIGIN = window.location.origin;

    // HELPER: Recursively clean objects
    function cleanObject(obj) {
        if (typeof obj === 'string') {
            if (obj.includes('pkmn.gg')) {
                return obj.replace(/https?:\\/\\/(www\\.)?pkmn\\.gg/g, PROXY_ORIGIN);
            }
            return obj;
        }
        if (typeof obj === 'object' && obj !== null) {
            for (let key in obj) {
                obj[key] = cleanObject(obj[key]);
            }
        }
        return obj;
    }

    // A. Intercept FETCH (Input & Output)
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
        // 1. Clean the URL being requested
        if (typeof input === 'string' && input.includes('pkmn.gg')) {
            try {
                const u = new URL(input);
                input = u.pathname + u.search;
            } catch(e) {}
        }
        
        // 2. Clean the Body being sent (e.g. telling server where to redirect)
        if (init && init.body && typeof init.body === 'string' && init.body.includes('pkmn.gg')) {
            init.body = init.body.replace(/https?:\\/\\/(www\\.)?pkmn\\.gg/g, PROXY_ORIGIN);
        }

        // 3. Perform the fetch
        const response = await originalFetch(input, init);

        // 4. Intercept JSON Responses (The Magic Link Fix)
        const clone = response.clone();
        const newResponse = new Response(response.body, response);
        
        newResponse.json = async function() {
            const text = await clone.text();
            // Brutal find-and-replace on the raw JSON text
            const cleanText = text.replace(/https?:\\\\?\\/\\\\?\\/(www\\.)?pkmn\\.gg/g, PROXY_ORIGIN);
            return JSON.parse(cleanText);
        };
        
        return newResponse;
    };

    // B. Intercept XMLHttpRequest (Input)
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (typeof url === 'string' && url.includes('pkmn.gg')) {
            try {
                const u = new URL(url);
                url = u.pathname + u.search;
            } catch(e) {}
        }
        return originalOpen.apply(this, arguments);
    };

    // C. Intercept JSON.parse (Global Safety Net)
    // If any other method tries to parse JSON containing the bad URL, we catch it.
    const originalParse = JSON.parse;
    JSON.parse = function(text, reviver) {
        if (typeof text === 'string' && text.includes('pkmn.gg')) {
             // Replace standard and escaped slashes
             text = text.replace(/https:\\/\\/(www\\.)?pkmn\\.gg/g, PROXY_ORIGIN);
             text = text.replace(/https:\\\\?\\/\\\\?\\/(www\\.)?pkmn\\.gg/g, PROXY_ORIGIN); // Extra escaped
        }
        return originalParse(text, reviver);
    };
</script>
`;

// --- 2. SERVER CONFIGURATION ---

const commonOptions = {
    target: TARGET_MAIN,
    changeOrigin: true,
    secure: true,
    cookieDomainRewrite: { "*": "" },
    selfHandleResponse: true,
    
    onProxyReq: (proxyReq, req, res) => {
        proxyReq.setHeader('Accept-Encoding', 'identity'); // Force plain text
        proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36');
        proxyReq.removeHeader('Origin');
        proxyReq.removeHeader('Referer');
    },

    onProxyRes: (proxyRes, req, res) => {
        const contentType = (proxyRes.headers['content-type'] || '').toLowerCase();
        const statusCode = proxyRes.statusCode;

        // --- HEADER FIXES ---
        if (proxyRes.headers['location']) {
            let redirect = proxyRes.headers['location'];
            redirect = redirect.replace(TARGET_MAIN, '')
                               .replace(TARGET_SOCKET, '')
                               .replace(TARGET_NAKED, '');
            res.setHeader('Location', redirect);
        }

        const headersToDelete = ['content-security-policy', 'x-frame-options', 'content-length', 'transfer-encoding'];
        Object.keys(proxyRes.headers).forEach(key => {
            if (!headersToDelete.includes(key.toLowerCase())) {
                res.setHeader(key, proxyRes.headers[key]);
            }
        });

        // --- DECISION: REWRITE OR STREAM? ---
        // We look for 'json' anywhere in the content type (application/json, vnd.api+json, etc)
        // We look for 'html'
        const shouldRewrite = contentType.includes('html') || contentType.includes('json');

        if (shouldRewrite) {
            // --- BUFFER & REWRITE ---
            let originalBody = [];
            proxyRes.on('data', (chunk) => originalBody.push(chunk));
            
            proxyRes.on('end', () => {
                const bodyBuffer = Buffer.concat(originalBody);
                let bodyString = bodyBuffer.toString('utf8');
                const myHost = 'https://' + req.headers.host;

                try {
                    // Global Replacement of Domain
                    const regexMain = new RegExp(TARGET_MAIN, 'g');
                    const regexNaked = new RegExp(TARGET_NAKED, 'g');
                    const regexSocket = new RegExp(TARGET_SOCKET, 'g');
                    
                    bodyString = bodyString.replace(regexMain, myHost)
                                           .replace(regexNaked, myHost)
                                           .replace(regexSocket, myHost);

                    // Escaped JSON Replacement
                    const escapedTarget = TARGET_MAIN.replace('/', '\\/');
                    const escapedMyHost = myHost.replace('/', '\\/');
                    const regexEscaped = new RegExp(escapedTarget, 'g');
                    bodyString = bodyString.replace(regexEscaped, escapedMyHost);

                } catch (e) { console.error(e); }

                // Inject Script (HTML Only)
                if (contentType.includes('html')) {
                    // Inject at top of head for earliest protection
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
            // --- FAST STREAM (JS, CSS, Images) ---
            res.status(statusCode);
            proxyRes.pipe(res);
        }
    }
};

// --- ROUTES ---

app.use((req, res, next) => {
    if (req.url.startsWith('/proxy')) return res.redirect('/');
    next();
});

app.use('/socket.io', createProxyMiddleware({
    target: TARGET_SOCKET,
    changeOrigin: true,
    ws: true,
    onProxyReq: (proxyReq) => proxyReq.setHeader('Origin', TARGET_MAIN)
}));

app.use('/', createProxyMiddleware(commonOptions));

app.listen(PORT, () => console.log(`--- PROXY V9 (PINCER) RUNNING ON ${PORT} ---`));
