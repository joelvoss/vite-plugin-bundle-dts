import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from '@typescript/typescript6';
import { build, type InlineConfig } from 'vite';
import { afterEach, expect } from 'vitest';

import dtsPlugin, { type DtsPluginOptions } from '../src';

export const currentDir = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = resolve(currentDir, 'fixtures');
export const testRequire = createRequire(import.meta.url);
export const rollupIntegrationTimeoutMs = 15000;

interface WatcherEvent {
	code: string;
	error?: unknown;
}

export interface BuildWatcher {
	close(): Promise<void> | void;
	invalidate?(): void;
	on?(event: 'event', listener: (event: WatcherEvent) => void): void;
	off?(event: 'event', listener: (event: WatcherEvent) => void): void;
}

export function setupFixtureCleanup() {
	const tempRoots: string[] = [];
	const watchers: BuildWatcher[] = [];

	afterEach(async () => {
		const closed = await Promise.allSettled(
			watchers.splice(0).map(async (watcher) => watcher.close()),
		);
		const removed = await Promise.allSettled(
			tempRoots
				.splice(0)
				.map((root) => rm(root, { recursive: true, force: true })),
		);
		const errors = [...closed, ...removed].flatMap((result) =>
			result.status === 'rejected' ? [result.reason] : [],
		);
		if (errors.length) {
			throw new AggregateError(
				errors,
				'Failed to clean up integration fixtures.',
			);
		}
	});

	async function createFixtureWorkspace(name: string): Promise<string> {
		const templateRoot = resolve(fixturesDir, name);
		const tempRoot = await mkdtemp(
			resolve(tmpdir(), `vite-plugin-bundle-dts-${name}-`),
		);
		tempRoots.push(tempRoot);
		await cp(templateRoot, tempRoot, { recursive: true });
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

	return { createFixtureWorkspace, runFixtureBuild, tempRoots, watchers };
}

export async function expectFile(path: string): Promise<void> {
	await expect(access(path)).resolves.toBeUndefined();
}

export async function expectNoFile(path: string): Promise<void> {
	await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

export async function expectSourceMapTargets(
	mapPath: string,
	expectedSources: string[],
): Promise<void> {
	const sourceMap = JSON.parse(await readFile(mapPath, 'utf8')) as {
		sources: string[];
		sourceRoot?: string;
	};
	expect(sourceMap.sources).toHaveLength(expectedSources.length);
	for (const [index, source] of sourceMap.sources.entries()) {
		const sourcePath = resolve(
			dirname(mapPath),
			sourceMap.sourceRoot ?? '',
			source,
		);
		expect(sourcePath).toBe(expectedSources[index]);
		await expectFile(sourcePath);
		expect(await readFile(sourcePath, 'utf8')).toBe(
			await readFile(expectedSources[index], 'utf8'),
		);
	}
}

export async function expectConsumerTypecheck(
	root: string,
	content: string,
	nodeMode?: { extension: 'mts' | 'cts'; module: 'NodeNext' | 'Node16' },
): Promise<void> {
	const consumerPath = resolve(root, `consumer.${nodeMode?.extension ?? 'ts'}`);
	await writeFile(consumerPath, content, 'utf8');
	const consumerOptions: ts.CompilerOptions = {
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ESNext,
		strict: true,
		noEmit: true,
		skipLibCheck: false,
		types: [],
		...(nodeMode
			? {
					module: ts.ModuleKind[nodeMode.module],
					moduleResolution: ts.ModuleResolutionKind[nodeMode.module],
				}
			: {}),
	};
	const consumerHost = ts.createCompilerHost(consumerOptions);
	const consumerProgram = ts.createProgram({
		rootNames: [consumerPath],
		options: consumerOptions,
		host: consumerHost,
	});
	expect(
		ts.formatDiagnostics(
			ts.getPreEmitDiagnostics(consumerProgram),
			consumerHost,
		),
	).toBe('');
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

export async function waitForFileContent(
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

export async function waitForWatcherRebuild(
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

			if (event.code === 'END') {
				clearTimeout(timer);
				watcher.off?.('event', onEvent);
				resolvePromise();
			}
		};

		subscribe.call(watcher, 'event', onEvent);
	});
}

export async function buildOutputFixture(
	root: string,
	options: DtsPluginOptions,
): Promise<void> {
	await build({
		configFile: false,
		root,
		logLevel: 'silent',
		build: {
			emptyOutDir: false,
			lib: {
				entry: resolve(root, 'src/index.ts'),
				name: 'StrictOutputFixture',
				fileName: 'index',
			},
		},
		plugins: [dtsPlugin({ declarationOnly: true, ...options })],
	});
}
