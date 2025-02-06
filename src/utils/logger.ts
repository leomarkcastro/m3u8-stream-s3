type LogEntry = {
    timestamp: Date;
    message: string;
    data?: any;
};

class Logger {
    private logs: LogEntry[] = [];

    log(message: string, data?: any) {
        const entry: LogEntry = {
            timestamp: new Date(),
            message,
            data
        };
        this.logs.push(entry);
        console.log(`${message}`, data || '');
    }

    getLogs(): LogEntry[] {
        return [...this.logs];
    }

    clearLogs() {
        this.logs = [];
    }
}

export const logger = new Logger();
