import { logger } from "../logger";

/**
 * Generic TTL-based caching service.
 * Provides in-memory caching with configurable expiry times.
 */
export class CacheService<T> {
	private cache: Map<string, T> = new Map();
	private expiry: number = 0;
	private readonly ttl: number;
	private readonly name: string;

	constructor(name: string, ttlMs: number) {
		this.name = name;
		this.ttl = ttlMs;
	}

	/**
	 * Check if cache is valid (not expired)
	 */
	isValid(): boolean {
		return this.cache.size > 0 && Date.now() < this.expiry;
	}

	/**
	 * Get cached value by key
	 */
	get(key: string): T | undefined {
		if (!this.isValid()) {
			return undefined;
		}
		return this.cache.get(key);
	}

	/**
	 * Get all cached entries
	 */
	getAll(): Map<string, T> {
		if (!this.isValid()) {
			return new Map();
		}
		return new Map(this.cache);
	}

	/**
	 * Set a single cache entry
	 */
	set(key: string, value: T): void {
		this.cache.set(key, value);
		if (this.cache.size === 1) {
			// First entry, set expiry
			this.expiry = Date.now() + this.ttl;
		}
	}

	/**
	 * Set multiple cache entries at once
	 */
	setAll(entries: Map<string, T>): void {
		this.cache.clear();
		for (const [key, value] of entries) {
			this.cache.set(key, value);
		}
		this.expiry = Date.now() + this.ttl;
		logger.log(`[Cache Service - ${this.name}] Cached ${this.cache.size} entries, expires in ${this.ttl}ms`);
	}

	/**
	 * Clear all cached entries
	 */
	clear(): void {
		this.cache.clear();
		this.expiry = 0;
		logger.log(`[Cache Service - ${this.name}] Cache cleared`);
	}

	/**
	 * Get cache size
	 */
	size(): number {
		return this.isValid() ? this.cache.size : 0;
	}
}
