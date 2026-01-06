const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Enable CORS so your frontend works
app.use(cors());

// 2. Serve the frontend file (index.html)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 3. The Proxy Logic
app.get('/proxy', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).send('Missing url');

    try {
        const targetUrl = new URL(url);
        const response = await fetch(url);
        let body = await response.text();

        // REWRITE LOGIC:
        // This finds attributes like src="/..." or href="/..." 
        // and changes them to src="https://target.com/..."
        const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
        
        // Fix absolute paths (starting with /)
        body = body.replace(/(src|href|action)="\/(?!\/)/g, `$1="${baseUrl}/`);
        
        // Fix relative paths (starting with ./)
        body = body.replace(/(src|href|action)="\.\//g, `$1="${baseUrl}/`);

        res.setHeader('Content-Type', 'text/html');
        res.send(body);
    } catch (err) {
        res.status(500).send("Error: " + err.message);
    }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
