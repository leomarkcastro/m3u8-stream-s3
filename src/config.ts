import dotenv from 'dotenv';
dotenv.config();

export const config = {
    SYSTEM: process.env.SYSTEM || 'local',
    AWS: {
        ACCESS_KEY: process.env.AWS_ACCESS_KEY || '',
        SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
        REGION: process.env.AWS_REGION || '',
        S3_BUCKET: process.env.AWS_S3_BUCKET || '',
        S3_SAVE_PATH: process.env.AWS_S3_SAVE_PATH || 'stream_backup',
    },
    STREAM: {
        CHECK_INTERVAL_MS: Number(process.env.STREAM_CHECK_INTERVAL_MS) || 5 * 60 * 1000,
        CHUNK_DURATION_S: Number(process.env.STREAM_CHUNK_DURATION_S) || 300,
        STREAM_DATA: process.env.STREAM_DATA || '[]',
    }
}
