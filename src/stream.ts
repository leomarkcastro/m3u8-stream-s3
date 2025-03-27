import fs from "fs";
import path from "path";
import { config } from "./config";
import { uploadFile } from "./s3";
import ffmpeg from "fluent-ffmpeg";
import { logger } from "./utils/logger";
import globalTracker from "./globalTracker";
import getVideoDurationInSeconds from "get-video-duration";
import { checkM3U8Availability } from "./functions";
import { sendWebhookEvent } from "./webhook";

// size to KB, MB conversion
function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

async function selectStreamQuality(
  name: string,
  masterM3u8Url: string,
  preferredQuality: "highest" | "lowest" | number = "lowest"
): Promise<string> {
  try {
    const response = await fetch(masterM3u8Url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/vnd.apple.mpegurl",
      },
    });

    if (
      !response.headers
        .get("Content-Type")
        ?.includes("application/vnd.apple.mpegurl")
    ) {
      throw new Error("Invalid stream type. Expected m3u8 playlist.");
    }
    const manifest = await response.text();

    // Check if this is a direct stream (contains EXTINF tags) rather than a master playlist
    if (manifest.includes("#EXTINF")) {
      logger.log(`[${name}] Direct stream detected, using original URL`);
      return masterM3u8Url;
    }

    // Parse the M3U8 manifest to find different quality streams
    const streamUrls: { bandwidth: number; url: string }[] = [];
    const lines = manifest.split("\n");
    let currentBandwidth: number | null = null;

    for (const line of lines) {
      if (line.includes("#EXT-X-STREAM-INF")) {
        const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
        currentBandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]) : null;
      } else if (line.trim() && !line.startsWith("#") && currentBandwidth) {
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
    if (preferredQuality === "highest") {
      selectedStream = streamUrls[streamUrls.length - 1].url;
      logger.log(
        `[${name}] Selected highest quality: ${
          streamUrls[streamUrls.length - 1].bandwidth / 1000
        }kbps`
      );
    } else if (preferredQuality === "lowest") {
      selectedStream = streamUrls[0].url;
      logger.log(
        `[${name}] Selected lowest quality: ${
          streamUrls[0].bandwidth / 1000
        }kbps`
      );
    } else {
      // Find the closest matching bandwidth
      const closest = streamUrls.reduce((prev, curr) => {
        return Math.abs(curr.bandwidth - preferredQuality) <
          Math.abs(prev.bandwidth - preferredQuality)
          ? curr
          : prev;
      });
      selectedStream = closest.url;
      logger.log(
        `[${name}] Selected closest quality to ${
          preferredQuality / 1000
        }kbps: ${closest.bandwidth / 1000}kbps`
      );
    }

    return selectedStream;
  } catch (error) {
    console.error("Error parsing master playlist:", error);
    logger.log(`[${name}]  Falling back to original URL`);
    return masterM3u8Url;
  }
}

export async function downloadHLSTOMp4(
  name: string,
  m3u8Url: string,
  chunkDuration: number = 5, // Default chunk duration in seconds
  onBuffer: (buffer: Buffer) => Promise<void>,
  onTimeUpdate: (args: {
    frames: number;
    currentFps: number;
    currentKbps: number;
    targetSize: number;
    timemark: string;
    percent?: number | undefined;
  }) => void,
  onFileReady: (file: string, fileSize: number) => void,
  onEnd: (directory: string, streamFiles: string[]) => Promise<void>,
  preferredQuality: "highest" | "lowest" | number = "lowest",
  maxRuntime: number = 8 * 60 * 60 * 1000 // Default max runtime: 8 hours
): Promise<void> {
  const selectedStreamUrl = await selectStreamQuality(
    name,
    m3u8Url,
    preferredQuality
  );
  const streamStatus = {
    m3u8StreamEndedAt: 0,
    forceEnded: false,
  };

  // Create a new repository named temp/ (creates a new directory in the system's temp directory), using fs
  const tmpDir = path.join(__dirname, "temp", name);
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  async function cleanup() {
    // Only clear the specific directory of name, not the entire temp directory
    fs.rmdirSync(tmpDir, { recursive: true });
  }

  const fileWatcherInterval = setInterval(async () => {
    try {
      // get files from tmpDir along with their last modified time
      const streamFiles = fs.readdirSync(tmpDir).map((file) => {
        return {
          name: file,
          mtime: fs.statSync(path.join(tmpDir, file)).mtime.getTime(),
          ctime: fs.statSync(path.join(tmpDir, file)).ctime.getTime(),
        };
      });

      // Check if the first file on list is locked(being written to)
      const recentFiles = streamFiles.sort((a, b) => a.ctime - b.ctime);

      let toProcess: {
        name: string;
        mtime: number;
        ctime: number;
      }[] = [];
      let streamEnded = false;

      for (const file of recentFiles) {
        let isReady = false;

        try {
          let videoDuration = await getVideoDurationInSeconds(
            path.join(tmpDir, file.name),
            "/usr/bin/ffprobe"
          );

          let actualDuration = Math.ceil(videoDuration);
          let percentage = Math.floor((videoDuration / chunkDuration) * 100);

          onFileReady(
            file.name + `[${actualDuration}/${chunkDuration}] (${percentage}%)`,
            0
          );

          if (actualDuration >= chunkDuration) {
            isReady = isReady || true;
          } else if (
            streamStatus.m3u8StreamEndedAt > 0 &&
            streamStatus.m3u8StreamEndedAt < Date.now() - 60 * 1_000
          ) {
            // if the stream ended, the file is ready to be processed
            isReady = isReady || true;
            streamEnded = true;
          } else if (!(await checkM3U8Availability(m3u8Url))) {
            // if the stream ended, the file is ready to be processed
            isReady = isReady || true;
            streamEnded = true;
          }
        } catch (err) {
          logger.log(`[${name}] Error checking video duration: ${err}`);
        }

        if (isReady) {
          toProcess.push(file);
        }
      }

      // get the buffer of that file and call onBuffer
      for (const file of toProcess) {
        try {
          const buffer = fs.readFileSync(path.join(tmpDir, file.name));
          onFileReady(file.name, buffer.length);
          await onBuffer(buffer);

          // delete the temporary file after processing
          fs.unlinkSync(path.join(tmpDir, file.name));
        } catch (err) {
          logger.log(`[${name}] Error processing file ${file.name}: ${err}`);
        }
      }

      if (streamEnded) {
        streamStatus.forceEnded = true;
      }
    } catch (err) {
      logger.log(`[${name}] Error in file watcher interval: ${err}`);
    }
  }, 30 * 1_000); // check every 30 seconds

  // Set a global timeout to prevent the function from running indefinitely
  const globalTimeout = setTimeout(async () => {
    logger.log(
      `[${name}] Global timeout reached, force ending stream processing`
    );
    streamStatus.forceEnded = true;
    streamStatus.m3u8StreamEndedAt = Date.now();

    // Wait a bit for the normal handlers to trigger
    await new Promise((resolve) => setTimeout(resolve, 30000));

    // If still running, force clean up
    if (fileWatcherInterval) {
      clearInterval(fileWatcherInterval);
      const streamFiles = fs.readdirSync(tmpDir);
      await onEnd(tmpDir, streamFiles);
      await cleanup();
    }
  }, maxRuntime);

  // Save HLS to MP4 chunks in the temporary directory
  const output = path.join(tmpDir, "output-%03d.mp4");
  const ffmpegCommand = ffmpeg();

  ffmpegCommand.setFfmpegPath("/usr/bin/ffmpeg");

  ffmpegCommand.input(selectedStreamUrl);
  ffmpegCommand.inputOptions([
    "-re", // Read input at native frame rate
    "-hwaccel auto", // Enable hardware acceleration if available
    "-i_qfactor 0.71", // Improve quality
    "-qcomp 0.6", // Compression parameter
  ]);
  ffmpegCommand.videoCodec("libx264");
  ffmpegCommand.audioCodec("aac");
  ffmpegCommand.outputOptions([
    // '-movflags', 'faststart',
    "-f",
    "segment",
    "-segment_time",
    chunkDuration.toString(),
    "-reset_timestamps",
    "1",
    "-segment_start_number",
    "0",
    "-segment_format",
    "mp4",
    "-force_key_frames",
    `expr:gte(t,n_forced*${chunkDuration})`,
    "-sc_threshold",
    "0", // Disable scene detection
    "-preset fast", // Fast encoding preset
    "-max_muxing_queue_size 1024", // Handle large queues
    "-avoid_negative_ts make_zero", // Handle negative timestamps
  ]);
  ffmpegCommand.output(output);
  ffmpegCommand.on("end", async () => {
    logger.log("ffmpeg end");
    streamStatus.m3u8StreamEndedAt = Date.now();
    clearTimeout(globalTimeout);

    // Add maximum wait time to prevent deadlock
    const maxWaitTime = 120 * 1_000; // 3 minutes maximum wait
    const startWaitTime = Date.now();

    while (true) {
      if (fs.readdirSync(tmpDir).length === 0) {
        break;
      }
      if (streamStatus.forceEnded) {
        logger.log(
          `[${name}] Breaking wait loop after timeout or force end conditions met`
        );
        break;
      }

      if (Date.now() - startWaitTime > maxWaitTime) {
        logger.log(
          `[${name}] Breaking wait loop after timeout or force end conditions met`
        );
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    clearInterval(fileWatcherInterval);
    const streamFiles = fs.readdirSync(tmpDir);
    await onEnd(tmpDir, streamFiles);
    await cleanup();
  });
  ffmpegCommand.on("error", async (err) => {
    logger.log("ffmpeg error", err);
    streamStatus.m3u8StreamEndedAt = Date.now();
    clearTimeout(globalTimeout);

    // Add maximum wait time to prevent deadlock
    const maxWaitTime = 120 * 1_000; // 3 minutes maximum wait
    const startWaitTime = Date.now();

    while (true) {
      if (fs.readdirSync(tmpDir).length === 0) {
        break;
      }
      if (streamStatus.forceEnded) {
        logger.log(
          `[${name}] Breaking wait loop after timeout or force end conditions met`
        );
        break;
      }

      if (Date.now() - startWaitTime > maxWaitTime) {
        logger.log(
          `[${name}] Breaking wait loop after timeout or force end conditions met`
        );
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    clearInterval(fileWatcherInterval);
    const streamFiles = fs.readdirSync(tmpDir);
    await onEnd(tmpDir, streamFiles);
    await cleanup();
  });
  ffmpegCommand.on("progress", (progress) => {
    logger.log(`[${name}] Processing: ${progress.timemark}ms done`);
    onTimeUpdate(progress);
  });
  ffmpegCommand.run();
}

export function downloadStream(
  sessionID: string,
  name: string,
  streamUrl: string,
  outputDir: string,
  uploadToS3: boolean = false,
  chunkDuration: number = 60,
  onTimeUpdate: (args: {
    frames: number;
    currentFps: number;
    currentKbps: number;
    targetSize: number;
    timemark: string;
    percent?: number | undefined;
  }) => void,
  onFileUpdate: (file: string, fileSize: number) => void,
  onFileUpload?: (file: string, fileSize: number) => void,
  maxStreamDuration: number = 8 * 60 * 60 * 1000 // 8 hours max by default
): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.log(
      `[${name}] Starting stream download with timeout of ${
        maxStreamDuration / 60000
      } minutes`
    );

    // Add a failsafe timeout
    const failsafeTimeout = setTimeout(() => {
      logger.log(
        `[${name}] Failsafe timeout reached after ${
          maxStreamDuration / 60000
        } minutes`
      );
      resolve(); // Resolve the promise to prevent hanging
    }, maxStreamDuration + 5 * 60 * 1000); // Add 5 minutes buffer to the max duration

    try {
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
          let time = new Date().toISOString().replace(/[:]/g, "-");
          const filename = `chunk-${time}.mp4`;
          const localPath = path.join(outputDir, filename);

          try {
            await fs.promises.writeFile(localPath, buffer);
            logger.log(`[${name}] Local Save ${localPath}`);

            if (uploadToS3) {
              // replace backslashes with forward slashes
              let s3Path = outputDir
                .replace(/\\/g, "/")
                .replace("recordings/", "");
              const s3ChunkPath = `${config.AWS.S3_SAVE_PATH}/${config.STREAM_SERVER_NAME}/${s3Path}/${filename}`;
              const urlUpload = await uploadFile(s3ChunkPath, localPath);
              await sendWebhookEvent({
                type: "chunkUpload",
                payload: {
                  name,
                  url: urlUpload,
                  size: formatBytes(buffer.length, 2),
                  source: streamUrl,
                  sessionID,
                },
                server: config.STREAM_SERVER_NAME,
                time: new Date().toISOString(),
              });
              logger.log(`[${name}] S3 Upload ${urlUpload}`);
              onFileUpload?.(urlUpload, buffer.length);
            }
          } catch (err) {
            console.error(`[${name}] Error saving/uploading file:`, err);
            // Don't reject here, just log the error and continue
            logger.log(`[${name}] Error saving/uploading file: ${err}`);
          }
        },
        onTimeUpdate,
        onFileUpdate,
        async (tmpDir, _streamFiles) => {
          try {
            let fileContents = fs.readdirSync(outputDir);
            fileContents = fileContents.sort();
            if (fileContents.length > 0) {
              await combineStreams(
                sessionID,
                name,
                fileContents,
                outputDir,
                "complete.mp4",
                uploadToS3
              );

              // delete all files in the output directory
              for (const file of fileContents) {
                fs.unlinkSync(path.join(outputDir, file));
              }
            } else {
              logger.log(`[${name}] No files to combine in ${outputDir}`);
            }

            clearTimeout(failsafeTimeout);
            resolve();
          } catch (err) {
            logger.log(`[${name}] Error in onEnd handler: ${err}`);
            clearTimeout(failsafeTimeout);
            reject(err);
          }
        },
        "lowest", // preferredQuality
        maxStreamDuration
      ).catch((err) => {
        logger.log(`[${name}] Error in downloadHLSTOMp4: ${err}`);
        clearTimeout(failsafeTimeout);
        reject(err);
      });
    } catch (err) {
      logger.log(`[${name}] Unexpected error in downloadStream: ${err}`);
      clearTimeout(failsafeTimeout);
      reject(err);
    }
  });
}

export async function combineStreams(
  sessionID: string,
  name: string,
  streamFiles: string[],
  outputDir: string,
  outputFileName: string = "output.mp4", // Add default value
  uploadToS3: boolean = false
): Promise<void> {
  return new Promise((resolve, _reject) => {
    // if output file exists, delete it
    if (fs.existsSync(path.join(outputDir, outputFileName))) {
      fs.unlinkSync(path.join(outputDir, outputFileName));
    }

    let dir = __dirname.replace(/\\/g, "/").replace("/dist", "");

    // Create a concat file
    const concatFilePath = path
      .join(dir, outputDir, "concat.txt")
      // convert backslashes to forward slashes
      .replace(/\\/g, "/");
    const fileContent = streamFiles
      .map((file) => {
        const t = `file '${path.join(dir, outputDir, file)}'`
          // convert backslashes to forward slashes
          .replace(/\\/g, "/");
        return t;
      })
      .join("\n");
    fs.writeFileSync(concatFilePath, fileContent);

    let ffmpegCommand = ffmpeg();
    ffmpegCommand.setFfmpegPath("/usr/bin/ffmpeg");
    ffmpegCommand.setFfprobePath("/usr/bin/ffprobe");

    let cmd = ffmpegCommand
      .on("error", function (err) {
        logger.log(`[${name}] An error occurred: ` + err.message);
        console.error("An error occurred: " + err.message);
        fs.unlinkSync(concatFilePath);
        resolve();
      })
      .on("end", async function () {
        logger.log(`[${name}] ` + outputFileName + ": Processing finished !");
        console.log(outputFileName + ": Processing finished !");
        fs.unlinkSync(concatFilePath);

        if (uploadToS3) {
          const dirName = outputDir
            .replace(/\\/g, "/")
            .replace("recordings/", "");
          const s3FinalPath = `${config.AWS.S3_SAVE_PATH}/${config.STREAM_SERVER_NAME}/${dirName}/${outputFileName}`;
          let curFiles = globalTracker.getValue()?.uploadedFiles ?? [];
          const uploadedFileUrl = await uploadFile(
            s3FinalPath,
            path.join(outputDir, outputFileName)
          );
          globalTracker.setValue({
            uploadedFiles: [
              ...curFiles,
              {
                name: name,
                createdAt: new Date().toISOString(),
                url: uploadedFileUrl,
                size: formatBytes(
                  fs.statSync(path.join(outputDir, outputFileName)).size,
                  2
                ),
              },
            ],
          });
          await sendWebhookEvent({
            type: "completeUpload",
            payload: {
              name,
              url: uploadedFileUrl,
              size: formatBytes(
                fs.statSync(path.join(outputDir, outputFileName)).size,
                2
              ),
              chunkCount: streamFiles.length,
              sessionID,
            },
            server: config.STREAM_SERVER_NAME,
            time: new Date().toISOString(),
          });
        }

        resolve();
      });

    cmd
      .input(concatFilePath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions([
        "-c:v",
        "copy",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
      ]);

    cmd.save(outputDir + "/" + outputFileName);
  });
}
