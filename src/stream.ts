import fs from 'fs';
import path from 'path';
import { config } from './config';
import { uploadFile } from './s3';
import ffmpeg from 'fluent-ffmpeg';
import { dir } from 'tmp-promise';
import chokidar from 'chokidar';

async function selectStreamQuality(name: string, masterM3u8Url: string, preferredQuality: 'highest' | 'lowest' | number = 'lowest'): Promise<string> {
    try {
        // console.log(`Fetching master playlist from: ${masterM3u8Url}`);
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

        // console.log('Parsing available stream qualities...');
        // console.log('lines', lines);
        for (const line of lines) {
            if (line.includes('#EXT-X-STREAM-INF')) {
                const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
                currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : null;
            } else if (line.trim() && !line.startsWith('#') && currentBandwidth) {
                const streamUrl = new URL(line, masterM3u8Url).href;
                streamUrls.push({ bandwidth: currentBandwidth, url: streamUrl });
                // console.log(`Found quality variant: ${currentBandwidth / 1000}kbps`);
                currentBandwidth = null;
            }
        }

        if (streamUrls.length === 0) {
            // console.log('No quality variants found, using original URL');
            return masterM3u8Url;
        }

        // Sort streams by bandwidth
        streamUrls.sort((a, b) => a.bandwidth - b.bandwidth);
        // console.log(`Found ${streamUrls.length} different quality variants`);

        let selectedStream: string;
        if (preferredQuality === 'highest') {
            selectedStream = streamUrls[streamUrls.length - 1].url;
            console.log(`[${name}] Selected highest quality: ${streamUrls[streamUrls.length - 1].bandwidth / 1000}kbps`);
        } else if (preferredQuality === 'lowest') {
            selectedStream = streamUrls[0].url;
            console.log(`[${name}] Selected lowest quality: ${streamUrls[0].bandwidth / 1000}kbps`);
        } else {
            // Find the closest matching bandwidth
            const closest = streamUrls.reduce((prev, curr) => {
                return Math.abs(curr.bandwidth - preferredQuality) < Math.abs(prev.bandwidth - preferredQuality)
                    ? curr
                    : prev;
            });
            selectedStream = closest.url;
            console.log(`[${name}] Selected closest quality to ${preferredQuality / 1000}kbps: ${closest.bandwidth / 1000}kbps`);
        }

        return selectedStream;
    } catch (error) {
        console.error('Error parsing master playlist:', error);
        console.log(`[${name}]  Falling back to original URL`);
        return masterM3u8Url;
    }
}

export async function downloadHLSTOMp4(
    name: string,
    m3u8Url: string,
    chunkDuration: number = 5, // Default chunk duration in seconds
    onBuffer: (buffer: Buffer) => Promise<void>,
    onEnd: (streamFiles: string[]) => Promise<void>,
    preferredQuality: 'highest' | 'lowest' | number = 'lowest'
): Promise<void> {
    const selectedStreamUrl = await selectStreamQuality(name, m3u8Url, preferredQuality);

    // Create a temporary directory
    const { path: tmpDir, cleanup } = await dir({ unsafeCleanup: true });

    // Watch for new files in the temporary directory
    const watcher = chokidar.watch(tmpDir, {
        persistent: true,
        usePolling: true,
        interval: 10_000,
        ignored: (file, _stats) => Boolean(_stats?.isFile() && !file.endsWith('.mp4')),
        awaitWriteFinish: {
            pollInterval: 5000,
            stabilityThreshold: 20_000
        }
    });

    watcher.on('add', async (filePath) => {
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
        console.log('ffmpeg end');
        await watcher.close();
        const streamFiles = fs.readdirSync(tmpDir);
        await onEnd(streamFiles);
        await cleanup();
    });
    ffmpegCommand.on('error', async (err) => {
        console.log('ffmpeg error', err);
        await watcher.close();
        const streamFiles = fs.readdirSync(tmpDir);
        await onEnd(streamFiles);
        await cleanup();
    });
    ffmpegCommand.on('progress', (progress) => {
        console.log(`[${name}] Processing: ${progress.timemark}ms done`);
    });
    ffmpegCommand.run();
}

export function downloadStream(
    name: string,
    streamUrl: string,
    outputDir: string,
    uploadToS3: boolean = false,
    chunkDuration: number = 60
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
                    console.log(`[${name}] Local Save ${localPath}`);

                    if (uploadToS3) {
                        // replace backslashes with forward slashes
                        let s3Path = outputDir.replace(/\\/g, '/').replace('recordings/', '');
                        const s3ChunkPath = `${config.AWS.S3_SAVE_PATH}/${s3Path}/${filename}`;
                        await uploadFile(s3ChunkPath, localPath);
                        console.log(`[${name}] S3 Upload ${s3ChunkPath}`);
                    }
                } catch (err) {
                    console.error(`[${name}] Error saving/uploading file:`, err);
                    reject(err);
                }
            },
            async (_streamFiles) => {
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

        // Create a concat file
        const concatFilePath = path.join(outputDir, 'concat.txt');
        const fileContent = streamFiles
            .map(file => `file '${path.join(outputDir, file)}'`)
            .join('\n');
        fs.writeFileSync(concatFilePath, fileContent);

        let ffmpegCommand = ffmpeg();
        ffmpegCommand.setFfmpegPath('/usr/bin/ffmpeg')
        ffmpegCommand.setFfprobePath('/usr/bin/ffprobe')


        let cmd = ffmpegCommand
            .on('error', function (err) {
                console.log(`[${name}] An error occurred: ` + err.message);
                fs.unlinkSync(concatFilePath);
                resolve();
            })
            .on('end', async function () {
                console.log(`[${name}] ` + outputFileName + ': Processing finished !');
                fs.unlinkSync(concatFilePath);

                if (uploadToS3) {
                    const dirName = outputDir.replace(/\\/g, '/').replace('recordings/', '');
                    const s3FinalPath = `${config.AWS.S3_SAVE_PATH}/${dirName}/${outputFileName}`;
                    await uploadFile(s3FinalPath, path.join(outputDir, outputFileName));
                }

                resolve();
            });

        cmd.input(concatFilePath)
            .inputOptions(['-f', 'concat', '-safe', '0'])
            .outputOptions([
                '-c:v', 'copy',
                '-c:a', 'copy',
                '-movflags', '+faststart'
            ]);

        cmd.save(outputDir + "/" + outputFileName);

    });
}