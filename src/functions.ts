
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

export function bytesToSize(bytes: number): string {
    const sizes = ['', 'K', 'M', 'G', 'T'];
    if (bytes === 0) return '0';
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1000, i)).toFixed(2) + ' ' + sizes[i];
}