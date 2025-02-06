import * as os from 'os';
import * as osUtils from 'os-utils';

interface SystemUsage {
    cpu: number;
    memory: {
        total: number;
        used: number;
        free: number;
        usagePercentage: number;
    };
}

export async function getSystemUsage(): Promise<SystemUsage> {
    const cpuUsage = await getCpuUsage();
    const memoryUsage = getMemoryUsage();

    return {
        cpu: cpuUsage,
        memory: memoryUsage
    };
}

function getMemoryUsage() {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;

    return {
        total: Math.round(totalMemory / 1024 / 1024), // Convert to MB
        used: Math.round(usedMemory / 1024 / 1024),
        free: Math.round(freeMemory / 1024 / 1024),
        usagePercentage: Math.round((usedMemory / totalMemory) * 100)
    };
}

function getCpuUsage(): Promise<number> {
    return new Promise((resolve) => {
        osUtils.cpuUsage((value) => {
            resolve(Math.round(value * 100));
        });
    });
}
