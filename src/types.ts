
export interface StreamState {
    isActive: boolean;
    currentTimemark: string;
    fileLogs: string[];
    lastActiveTime: Date | null;
    uploadedFiles: string[];
    pingHistory: boolean[];
    url: string;
}

export interface StreamStates {
    [streamName: string]: StreamState;
}

export interface GlobalState {
    uploadedFiles: {
        name: string;
        url: string;
        createdAt: string;
        size: string;
    }[];
}