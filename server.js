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

    if (!url) return res.status(400).send('Missing url parameter');

    try {
        const response = await fetch(url);
        const body = await response.text();
        
        // Pass the original status code back
        res.status(response.status).send(body);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));