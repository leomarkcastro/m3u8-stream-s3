import express from 'express';
import stateTracker from './stateTracker';
import { logger } from './utils/logger';

const app = express();
const port = process.env.PORT || 3000;

function getPingHistoryString(streamName: string): string {
    const states = stateTracker.getValue();
    if (!states || !states[streamName]) return '';

    return states[streamName].pingHistory
        .map(active => active ? 'O' : '_')
        .join('');
}

app.get('/state', (_req, res) => {
    const states = JSON.parse(JSON.stringify(stateTracker.getValue()));
    if (states) {
        for (const streamName in states) {
            // @ts-ignore
            states[streamName].pingHistory = getPingHistoryString(streamName);
        }
    }
    res.json({
        timestamp: new Date().toISOString(),
        states: states || {}
    });
});



export function startServer() {
    app.listen(port, () => {
        logger.log(`Server is running on port ${port}`);
    });
    return app;
}
