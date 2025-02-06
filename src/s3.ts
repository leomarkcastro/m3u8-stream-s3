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

export async function uploadFile(bucketFileName: string, fileLocation: string) {
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
}
