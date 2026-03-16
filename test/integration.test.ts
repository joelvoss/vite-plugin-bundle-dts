import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, type InlineConfig } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

import dtsPlugin from '../src';

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(currentDir, 'fixtures');
const tempRoots: string[] = [];
const watchers: Array<{ close(): Promise<void> | void }> = [];

interface WatcherEvent {
	code: string;
	error?: unknown;
}

interface BuildWatcher {
	close(): Promise<void> | void;
	invalidate?(): void;
	on?(event: 'event', listener: (event: WatcherEvent) => void): void;
	off?(event: 'event', listener: (event: WatcherEvent) => void): void;
}

async function createFixtureWorkspace(name: string): Promise<string> {
	const templateRoot = resolve(fixturesDir, name);
	const tempRoot = await mkdtemp(
		resolve(tmpdir(), `vite-plugin-bundle-dts-${name}-`),
	);
	await cp(templateRoot, tempRoot, { recursive: true });
	tempRoots.push(tempRoot);
	return tempRoot;
}

async function runFixtureBuild(
	name: string,
	configFactory: (root: string) => InlineConfig,
): Promise<string> {
	const root = await createFixtureWorkspace(name);
	const config = configFactory(root);
	await build({
		configFile: false,
		root,
		logLevel: 'silent',
		...config,
	});
	return root;
}

async function expectFile(path: string): Promise<void> {
	await expect(access(path)).resolves.toBeUndefined();
}

async function expectNoFile(path: string): Promise<void> {
	await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

async function waitFor(
	predicate: () => Promise<boolean>,
	timeoutMs = 10000,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeoutMs) {
		if (await predicate()) {
			return;
		}
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
	}
	throw new Error(
		`Timed out after ${timeoutMs}ms while waiting for condition.`,
	);
}

async function waitForFileContent(
	path: string,
	expectedText: string,
	timeoutMs = 10000,
): Promise<string> {
	let lastContent = '';
	await waitFor(async () => {
		try {
			lastContent = await readFile(path, 'utf8');
			return lastContent.includes(expectedText);
		} catch {
			return false;
		}
	}, timeoutMs);
	return lastContent;
}

async function waitForWatcherRebuild(
	watcher: BuildWatcher,
	timeoutMs = 15000,
): Promise<void> {
	const subscribe = watcher.on;
	if (!subscribe) {
		return;
	}

	await new Promise<void>((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			watcher.off?.('event', onEvent);
			rejectPromise(
				new Error(
					`Timed out after ${timeoutMs}ms while waiting for watcher rebuild.`,
				),
			);
		}, timeoutMs);

		const onEvent = (event: WatcherEvent): void => {
			if (event.code === 'ERROR') {
				clearTimeout(timer);
				watcher.off?.('event', onEvent);
				rejectPromise(
					event.error instanceof Error
						? event.error
						: new Error(String(event.error)),
				);
				return;
			}

			if (event.code === 'BUNDLE_END' || event.code === 'END') {
				clearTimeout(timer);
				watcher.off?.('event', onEvent);
				resolvePromise();
			}
		};

		subscribe.call(watcher, 'event', onEvent);
	});
}

afterEach(async () => {
	await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
	await Promise.all(
		tempRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe('fixture integration', () => {
	it('builds a single-entry library with alias rewriting and json declarations', async () => {
		const root = await runFixtureBuild('single-entry-json', (fixtureRoot) => ({
			resolve: {
				alias: {
					'@': resolve(fixtureRoot, 'src'),
				},
			},
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'SingleEntryJson',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					insertTypesEntry: true,
					declarationOnly: true,
				}),
			],
		}));

		const distIndex = resolve(root, 'dist/index.d.ts');
		const distJson = resolve(root, 'dist/data.json.d.ts');

		await expectFile(distIndex);
		await expectFile(distJson);

		const indexContent = await readFile(distIndex, 'utf8');
		const jsonContent = await readFile(distJson, 'utf8');

		expect(indexContent).toContain("export type { Example } from './types';");
		expect(indexContent).toContain(
			"export { default as data } from './data.json';",
		);
		expect(jsonContent).toContain('declare const _default:');
		expect(jsonContent).toContain('"label": "fixture"');
	});

	it('builds a multi-entry library and emits declarations for each entry', async () => {
		const root = await runFixtureBuild('multi-entry', (fixtureRoot) => ({
			build: {
				lib: {
					entry: {
						index: resolve(fixtureRoot, 'src/index.ts'),
						extra: resolve(fixtureRoot, 'src/extra.ts'),
					},
					name: 'MultiEntryFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
				}),
			],
		}));

		const indexDts = resolve(root, 'dist/index.d.ts');
		const extraDts = resolve(root, 'dist/extra.d.ts');

		await expectFile(indexDts);
		await expectFile(extraDts);

		const indexContent = await readFile(indexDts, 'utf8');
		const extraContent = await readFile(extraDts, 'utf8');

		expect(indexContent).toContain("export { extraValue } from './extra';");
		expect(extraContent).toContain('export declare const extraValue = 42;');
	});

	it('rolls up declaration output and removes intermediate declaration files', async () => {
		const root = await runFixtureBuild('rollup-types', (fixtureRoot) => ({
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'RollupTypesFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					rollupTypes: true,
				}),
			],
		}));

		const bundledDts = resolve(root, 'dist/index.d.ts');
		const helperDts = resolve(root, 'dist/helper.d.ts');

		await expectFile(bundledDts);
		await expectNoFile(helperDts);

		const bundledContent = await readFile(bundledDts, 'utf8');
		expect(bundledContent).toContain('export declare function createMessage');
		expect(bundledContent).toContain('export declare interface MessageShape');
	});

	it('writes a custom package types shim when insertTypesEntry is enabled', async () => {
		const root = await runFixtureBuild('insert-types-entry', (fixtureRoot) => ({
			build: {
				lib: {
					entry: resolve(fixtureRoot, 'src/index.ts'),
					name: 'InsertTypesFixture',
					fileName: 'main',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					insertTypesEntry: true,
				}),
			],
		}));

		const entryDts = resolve(root, 'dist/index.d.ts');
		const shimDts = resolve(root, 'dist/types/entry.d.ts');

		await expectFile(entryDts);
		await expectFile(shimDts);

		const shimContent = await readFile(shimDts, 'utf8');
		expect(shimContent).toContain("export * from '../index'");
		expect(shimContent).toContain('export default InsertTypesFixture');
	});

	it('rolls up declarations for multiple entries and cleans shared intermediates', async () => {
		const root = await runFixtureBuild('multi-entry-rollup', (fixtureRoot) => ({
			build: {
				lib: {
					entry: {
						index: resolve(fixtureRoot, 'src/index.ts'),
						extra: resolve(fixtureRoot, 'src/extra.ts'),
					},
					name: 'MultiEntryRollupFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
					rollupTypes: true,
				}),
			],
		}));

		const indexDts = resolve(root, 'dist/index.d.ts');
		const extraDts = resolve(root, 'dist/extra.d.ts');
		const sharedDts = resolve(root, 'dist/shared.d.ts');

		await expectFile(indexDts);
		await expectFile(extraDts);
		await expectNoFile(sharedDts);

		const indexContent = await readFile(indexDts, 'utf8');
		const extraContent = await readFile(extraDts, 'utf8');

		expect(indexContent).toContain('export declare const primaryLabel');
		expect(indexContent).toContain('SharedShape');
		expect(extraContent).toContain('export declare function buildExtra');
		expect(extraContent).toContain('SharedShape');
	});

	it('rebuilds declaration output in watch mode after source changes', async () => {
		const root = await createFixtureWorkspace('watch-basic');
		const watcher = (await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				watch: {},
				lib: {
					entry: resolve(root, 'src/index.ts'),
					name: 'WatchFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
				}),
			],
		})) as BuildWatcher;
		watchers.push(watcher);

		const dtsPath = resolve(root, 'dist/index.d.ts');
		const initialContent = await waitForFileContent(dtsPath, 'message', 15000);
		expect(initialContent).toContain('"one"');

		await writeFile(
			resolve(root, 'src/index.ts'),
			[
				'export const message = "two";',
				'export interface WatchState {',
				'  ready: true;',
				'}',
			].join('\n'),
			'utf8',
		);

		watcher.invalidate?.();
		await waitForWatcherRebuild(watcher);
		const rebuiltContent = await waitForFileContent(dtsPath, '"two"', 15000);
		expect(rebuiltContent).toContain('export interface WatchState');
	}, 20000);

	it('rebuilds resolver-backed json declarations in watch mode after data changes', async () => {
		const root = await createFixtureWorkspace('watch-json');
		const watcher = (await build({
			configFile: false,
			root,
			logLevel: 'silent',
			build: {
				watch: {},
				lib: {
					entry: resolve(root, 'src/index.ts'),
					name: 'WatchJsonFixture',
					fileName: 'index',
				},
			},
			plugins: [
				dtsPlugin({
					declarationOnly: true,
				}),
			],
		})) as BuildWatcher;
		watchers.push(watcher);

		const jsonDtsPath = resolve(root, 'dist/data.json.d.ts');
		const initialJsonContent = await waitForFileContent(
			jsonDtsPath,
			'"label": "before"',
			15000,
		);
		expect(initialJsonContent).toContain('"count": 1');

		await writeFile(
			resolve(root, 'src/data.json'),
			JSON.stringify({ label: 'after', count: 2 }, null, 2),
			'utf8',
		);

		watcher.invalidate?.();
		await waitForWatcherRebuild(watcher);
		const rebuiltJsonContent = await waitForFileContent(
			jsonDtsPath,
			'"label": "after"',
			15000,
		);
		expect(rebuiltJsonContent).toContain('"count": 2');
	}, 20000);
});
