import { GlobalState } from './types';

export const UPLOADED_FILE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export function pruneUploadedFiles(
    files: GlobalState['uploadedFiles'],
    now = Date.now()
): GlobalState['uploadedFiles'] {
    return files.filter((file) => {
        const createdAt = new Date(file.createdAt).getTime();
        return !Number.isNaN(createdAt) && now - createdAt <= UPLOADED_FILE_RETENTION_MS;
    });
}

class StateTracker<T> {
    private static instance: StateTracker<any> | null = null;
    private value: T | null = null;

    private constructor() {
        if (StateTracker.instance) {
            throw new Error("Use StateTracker.getInstance()");
        }
        StateTracker.instance = this;
    }

    public static getInstance<T>(
        startingValue: T
    ): StateTracker<T> {
        if (!StateTracker.instance) {
            StateTracker.instance = new StateTracker<T>();
            StateTracker.instance.value = startingValue;
        }
        return StateTracker.instance;
    }

    public getValue<U = T>(): U | null {
        return this.value as U | null;
    }

    public setValue(newValue: T): void {
        this.value = newValue;
    }
}
const globalTracker = StateTracker.getInstance<GlobalState>({
    uploadedFiles: []
});

export function retainRecentUploads(now = Date.now()): GlobalState['uploadedFiles'] {
    const current = globalTracker.getValue();
    const uploadedFiles = pruneUploadedFiles(current?.uploadedFiles ?? [], now);
    if (current && uploadedFiles.length !== current.uploadedFiles.length) {
        globalTracker.setValue({ uploadedFiles });
    }
    return uploadedFiles;
}

export default globalTracker;