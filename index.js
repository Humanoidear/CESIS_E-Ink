const express = require('express');
const ical = require('node-ical');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const puppeteer = require('puppeteer');
const { start } = require('repl');

const app = express();
const port = process.env.PORT || 3000;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_KEY);
const skipParse = process.env.SKIP_PARSE === 'true';

app.use(express.json());

let browserInstance = null;
let eventsCache = null;
let cacheTimestamp = null;

async function getBrowser() {
    if (!browserInstance) {
        browserInstance = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        console.log('Puppeteer browser instance initialized');
    }
    return browserInstance;
}

function loadEventsCache() {
    const dataPath = path.join(__dirname, 'json', 'structured_events.json');
    if (!fs.existsSync(dataPath)) {
        eventsCache = null;
        cacheTimestamp = null;
        return null;
    }

    const stats = fs.statSync(dataPath);
    const fileModTime = stats.mtime.getTime();

    if (!eventsCache || !cacheTimestamp || fileModTime > cacheTimestamp) {
        const rawData = fs.readFileSync(dataPath, 'utf8');
        eventsCache = JSON.parse(rawData);
        cacheTimestamp = fileModTime;
        console.log(`Events cache loaded/refreshed: ${eventsCache.length} events`);
    }

    return eventsCache;
}

// Generate an event image as base64
async function generateEventImage(event, roomCode, nextEvent) {
    let canvasHtml;
    const style = `
    <style>
            body {
                width: 854px;
                height: 480px;
                margin: 0;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: space-between;
                font-family: eurostile, sans-serif;
                background-color: #ffffff;
            }
            .event-container {
                margin: 30px;
                width: calc(100% - 60px);
            }
            .event-title {
                font-size: 65px;
                font-weight: 700;
                margin-bottom: 18px;
                color: #1a1a1a;
            }
            .event-time {
                font-size: 45px;
                margin-bottom: 16px;
                color: #333;
            }
            .event-teacher {
                font-size: 40px;
                color: #555;
            }
            .logo-container {
                width: 100%;
                display: flex;
                justify-content: flex-start;
                align-items: center;
                padding-top: 20px;
                padding-left: 40px;
                background-color: #e3e0e0ff;
            }
        </style>
        `;

    if (!event) {
        const roomName = roomCode || 'Unknown Room';

        let message;
        if (nextEvent) {
            const startVal = nextEvent.startTime || nextEvent.start;
            const title = nextEvent.title || 'Sense Títol';
            const teacher = nextEvent.organizer && nextEvent.organizer.name ? nextEvent.organizer.name : '';
            message = `La pròxima classe és <b>${title}</b> ${teacher ? 'amb <b>' + teacher + '</b>' : ''} ${startVal ? 'a les <b>' + new Date(startVal).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + '</b>' : ''}`;
        } else {
            message = 'Hui no hi han pròxims esdeveniments a aquesta sala';
        }

        canvasHtml = `
        <html>
        <head>
            ${style}
        </head>
            <body>
        <div class="logo-container">
        <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/e/e0/Universitat_de_Val%C3%A8ncia_logo.svg/1280px-Universitat_de_Val%C3%A8ncia_logo.svg.png" alt="CESIS Logo" style="width:200px; margin-bottom:20px;">
        </div>
        <div class="event-container">
            <div class="event-time">
                Sala Lliure
            </div>
            <div class="event-title" style="font-size: 68px;">${roomName}</div>
            <div class="event-teacher" style="font-size:36px; margin-top:12px;">${message}</div>
        </div>
    </body>
        </html>
        `;
    } else {
        const startTime = event.startTime || event.start;
        const endTime = event.endTime || event.end;
        const teachers = (event.organizer && event.organizer.name) ? event.organizer.name : (event.organizer || '');
        const formatTime = value => {
            if (!value) return 'Unknown';
            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return 'Unknown';
            return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
        };

        canvasHtml = `
    <html>
    <head>
        ${style}
    </head>
    <body>
        <div class="logo-container">
        <img src="https://upload.wikimedia.org/wikipedia/commons/thumb/e/e0/Universitat_de_Val%C3%A8ncia_logo.svg/1280px-Universitat_de_Val%C3%A8ncia_logo.svg.png" alt="CESIS Logo" style="width:200px; margin-bottom:20px;">
        </div>
        <div class="event-container">
            <div class="event-time">
                ${formatTime(startTime)} - ${formatTime(endTime)}
            </div>
            <div class="event-title">${event.title || event.summary || 'No Title'}</div>
            <div class="event-teacher">${teachers || ''}</div>
        </div>
    </body>
    </html>
    `;
    }

    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setViewport({ width: 854, height: 480, deviceScaleFactor: 1 });
        await page.setContent(canvasHtml, { waitUntil: 'networkidle0' });
        const screenshot = await page.screenshot({ type: 'png' });
        return screenshot.toString('base64');
    } finally {
        await page.close(); // Close page, not browser
    }
}

// Parse iCal and structure events using Gemini AI, then save it to structured_events.json
async function parseICal() {
    const icalUrl = process.env.ICAL_URL;

    const events = await ical.async.fromURL(icalUrl);

    const eventsArray = Object.values(events).map(event => ({
        type: event.type,
        summary: event.summary,
        description: event.description,
        start: event.start,
        end: event.end,
        location: event.location,
        organizer: event.organizer,
        attendees: event.attendee,
        status: event.status,
        uid: event.uid
    }));

    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const prompt = `You are a calendar event parser. Parse the following iCal events and return a clean, structured JSON array.
For each event, extract and organize:
- title (from summary)
- startTime (ISO 8601 format)
- endTime (ISO 8601 format)
- location (There may be multiple, separate with an array of locations)
- subject code (Cod. XXXXXX from the summary)
- organizer (name and email if available)

Return ONLY valid JSON, no markdown formatting or explanation.

Events data:
${JSON.stringify(eventsArray, null, 2)}`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    let structuredData = response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsedData = JSON.parse(structuredData);

    const outputDir = path.join(__dirname, 'json');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir);
    }
    const outputPath = path.join(outputDir, 'structured_events.json');
    fs.writeFileSync(outputPath, JSON.stringify(parsedData, null, 2));
    console.log(`${new Date().toISOString()} -  Structured events saved to ${outputPath}`);

    // Invalidate cache to force reload on next request
    cacheTimestamp = null;

    return { originalEventCount: eventsArray.length, structuredEvents: parsedData };
}

// Read the structured_events.json file and return the corresponding event image based on the room requested and the time of the request
app.post('/data', async (req, res) => {
    try {
        const { room } = req.body;

        let timeNow;
        if (skipParse) {
            timeNow = new Date('2025-11-07T09:00:00Z');
        } else {
            timeNow = new Date();
        }

        // Use in-memory cache instead of reading file every time
        const allEvents = loadEventsCache();
        if (!allEvents) {
            return res.status(500).json({ error: 'Structured events data not found' });
        }

        // Pre-calculate today's date once
        const todayYear = timeNow.getFullYear();
        const todayMonth = timeNow.getMonth();
        const todayDate = timeNow.getDate();

        // Single pass through events to find current and next
        let currentEvent = null;
        let nextEvent = null;
        const timeNowMs = timeNow.getTime();

        for (const event of allEvents) {
            if (!event.startTime || !event.endTime || !event.location) continue;
            if (!event.location.includes(room)) continue;

            const eventStart = new Date(event.startTime);

            // Check if event is on the same calendar date
            if (eventStart.getFullYear() !== todayYear ||
                eventStart.getMonth() !== todayMonth ||
                eventStart.getDate() !== todayDate) {
                continue;
            }

            const eventStartMs = eventStart.getTime();
            const eventEndMs = new Date(event.endTime).getTime();

            // Check if this is the current event
            if (timeNowMs >= eventStartMs && timeNowMs <= eventEndMs) {
                currentEvent = event;
                break; // Found current event, no need to continue
            }

            // Check if this is a future event today
            if (eventStartMs > timeNowMs) {
                if (!nextEvent || eventStartMs < new Date(nextEvent.startTime).getTime()) {
                    nextEvent = event;
                }
            }
        }

        const image = await generateEventImage(currentEvent, room, nextEvent);

        // Write the image to a test file if skipParse is true
        if (skipParse) {
            const testImagePath = path.join(__dirname, 'test_event_image.png');
            fs.writeFileSync(testImagePath, Buffer.from(image, 'base64'));
            console.log(`Test event image saved to ${testImagePath}`);
        }

        // Prepare a human friendly message about next event if no current event
        let nextEventMessage = null;
        if (!currentEvent) {
            if (nextEvent) {
                const startIso = new Date(nextEvent.startTime).toISOString();
                nextEventMessage = `Next event "${nextEvent.title || nextEvent.summary || 'No Title'}" starts at ${startIso}`;
            } else {
                nextEventMessage = 'No upcoming events for this room';
            }
        }

        // Return the event details, next-event info and image as base64
        res.json({
            room,
            currentTime: timeNow.toISOString(),
            event: currentEvent,
            nextEvent: nextEvent || null,
            nextEventMessage,
            imageBase64: image
        });
    } catch (error) {
        console.error('Error processing iCal:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.listen(port, () => {
    console.log(`CESIS E-Ink Server listening on port ${port}, \nconnect to http://localhost:${port}/data with the room code in POST body. \n\n Example curl request: \ncurl -X POST http://localhost:3000/data
-H "Content-Type: application/json"
-d '{"room":"2.05 Odontología"}'`);
});

// Initial and recurring iCal parsing job
if (!skipParse) {
    parseICal().catch(err => console.error('Startup iCal processing failed:', err));
    cron.schedule('0 0 * * 0', () => {
        parseICal().catch(err => console.error('Scheduled iCal processing failed:', err));
    });
}