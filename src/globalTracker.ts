import { GlobalState } from './types';

class StateTracker<T> {
    private static instance: StateTracker<any> | null = null;
    private value: T | null = null;

    private constructor() {
        if (StateTracker.instance) {
            throw new Error("Use StateTracker.getInstance()");
        }
        StateTracker.instance = this;
    }

    public static getInstance<T>(): StateTracker<T> {
        if (!StateTracker.instance) {
            StateTracker.instance = new StateTracker<T>();
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
// Export a default instance
export default StateTracker.getInstance<GlobalState>();