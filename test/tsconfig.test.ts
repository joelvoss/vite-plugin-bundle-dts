import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import {
	getTsConfig,
	loadTsConfig,
	resolveConfigDir,
	setModuleResolution,
} from '../src/utils/tsconfig';

const tempRoots: string[] = [];

async function createTempRoot(): Promise<string> {
	const root = await mkdtemp(
		resolve(tmpdir(), 'vite-plugin-bundle-dts-tsconfig-'),
	);
	tempRoots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(
		tempRoots
			.splice(0)
			.map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe('tsconfig utils', () => {
	it('replaces configDir placeholders', () => {
		expect(resolveConfigDir('${configDir}/dist', '/repo')).toBe('/repo/dist');
	});

	it('loads tsconfig contents', async () => {
		const root = await createTempRoot();
		const configPath = resolve(root, 'tsconfig.json');
		await mkdir(resolve(root, 'src'), { recursive: true });
		await writeFile(
			resolve(root, 'src/index.ts'),
			'export const value = 1;',
			'utf8',
		);
		await writeFile(
			configPath,
			JSON.stringify({
				compilerOptions: {
					target: 'ES2022',
					module: 'ESNext',
				},
				include: ['src/**/*.ts'],
			}),
			'utf8',
		);

		const loaded = loadTsConfig(configPath);
		expect(loaded.raw.include).toEqual(['src/**/*.ts']);
		expect(loaded.options.module).toBe(ts.ModuleKind.ESNext);
		expect(loaded.errors).toEqual([]);
	});

	it('merges extended tsconfig compiler options', async () => {
		const root = await createTempRoot();
		const baseConfigPath = resolve(root, 'tsconfig.base.json');
		const configPath = resolve(root, 'tsconfig.json');

		await writeFile(
			baseConfigPath,
			JSON.stringify({
				compilerOptions: {
					strict: true,
					module: 'ESNext',
				},
				include: ['src/**/*.ts'],
			}),
			'utf8',
		);

		await writeFile(
			configPath,
			JSON.stringify({
				extends: './tsconfig.base.json',
				compilerOptions: {
					declaration: true,
				},
			}),
			'utf8',
		);

		const loaded = getTsConfig(configPath, ts.sys.readFile);
		expect(loaded.compilerOptions.strict).toBe(true);
		expect(loaded.compilerOptions.declaration).toBe(true);
		expect(loaded.include).toEqual(['src/**/*.ts']);
	});

	it('assigns module resolution defaults based on module kind', () => {
		const commonJsOptions: ts.CompilerOptions = {
			module: ts.ModuleKind.CommonJS,
		};
		setModuleResolution(commonJsOptions);
		expect(commonJsOptions.moduleResolution).toBe(
			ts.ModuleResolutionKind.Node10,
		);

		const bundlerOptions: ts.CompilerOptions = { module: ts.ModuleKind.ESNext };
		setModuleResolution(bundlerOptions);
		expect(bundlerOptions.moduleResolution).toBe(
			ts.ModuleResolutionKind.Bundler,
		);

		const existing: ts.CompilerOptions = {
			moduleResolution: ts.ModuleResolutionKind.Node16,
		};
		setModuleResolution(existing);
		expect(existing.moduleResolution).toBe(ts.ModuleResolutionKind.Node16);
	});
});
