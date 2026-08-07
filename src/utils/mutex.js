// Simple async mutex for serializing access to shared resources
// Used for browser lifecycle operations to prevent race conditions

export class Mutex {
    #locked = false;
    #waiters = [];

    async lock() {
        if (!this.#locked) {
            this.#locked = true;
            return;
        }
        return new Promise(resolve => this.#waiters.push(resolve));
    }

    unlock() {
        if (this.#waiters.length > 0) {
            const next = this.#waiters.shift();
            next();
        } else {
            this.#locked = false;
        }
    }

    async runExclusive(fn) {
        await this.lock();
        try {
            return await fn();
        } finally {
            this.unlock();
        }
    }

    get isLocked() {
        return this.#locked;
    }
}

// Global mutex instances
export const browserLifecycleMutex = new Mutex();
export const browserPageMutex = new Mutex();