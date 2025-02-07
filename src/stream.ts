import fs from 'fs';
import path from 'path';
import { config } from './config';
import { uploadFile } from './s3';
import ffmpeg from 'fluent-ffmpeg';
import { dir } from 'tmp-promise';
import chokidar from 'chokidar';
import { logger } from './utils/logger';
import globalTracker from './globalTracker';

// size to KB, MB conversion
function formatBytes(bytes: number, decimals = 2): string {
    if (bytes === 0) return '0 Bytes';

    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

    const i = Math.floor(Math.log(bytes) / Math.log(k));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function selectStreamQuality(name: string, masterM3u8Url: string, preferredQuality: 'highest' | 'lowest' | number = 'lowest'): Promise<string> {
    try {
        const response = await fetch(masterM3u8Url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/vnd.apple.mpegurl',
            }
        });

        if (!response.headers.get('Content-Type')?.includes('application/vnd.apple.mpegurl')) {
            throw new Error('Invalid stream type. Expected m3u8 playlist.');
        }
        const manifest = await response.text();

        // Parse the M3U8 manifest to find different quality streams
        const streamUrls: { bandwidth: number; url: string }[] = [];
        const lines = manifest.split('\n');
        let currentBandwidth: number | null = null;

        for (const line of lines) {
            if (line.includes('#EXT-X-STREAM-INF')) {
                const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
                currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : null;
            } else if (line.trim() && !line.startsWith('#') && currentBandwidth) {
                const streamUrl = new URL(line, masterM3u8Url).href;
                streamUrls.push({ bandwidth: currentBandwidth, url: streamUrl });
                currentBandwidth = null;
            }
        }

        if (streamUrls.length === 0) {
            return masterM3u8Url;
        }

        // Sort streams by bandwidth
        streamUrls.sort((a, b) => a.bandwidth - b.bandwidth);

        let selectedStream: string;
        if (preferredQuality === 'highest') {
            selectedStream = streamUrls[streamUrls.length - 1].url;
            logger.log(`[${name}] Selected highest quality: ${streamUrls[streamUrls.length - 1].bandwidth / 1000}kbps`);
        } else if (preferredQuality === 'lowest') {
            selectedStream = streamUrls[0].url;
            logger.log(`[${name}] Selected lowest quality: ${streamUrls[0].bandwidth / 1000}kbps`);
        } else {
            // Find the closest matching bandwidth
            const closest = streamUrls.reduce((prev, curr) => {
                return Math.abs(curr.bandwidth - preferredQuality) < Math.abs(prev.bandwidth - preferredQuality)
                    ? curr
                    : prev;
            });
            selectedStream = closest.url;
            logger.log(`[${name}] Selected closest quality to ${preferredQuality / 1000}kbps: ${closest.bandwidth / 1000}kbps`);
        }

        return selectedStream;
    } catch (error) {
        console.error('Error parsing master playlist:', error);
        logger.log(`[${name}]  Falling back to original URL`);
        return masterM3u8Url;
    }
}

export async function downloadHLSTOMp4(
    name: string,
    m3u8Url: string,
    chunkDuration: number = 5, // Default chunk duration in seconds
    onBuffer: (buffer: Buffer) => Promise<void>,
    onTimeUpdate: (timemark: string) => void,
    onEnd: (directory: string, streamFiles: string[]) => Promise<void>,
    preferredQuality: 'highest' | 'lowest' | number = 'lowest'
): Promise<void> {
    const selectedStreamUrl = await selectStreamQuality(name, m3u8Url, preferredQuality);

    // Create a temporary directory
    const { path: tmpDir, cleanup } = await dir({ unsafeCleanup: true });

    // Watch for new files in the temporary directory
    const watcher = chokidar.watch(tmpDir, {
        persistent: true,
        // usePolling: true,
        interval: 10_000,
        ignored: (file, _stats) => Boolean(_stats?.isFile() && !file.endsWith('.mp4')),
        awaitWriteFinish: {
            pollInterval: 10_000,
            stabilityThreshold: 60 * 1_000 // wait 1 minute after last write
        },
        atomic: true
    });

    watcher.on('add', async (filePath) => {
        logger.log(`[${name}] New file detected: ${filePath}`);
        try {
            const buffer = await fs.promises.readFile(filePath);
            onBuffer(buffer);
        } catch (err) {
            console.error('Error reading file buffer:', err);
        }
    });


    // Save HLS to MP4 chunks in the temporary directory
    const output = path.join(tmpDir, 'output-%03d.mp4');
    const ffmpegCommand = ffmpeg();

    ffmpegCommand.setFfmpegPath('/usr/bin/ffmpeg')

    ffmpegCommand.input(selectedStreamUrl);
    ffmpegCommand.videoCodec('libx264');
    ffmpegCommand.audioCodec('aac');
    ffmpegCommand.outputOptions([
        '-movflags', 'faststart',
        '-f', 'segment',
        '-segment_time', chunkDuration.toString(),
        '-reset_timestamps', '1',
        '-segment_start_number', '0',
        '-segment_format', 'mp4',
        '-force_key_frames', `expr:gte(t,n_forced*${chunkDuration})`,
        '-sc_threshold', '0'  // Disable scene detection
    ]);
    ffmpegCommand.output(output);
    ffmpegCommand.on('end', async () => {
        logger.log('ffmpeg end');
        // wait for 1 minute before closing the watcher
        await new Promise((resolve) => setTimeout(resolve, 3 * 60 * 1_000));
        await watcher.close();
        const streamFiles = fs.readdirSync(tmpDir);
        await onEnd(tmpDir, streamFiles);
        // sleep for 5 minutes before cleanup
        await cleanup();
    });
    ffmpegCommand.on('error', async (err) => {
        logger.log('ffmpeg error', err);
        await new Promise((resolve) => setTimeout(resolve, 3 * 60 * 1_000));
        await watcher.close();
        const streamFiles = fs.readdirSync(tmpDir);
        await onEnd(tmpDir, streamFiles);
        await cleanup();
    });
    ffmpegCommand.on('progress', (progress) => {
        logger.log(`[${name}] Processing: ${progress.timemark}ms done`);
        onTimeUpdate(progress.timemark);
    });
    ffmpegCommand.run();
}

export function downloadStream(
    name: string,
    streamUrl: string,
    outputDir: string,
    uploadToS3: boolean = false,
    chunkDuration: number = 60,
    onTimeUpdate: (timemark: string) => void,
    onFileUpload?: (file: string) => void
): Promise<void> {
    return new Promise((resolve, reject) => {
        // Clear output directory if it exists
        if (fs.existsSync(outputDir)) {
            fs.readdirSync(outputDir).forEach((file) => {
                const filePath = path.join(outputDir, file);
                fs.unlinkSync(filePath);
            });
            fs.rmdirSync(outputDir);
        }

        // Create fresh output directory
        fs.mkdirSync(outputDir, { recursive: true });

        downloadHLSTOMp4(
            name,
            streamUrl,
            chunkDuration,
            async (buffer) => {
                let time = new Date().toISOString().replace(/[:]/g, '-');
                const filename = `chunk-${time}.mp4`;
                const localPath = path.join(outputDir, filename);

                try {
                    await fs.promises.writeFile(localPath, buffer);
                    logger.log(`[${name}] Local Save ${localPath}`);

                    if (uploadToS3) {
                        // replace backslashes with forward slashes
                        let s3Path = outputDir.replace(/\\/g, '/').replace('recordings/', '');
                        const s3ChunkPath = `${config.AWS.S3_SAVE_PATH}/${s3Path}/${filename}`;
                        await uploadFile(s3ChunkPath, localPath);
                        logger.log(`[${name}] S3 Upload ${s3ChunkPath}`);
                        onFileUpload?.(s3ChunkPath);
                    }
                } catch (err) {
                    console.error(`[${name}] Error saving/uploading file:`, err);
                    reject(err);
                }
            },
            onTimeUpdate,
            async (tmpDir, _streamFiles) => {
                try {
                    let fileContents = fs.readdirSync(outputDir);
                    fileContents = fileContents.sort();
                    await combineStreams(name, fileContents, outputDir, 'complete.mp4', uploadToS3);

                    // delete all files in the output directory
                    for (const file of fileContents) {
                        fs.unlinkSync(path.join(outputDir, file));
                    }

                    resolve();
                } catch (err) {
                    reject(err);
                }
            }
        ).catch(reject);
    });
}


export async function combineStreams(
    name: string,
    streamFiles: string[],
    outputDir: string,
    outputFileName: string = 'output.mp4', // Add default value
    uploadToS3: boolean = false
): Promise<void> {
    return new Promise((resolve, _reject) => {
        // if output file exists, delete it
        if (fs.existsSync(path.join(outputDir, outputFileName))) {
            fs.unlinkSync(path.join(outputDir, outputFileName));
        }

        let dir = __dirname.replace(/\\/g, '/').replace('/dist', '');

        // Create a concat file
        const concatFilePath = path.join(dir, outputDir, 'concat.txt')
            // convert backslashes to forward slashes
            .replace(/\\/g, '/');
        const fileContent = streamFiles
            .map(file => {
                const t = `file '${path.join(dir, outputDir, file)}'`
                    // convert backslashes to forward slashes
                    .replace(/\\/g, '/');
                return t;

            })
            .join('\n');
        fs.writeFileSync(concatFilePath, fileContent);

        let ffmpegCommand = ffmpeg();
        ffmpegCommand.setFfmpegPath('/usr/bin/ffmpeg')
        ffmpegCommand.setFfprobePath('/usr/bin/ffprobe')


        let cmd = ffmpegCommand
            .on('error', function (err) {
                logger.log(`[${name}] An error occurred: ` + err.message);
                console.error('An error occurred: ' + err.message);
                fs.unlinkSync(concatFilePath);
                resolve();
            })
            .on('end', async function () {
                logger.log(`[${name}] ` + outputFileName + ': Processing finished !');
                console.log(outputFileName + ': Processing finished !');
                fs.unlinkSync(concatFilePath);

                if (uploadToS3) {
                    const dirName = outputDir.replace(/\\/g, '/').replace('recordings/', '');
                    const s3FinalPath = `${config.AWS.S3_SAVE_PATH}/${dirName}/${outputFileName}`;
                    let curFiles = globalTracker.getValue()?.uploadedFiles ?? [];
                    globalTracker.setValue({
                        uploadedFiles: [...curFiles, {
                            name: name,
                            createdAt: new Date().toISOString(),
                            url: s3FinalPath,
                            size: formatBytes(fs.statSync(path.join(outputDir, outputFileName)).size, 2),
                        }]
                    })
                    await uploadFile(s3FinalPath, path.join(outputDir, outputFileName));
                }

                resolve();
            });

        cmd.input(concatFilePath)
            .inputOptions([
                '-f',
                'concat',
                '-safe', '0'
            ])
            .outputOptions([
                '-c:v', 'copy',
                '-c:a', 'copy',
                '-movflags', '+faststart'
            ]);

        cmd.save(outputDir + "/" + outputFileName);

    });
}