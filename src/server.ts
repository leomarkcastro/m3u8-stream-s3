import express from 'express';
import stateTracker, { globalTracker } from './stateTracker';
import { logger } from './utils/logger';
import { getSystemUsage } from './usage';
import path from 'path';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

function getPingHistoryString(streamName: string): string {
    const states = stateTracker.getValue();
    if (!states || !states[streamName]) return '';

    return states[streamName].pingHistory
        .map(active => active ? 'O' : '_')
        .join('');
}

app.get('/', (_req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', async (_req, res) => {
    const states = JSON.parse(JSON.stringify(stateTracker.getValue()));
    const systemUsage = await getSystemUsage();
    const globalState = globalTracker.getValue();

    if (states) {
        for (const streamName in states) {
            states[streamName].pingHistory = getPingHistoryString(streamName);
        }
    }

    res.json({
        timestamp: new Date().toISOString(),
        states: states || {},
        system: systemUsage,
        global: globalState,
    });
});

export function startServer() {
    app.listen(port, () => {
        logger.log(`Server is running on port ${port}`);
    });
    return app;
}
