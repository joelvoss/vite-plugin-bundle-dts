import { isAbsolute, posix, resolve as nodeResolve } from 'node:path';

const windowsSlashRE = /\\+/g;

export function slash(value: string): string {
	return value.replace(windowsSlashRE, '/');
}

export function normalizePath(id: string): string {
	return posix.normalize(slash(id));
}

export function resolvePath(...paths: string[]): string {
	return normalizePath(nodeResolve(...paths));
}

export function ensureAbsolute(path: string | undefined, root: string): string {
	return normalizePath(
		path ? (isAbsolute(path) ? path : nodeResolve(root, path)) : root,
	);
}

export function ensureArray<T>(value: T | T[] | null | undefined): T[] {
	return Array.isArray(value) ? value : value ? [value] : [];
}

export function isNativeObject(
	value: unknown,
): value is Record<string, unknown> {
	return Object.prototype.toString.call(value) === '[object Object]';
}

export function isRegExp(value: unknown): value is RegExp {
	return Object.prototype.toString.call(value) === '[object RegExp]';
}

export function isPromise<T>(
	value: MaybePromise<T> | unknown,
): value is Promise<T> {
	return (
		!!value &&
		(typeof value === 'function' || typeof value === 'object') &&
		'then' in value
	);
}

export async function unwrapPromise<T>(value: MaybePromise<T>): Promise<T> {
	return isPromise(value) ? await value : value;
}

export async function runParallel<T>(
	maxConcurrency: number,
	source: T[],
	iteratorFn: (item: T, source: T[]) => Promise<void>,
): Promise<void> {
	const running = new Set<Promise<void>>();
	for (const item of source) {
		const task = Promise.resolve().then(() => iteratorFn(item, source));
		running.add(task);
		task.finally(() => {
			running.delete(task);
		});

		if (maxConcurrency > 0 && running.size >= maxConcurrency) {
			await Promise.race(running);
		}
	}
	await Promise.all(Array.from(running));
}

type MaybePromise<T> = T | Promise<T>;
