
import path from 'path';
import { getSystemUsage } from './usage';
import { downloadStream } from './stream';

export async function checkM3U8Availability(m3u8Url: string): Promise<boolean> {
    let status;
    try {
        const rawData = await fetch(m3u8Url, {
            'headers': {
                'User-Agent': 'Mozilla/5.0',
                'Accept': '*/*',
            }
        });
        status = rawData.status;
    } catch (ex) {
        status = 404;
    }

    if (status === 200) return true;
    return false;
}


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
    private debug: boolean = false;

    constructor(
        private streams: StreamConfig[],
        private outputBaseDir: string,
        private checkIntervalMs: number = 5 * 60 * 1000, // 5 minutes
        debug: boolean = false
    ) {
        this.debug = debug;
        if (this.debug) console.log('StreamWatcher initialized with', streams.length, 'streams');
    }

    private log(...args: any[]) {
        if (this.debug) console.log('[StreamWatcher]', ...args);
    }

    private async processStream(stream: StreamConfig) {
        try {
            if (activeDownloads.has(stream.name)) {
                return;
            }

            this.log(`Checking availability for ${stream.name}`);
            const isAvailable = await checkM3U8Availability(stream.url);
            if (isAvailable) {
                this.log(`Stream ${stream.name} is available. Starting download...`);
                activeDownloads.add(stream.name);

                const outputDir = path.join(this.outputBaseDir, stream.name, new Date().toISOString().replace(/[:]/g, '-'));
                this.log(`Output directory for ${stream.name}: ${outputDir}`);

                try {
                    await downloadStream(
                        stream.url,
                        outputDir,
                        stream.uploadToS3,
                        stream.chunkDuration
                    );
                    this.log(`Download completed for ${stream.name}`);
                    activeDownloads.delete(stream.name);
                } catch (error) {
                    console.error(`Error downloading stream ${stream.name}:`, error);

                    activeDownloads.delete(stream.name);
                    // Schedule a quick retry for this specific stream
                    setTimeout(() => this.processStream(stream), 30000); // Retry after 30 seconds
                }
            } else {
                this.log(`Stream ${stream.name} is not available`);
            }
        } catch (error) {
            console.error(`Error processing stream ${stream.name}:`, error);

            activeDownloads.delete(stream.name);
        }
    }

    private async monitorSystemUsage() {
        try {
            const usage = await getSystemUsage();
            console.log(`System Status - CPU: ${usage.cpu}%, Memory Used: ${usage.memory.usagePercentage}%`);
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
    }
}

export { StreamWatcher, StreamConfig };

