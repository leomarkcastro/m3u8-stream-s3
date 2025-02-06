import { config } from "./config";
import { StreamWatcher } from "./watcher";
import { startServer } from './server';

async function main() {
    const streamWatcher = new StreamWatcher(
        (JSON.parse(config.STREAM.STREAM_DATA) as {
            name: string;
            url: string;
        }[]).map(stream => {
            return ({
                name: stream.name,
                url: stream.url,
                uploadToS3: true,
                chunkDuration: config.STREAM.CHUNK_DURATION_S,
            })
        }),
        "recordings",
        config.STREAM.CHECK_INTERVAL_MS,
        true
    )

    streamWatcher.start();

    // Start the Express server
    startServer();

    // Handle graceful shutdown
    process.on('SIGTERM', () => {
        streamWatcher.stop();
        process.exit(0);
    });

    // let outputDir = 'recordings/Room 130/2025-01-15T16-28-31.370Z';
    // let fileContents = fs.readdirSync(outputDir);
    // // sort the fileCOntents
    // fileContents = fileContents.sort();
    // await combineStreams(fileContents, outputDir, 'complete.mp4');
}

main().catch(console.error);