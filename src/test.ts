import { combineStreams } from "./stream";
import fs from 'fs';

async function main() {
    let outputDir = 'recordings/Room 156-B/2025-02-06T13-25-38.057Z';
    let fileContents = fs.readdirSync(outputDir);
    fileContents = fileContents.sort();
    await combineStreams(
        'test',
        fileContents,
        outputDir,
        'complete.mp4',
        false

    )
}

main().catch(console.error);