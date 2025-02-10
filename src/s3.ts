import { config } from "./config";

const AWS = require('aws-sdk');
const fs = require('fs');

AWS.config.update({
    accessKeyId: config.AWS.ACCESS_KEY,
    secretAccessKey: config.AWS.SECRET_ACCESS_KEY
});

const s3 = new AWS.S3({
    params: { Bucket: config.AWS.S3_BUCKET },
    region: config.AWS.REGION,
    hostname: 's3.amazonaws.com',
});

function getPresignedUrl(bucketFileName: string, expirationInSeconds: number = 3600): Promise<string> {
    const params = {
        Bucket: config.AWS.S3_BUCKET,
        Key: bucketFileName,
        Expires: expirationInSeconds
    };

    return new Promise((resolve, reject) => {
        s3.getSignedUrl('getObject', params, (err: Error, url: string) => {
            if (err) reject(err);
            resolve(url);
        });
    });
}

export async function uploadFile(bucketFileName: string, fileLocation: string): Promise<string> {
    await new Promise((resolve, reject) => {
        fs.readFile(fileLocation, function (err: Error, data: string) {
            if (err) reject(err);

            const content = new Buffer(data, 'binary');

            const params = {
                Bucket: config.AWS.S3_BUCKET,
                Key: bucketFileName,
                Body: content,
            };

            s3.putObject(params).promise().then(resolve);
        });
    });

    // Generate and return presigned URL after successful upload
    return await getPresignedUrl(bucketFileName, 60 * 60 * 24 * 7); // 1 week
}
