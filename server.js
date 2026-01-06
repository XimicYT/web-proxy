const express = require('express');
const httpProxy = require('http-proxy');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'))); // Optional: for local assets

// Create Proxy Server
const proxy = httpProxy.createProxyServer({
    followRedirects: true,
    changeOrigin: true,
    selfHandleResponse: false
});

// ERROR HANDLING
proxy.on('error', (err, req, res) => {
    console.error("Proxy Error:", err);
    res.status(500).send("Proxy Error: " + err.message);
});

// RESPONSE INTERCEPTOR (The Magic)
// This fixes "Location" headers so redirects stay within the proxy
proxy.on('proxyRes', function (proxyRes, req, res) {
    // 1. Rewrite Location Header (for redirects)
    if (proxyRes.headers['location']) {
        let location = proxyRes.headers['location'];
        // If the redirect is absolute (https://target.com/...), force it back to our proxy
        if (location.startsWith('http')) {
            const newUrl = new URL(location);
            // Update the session cookie to the new domain
            res.cookie('current_site', newUrl.origin, { path: '/' });
            // Redirect browser to /proxy?url=... so it re-enters our logic
            proxyRes.headers['location'] = `/proxy?url=${encodeURIComponent(location)}`;
        }
    }

    // 2. Rewrite Cookie Domains (so the browser accepts them)
    // If pkmn.gg sets a cookie for ".pkmn.gg", your localhost browser will drop it. 
    // We strip the domain so it defaults to localhost.
    const rawCookies = proxyRes.headers['set-cookie'];
    if (rawCookies) {
        proxyRes.headers['set-cookie'] = rawCookies.map(cookie => {
            return cookie.replace(/Domain=[^;]+;/gi, ''); 
        });
    }
});

// 1. UI Route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 2. Proxy Logic
app.use((req, res) => {
    // Ignore direct requests to favicon (optional)
    if (req.url === '/favicon.ico') return res.status(404).end();

    let target = '';
    
    // CASE A: User explicitly enters a URL via query param (e.g., /proxy?url=...)
    if (req.url.startsWith('/proxy')) {
        const queryUrl = req.query.url;
        if (queryUrl) {
            target = queryUrl;
            
            // Parse the target to get the origin (https://site.com) and the path (/home)
            try {
                const targetObj = new URL(target);
                
                // Save origin to cookie for future asset requests
                res.cookie('current_site', targetObj.origin, { path: '/' });

                // CRITICAL FIX: Rewrite req.url to the actual path the target expects
                // If user asks for /proxy?url=https://site.com/foo, target needs /foo
                req.url = targetObj.pathname + targetObj.search;
                
                // Set the target for the proxy
                target = targetObj.origin;
            } catch (e) {
                return res.status(400).send("Invalid URL provided");
            }
        }
    } 
    // CASE B: Browser requests assets (style.css, /_next/static/...)
    // We look at the cookie to remember where we are connected.
    else {
        const storedSite = req.cookies.current_site;
        if (storedSite) {
            target = storedSite;
        } else {
            // No cookie and no URL param? Send them back to home.
            return res.redirect('/');
        }
    }

    // Perform the Proxy
    console.log(`Proxying ${req.method} ${req.url} -> ${target}`);
    
    proxy.web(req, res, {
        target: target,
        changeOrigin: true
    });
});

app.listen(PORT, () => console.log(`Enterprise Proxy running on port ${PORT}`));
