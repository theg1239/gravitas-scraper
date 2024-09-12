const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const path = require('path');
const WebSocket = require('ws');
const admin = require('firebase-admin'); // Import Firebase Admin SDK
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
const firebaseCredentialsBase64 = process.env.FIREBASE_CREDENTIALS_BASE64;
if (!firebaseCredentialsBase64) {
    console.error('Missing FIREBASE_CREDENTIALS_BASE64 environment variable');
    process.exit(1);
}
const decodedCredentials = Buffer.from(firebaseCredentialsBase64, 'base64').toString('utf8');
const firebaseConfig = JSON.parse(decodedCredentials);

admin.initializeApp({
    credential: admin.credential.cert(firebaseConfig),
});

const firestore = admin.firestore(); // Initialize Firestore
const messaging = admin.messaging(); // Initialize Firebase Messaging

app.use(express.static(path.join(__dirname, 'build')));

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
}));

const wss = new WebSocket.Server({ noServer: true });

const eventUrl1 = 'https://gravitas.vit.ac.in/events/ea3eb2e8-7036-4265-9c9d-ecb8866d176b'; // Cryptic event
const eventUrl2 = 'https://gravitas.vit.ac.in/events/c78879df-65f1-4eb2-a9fd-c80fb122369f'; // Codex event

let availableSeatsEvent1 = null;
let availableSeatsEvent2 = null;

// Variables to store previous seat counts
let previousAvailableSeatsEvent1 = null;
let previousAvailableSeatsEvent2 = null;

// Function to send notification
const sendNotification = async (title, body, tokens) => {
    const message = {
        notification: {
            title,
            body,
        },
        tokens, // Array of push tokens to send to
    };

    try {
        console.log(`Sending notification: ${title} - ${body}`);
        const response = await messaging.sendMulticast(message);

        // Handle success and errors
        const tokensToRemove = [];
        response.responses.forEach((resp, idx) => {
            if (!resp.success) {
                console.error(`Failed to send notification to ${tokens[idx]}:`, resp.error);
                // Remove invalid tokens
                if (
                    resp.error.code === 'messaging/invalid-registration-token' ||
                    resp.error.code === 'messaging/registration-token-not-registered'
                ) {
                    tokensToRemove.push(tokens[idx]);
                }
            }
        });

        // Remove invalid tokens from Firestore
        if (tokensToRemove.length > 0) {
            const batch = firestore.batch();
            tokensToRemove.forEach((token) => {
                const tokenRef = firestore.collection('pushTokens').doc(token);
                batch.delete(tokenRef);
            });
            await batch.commit();
            console.log(`Removed ${tokensToRemove.length} invalid tokens from Firestore.`);
        }

        console.log(`Notification sent to ${response.successCount} devices.`);
    } catch (error) {
        console.error('Error sending notification:', error);
    }
};

// Function to scrape seat data
async function scrapeSeats(eventUrl, eventNumber, eventDoc) {
    try {
        const browser = await puppeteer.launch({
            cacheDirectory: '/app/.cache/puppeteer',
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions',
            ],
            executablePath: process.env.CHROME_BIN || null,
        });

        const page = await browser.newPage();
        console.log(`Navigating to event URL: ${eventUrl} for event ${eventNumber}`);

        await page.goto(eventUrl, { waitUntil: 'networkidle2' });
        await page.waitForSelector('p.text-xs.md\\:text-sm', { timeout: 10000 });

        const seatsText = await page.$eval('p.text-xs.md\\:text-sm', el => el.textContent);

        let availableSeats;
        if (seatsText.includes('Seats Full')) {
            availableSeats = 0; // Seats full
        } else {
            availableSeats = parseInt(seatsText.split(':')[1].trim());
        }

        console.log(`Scraped available seats for Event ${eventNumber}: ${availableSeats}`);

        if (eventNumber === 1) {
            availableSeatsEvent1 = availableSeats;
        } else if (eventNumber === 2) {
            availableSeatsEvent2 = availableSeats;
        }

        await updateFirestore(eventDoc, availableSeats);

        await browser.close();

        return availableSeats;
    } catch (error) {
        console.error(`Error scraping seat data for Event ${eventNumber}:`, error);
        throw error;
    }
}

// Function to scrape and check seat count for a specific event
async function scrapeAndCheckEvent(eventUrl, eventNumber, eventDoc) {
    try {
        const availableSeats = await scrapeSeats(eventUrl, eventNumber, eventDoc);

        let previousAvailableSeats;
        if (eventNumber === 1) {
            previousAvailableSeats = previousAvailableSeatsEvent1;
            previousAvailableSeatsEvent1 = availableSeats;
        } else if (eventNumber === 2) {
            previousAvailableSeats = previousAvailableSeatsEvent2;
            previousAvailableSeatsEvent2 = availableSeats;
        }

        if (previousAvailableSeats === null) {
            console.log(`Initial seat count for Event ${eventNumber} (${eventDoc}): ${availableSeats}`);
            return;
        }

        if (availableSeats !== previousAvailableSeats) {
            console.log(`Seat count changed for Event ${eventNumber} (${eventDoc}). Previous: ${previousAvailableSeats}, New: ${availableSeats}`);

            // Fetch push tokens from 'pushTokens' collection
            const pushTokensSnapshot = await firestore.collection('pushTokens').get();
            const pushTokens = pushTokensSnapshot.docs.map(doc => doc.data().token);

            if (pushTokens.length > 0) {
                const title = `Seats Updated for ${eventDoc === 'cryptic' ? 'Cryptic Hunt' : 'Codex Cryptum'}`;
                const body = `Cryptic Hunt: ${availableSeatsEvent1} seats left.\nCodex Cryptum: ${availableSeatsEvent2} seats left.`;
                await sendNotification(title, body, pushTokens);
            } else {
                console.log('No push tokens available to send notifications.');
            }
        } else {
            console.log(`Seat count did not change for Event ${eventNumber} (${eventDoc}).`);
        }
    } catch (error) {
        console.error(`Error scraping and checking Event ${eventNumber}:`, error);
    }
}

// Update Firestore
async function updateFirestore(eventDoc, availableSeats) {
    try {
        const docRef = firestore.collection('events').doc(eventDoc);

        let totalSeats;
        if (eventDoc === 'cryptic') {
            totalSeats = 800; // Total seats for cryptic event
        } else if (eventDoc === 'codex') {
            totalSeats = 200; // Total seats for codex event
        }

        const seatsFilled = totalSeats - availableSeats;

        await docRef.set({
            availableSeats,
            seatsFilled,
            totalSeats,
            timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });

        console.log(`Firestore updated for ${eventDoc} with ${availableSeats} available seats and ${seatsFilled} seats filled.`);
    } catch (error) {
        console.error(`Error updating Firestore for ${eventDoc}:`, error);
    }
}

function broadcastConfetti() {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send('triggerConfetti');
        }
    });
}

// Set intervals for each event
setInterval(() => scrapeAndCheckEvent(eventUrl1, 1, 'cryptic'), 15000);
setInterval(() => scrapeAndCheckEvent(eventUrl2, 2, 'codex'), 15000);

// Express routes
app.get('/seats1', (req, res) => {
    if (availableSeatsEvent1 !== null) {
        res.json({ availableSeats: availableSeatsEvent1 });
    } else {
        res.status(503).json({ error: 'Seat data for Event 1 is not yet available' });
    }
});

app.get('/seats2', (req, res) => {
    if (availableSeatsEvent2 !== null) {
        res.json({ availableSeats: availableSeatsEvent2 });
    } else {
        res.status(503).json({ error: 'Seat data for Event 2 is not yet available' });
    }
});

app.post('/trigger-confetti', (req, res) => {
    broadcastConfetti();
    res.json({ message: 'Confetti triggered for all clients!' });
});

app.get('/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

const server = app.listen(PORT, () => {
    console.log(`Proxy server running at http://localhost:${PORT}`);
    scrapeAndCheckEvent(eventUrl1, 1, 'cryptic'); // Initial scrape for Event 1
    scrapeAndCheckEvent(eventUrl2, 2, 'codex');   // Initial scrape for Event 2
});

server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
    });
});
