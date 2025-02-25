import path from 'path';
import { downloadStream } from './stream';
import { StreamStates } from './types';
import stateTracker from './stateTracker';
import { logger } from './utils/logger';
import { getSystemUsage } from './usage';
import { bytesToSize, checkM3U8Availability } from './functions';
import { sendWebhookEvent } from './webhook';
import { config } from './config';
import { randomID } from './utils/randomID';



const activeDownloads = new Set<string>();

interface StreamConfig {
    name: string;
    url: string;
    uploadToS3?: boolean;
    chunkDuration?: number;  // Duration in seconds
}

class StreamWatcher {
    private checkInterval: NodeJS.Timeout | null = null;
    private usageInterval: NodeJS.Timeout | null = null;
    private pingInterval: NodeJS.Timeout | null = null;

    constructor(
        private streams: StreamConfig[],
        private outputBaseDir: string,
        private checkIntervalMs: number = 5 * 60 * 1000, // 5 minutes
        _debug: boolean = false
    ) {
        this.initializeStates();
    }

    log(_message: string) {
        logger.log(_message);
    }

    private initializeStates() {
        const states: StreamStates = {};
        this.streams.forEach(stream => {
            states[stream.name] = {
                sessionID: '',
                isActive: false,
                currentTimemark: '0',
                lastActiveTime: null,
                fileLogs: [],
                uploadedFiles: [],
                pingHistory: new Array(96).fill(false), // 24h * 4 (15-min intervals)
                url: stream.url
            };
        });
        stateTracker.setValue(states);
    }

    private updatePingHistory() {
        const states = stateTracker.getValue();
        if (!states) return;

        Object.keys(states).forEach(streamName => {
            const state = states[streamName];
            state.pingHistory.shift();
            state.pingHistory.push(state.isActive);
        });
        stateTracker.setValue(states);
    }


    private async processStream(stream: StreamConfig) {
        const states = stateTracker.getValue();
        if (!states) return;

        try {
            if (activeDownloads.has(stream.name)) {
                return;
            }

            this.log(`Checking availability for ${stream.name}`);
            const isAvailable = await checkM3U8Availability(stream.url);

            states[stream.name].isActive = isAvailable;
            if (isAvailable) {
                let sessionID = randomID(10);
                states[stream.name].lastActiveTime = new Date();
                states[stream.name].sessionID = sessionID;
                activeDownloads.add(stream.name);

                const outputDir = path.join(this.outputBaseDir, stream.name, new Date().toISOString().replace(/[:]/g, '-') + '-' + sessionID);
                this.log(`Output directory for ${stream.name}: ${outputDir}`);

                await sendWebhookEvent({
                    type: 'streamStart',
                    payload: {
                        name: stream.name,
                        url: stream.url,
                        source: stream.url,
                        sessionID: sessionID,
                    },
                    server: config.STREAM_SERVER_NAME,
                    time: new Date().toISOString(),
                });

                try {
                    await downloadStream(
                        sessionID,
                        stream.name,
                        stream.url,
                        outputDir,
                        stream.uploadToS3,
                        stream.chunkDuration,
                        (args: { frames: number; currentFps: number; currentKbps: number; targetSize: number; timemark: string; percent?: number | undefined }) => {
                            states[stream.name].currentTimemark = `${args.timemark} (${args.currentFps} fps) @ ${bytesToSize(args.frames)}`;
                            stateTracker.setValue(states);
                        },
                        (file: string, size: number) => {
                            states[stream.name].fileLogs.push(`${file} - ${bytesToSize(size)}`);
                            // Limit file logs to 10
                            if (states[stream.name].fileLogs.length > 10) {
                                states[stream.name].fileLogs.shift();
                            }
                            stateTracker.setValue(states);
                        },
                        (file, fileSize) => {
                            states[stream.name].uploadedFiles.push({
                                url: file,
                                size: bytesToSize(fileSize)
                            });
                            stateTracker.setValue(states);
                        }
                    );

                } catch (error) {
                    console.error(`Error downloading stream ${stream.name}:`, error);
                    setTimeout(() => this.processStream(stream), 30000);
                } finally {

                    // Clean up state after stream ends
                    states[stream.name].sessionID = '';
                    states[stream.name].currentTimemark = '0';
                    states[stream.name].uploadedFiles = [];
                    states[stream.name].isActive = false;
                    states[stream.name].fileLogs = [];
                    stateTracker.setValue(states);

                    activeDownloads.delete(stream.name);


                    await sendWebhookEvent({
                        type: 'streamEnd',
                        payload: {
                            name: stream.name,
                            url: stream.url,
                            source: stream.url,
                            sessionID: sessionID,
                        },
                        server: config.STREAM_SERVER_NAME,
                        time: new Date().toISOString(),
                    });
                }
            }
        } catch (error) {
            console.error(`Error processing stream ${stream.name}:`, error);
            states[stream.name].isActive = false;
            stateTracker.setValue(states);
            activeDownloads.delete(stream.name);
        }
    }

    private async monitorSystemUsage() {
        try {
            const usage = await getSystemUsage();
            logger.log(`System Status - CPU: ${usage.cpu}%, Memory Used: ${usage.memory.usagePercentage}%`);
        } catch (error) {
            console.error('Error monitoring system usage:', error);
        }
    }

    async checkAndDownloadStreams() {
        this.log('Starting stream check cycle');

        // Process each stream independently
        this.streams.forEach(stream => {
            this.processStream(stream).catch(error => {
                console.error(`Unhandled error processing stream ${stream.name}:`, error);
            });
        });

        this.log('Finished initiating stream check cycle');
    }

    start() {
        this.log('Starting StreamWatcher service');
        // Initial check
        this.checkAndDownloadStreams();

        // Set up periodic checking
        this.checkInterval = setInterval(() => {
            this.checkAndDownloadStreams();
        }, this.checkIntervalMs);

        // Set up system usage monitoring
        this.monitorSystemUsage(); // Initial check
        this.usageInterval = setInterval(() => {
            this.monitorSystemUsage();
        }, 60_000); // Every 15 seconds

        // Set up ping history tracking
        this.pingInterval = setInterval(() => {
            this.updatePingHistory();
        }, 15 * 60 * 1000); // Every 15 minutes
    }

    stop() {
        this.log('Stopping StreamWatcher service');
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        if (this.usageInterval) {
            clearInterval(this.usageInterval);
            this.usageInterval = null;
        }
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
    }
}

export { StreamWatcher, StreamConfig };

