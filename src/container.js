/**
 * Lightweight dependency injection container.
 * Supports singleton, transient, and factory registrations with lazy resolution.
 */
class Container {
    constructor() {
        /** @type {Map<string, {type: string, value: any}>} */
        this._registry = new Map();
        /** @type {Map<string, any>} */
        this._singletons = new Map();
    }

    registerValue(name, value) {
        this._registry.set(name, { type: 'value', value });
        return this;
    }

    registerSingleton(name, factory) {
        if (typeof factory !== 'function') {
            throw new TypeError(`[container] Singleton "${name}" requires a factory function`);
        }
        this._registry.set(name, { type: 'singleton', value: factory });
        return this;
    }

    registerTransient(name, factory) {
        if (typeof factory !== 'function') {
            throw new TypeError(`[container] Transient "${name}" requires a factory function`);
        }
        this._registry.set(name, { type: 'transient', value: factory });
        return this;
    }

    resolve(name) {
        const entry = this._registry.get(name);
        if (!entry) {
            throw new Error(`[container] Unknown dependency: "${name}"`);
        }

        if (entry.type === 'value') {
            return entry.value;
        }

        if (entry.type === 'singleton') {
            if (!this._singletons.has(name)) {
                this._singletons.set(name, entry.value(this));
            }
            return this._singletons.get(name);
        }

        return entry.value(this);
    }

    has(name) {
        return this._registry.has(name);
    }

    keys() {
        return Array.from(this._registry.keys());
    }

    dispose() {
        for (const [name, instance] of this._singletons) {
            if (instance && typeof instance.close === 'function') {
                try {
                    instance.close();
                } catch {
                    // Intentionally swallow disposal errors; container is shutting down.
                }
            }
            this._singletons.delete(name);
        }
    }
}

module.exports = { Container };
