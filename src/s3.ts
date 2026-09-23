import { config } from "./config";

const AWS = require('aws-sdk');
const fs = require('fs');

let s3Client: any = null;

function spacesEndpoint(): string {
    const trimmed = config.AWS.ENDPOINT.trim().replace(/\/$/, '');
    if (!trimmed) {
        throw new Error('AWS_S3_ENDPOINT is required for DigitalOcean Spaces uploads (example: https://nyc3.digitaloceanspaces.com)');
    }
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function spacesRegion(endpoint: string): string {
    const host = new URL(endpoint).hostname;
    const region = host.split('.')[0];
    if (region && !region.includes('digitaloceanspaces')) return region;
    return config.AWS.REGION;
}

function getS3() {
    if (s3Client) return s3Client;

    const endpoint = spacesEndpoint();
    s3Client = new AWS.S3({
        endpoint: new AWS.Endpoint(endpoint),
        accessKeyId: config.AWS.ACCESS_KEY,
        secretAccessKey: config.AWS.SECRET_ACCESS_KEY,
        region: spacesRegion(endpoint),
        signatureVersion: 'v4',
        s3ForcePathStyle: false,
    });
    return s3Client;
}

function getPresignedUrl(bucketFileName: string, expirationInSeconds: number = 3600): Promise<string> {
    const params = {
        Bucket: config.AWS.S3_BUCKET,
        Key: bucketFileName,
        Expires: expirationInSeconds
    };

    return new Promise((resolve, reject) => {
        getS3().getSignedUrl('getObject', params, (err: Error, url: string) => {
            if (err) reject(err);
            resolve(url);
        });
    });
}

export async function uploadFile(bucketFileName: string, fileLocation: string): Promise<string> {
    const s3 = getS3();

    await new Promise((resolve, reject) => {
        fs.readFile(fileLocation, function (err: Error, data: string) {
            if (err) {
                reject(err);
                return;
            }

            const content = new Buffer(data, 'binary');

            const params = {
                Bucket: config.AWS.S3_BUCKET,
                Key: bucketFileName,
                Body: content,
            };

            s3.putObject(params).promise().then(resolve).catch(reject);
        });
    });

    // Generate and return presigned URL after successful upload
    return await getPresignedUrl(bucketFileName, 60 * 60 * 24 * 7); // 1 week
}
