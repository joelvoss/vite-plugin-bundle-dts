import { dirname } from 'node:path';

import ts from 'typescript';

import { ensureAbsolute } from './common';

export interface LoadedTsConfig {
	fileNames: string[];
	options: ts.CompilerOptions;
	raw: Record<string, any>;
	projectReferences?: readonly ts.ProjectReference[];
	errors: readonly ts.Diagnostic[];
}

export function resolveConfigDir(path: string, configDir: string): string {
	return path.replace('${configDir}', configDir);
}

export function loadTsConfig(tsConfigPath: string): LoadedTsConfig {
	const readResult = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
	const raw = readResult.config ?? {};
	const parsed = ts.parseJsonConfigFileContent(
		raw,
		ts.sys,
		dirname(tsConfigPath),
		undefined,
		tsConfigPath,
	);
	return {
		fileNames: parsed.fileNames,
		options: parsed.options,
		raw,
		projectReferences: parsed.projectReferences,
		errors: parsed.errors,
	};
}

export function getTsConfig(
	tsConfigPath: string,
	readFileSync: (path: string) => string | undefined,
): Record<string, any> {
	const baseConfig = ts.readConfigFile(tsConfigPath, readFileSync).config ?? {};
	const tsConfig = {
		...baseConfig,
		compilerOptions: {},
	} as Record<string, any>;

	if (tsConfig.extends) {
		for (const configPath of Array.isArray(tsConfig.extends)
			? tsConfig.extends
			: [tsConfig.extends]) {
			const config = getTsConfig(
				ensureAbsolute(configPath, dirname(tsConfigPath)),
				readFileSync,
			);
			Object.assign(tsConfig.compilerOptions, config.compilerOptions);
			if (!tsConfig.include) {
				tsConfig.include = config.include;
			}
			if (!tsConfig.exclude) {
				tsConfig.exclude = config.exclude;
			}
		}
	}

	Object.assign(tsConfig.compilerOptions, baseConfig.compilerOptions);
	return tsConfig;
}

export function setModuleResolution(options: ts.CompilerOptions): void {
	if (options.moduleResolution) {
		return;
	}

	const moduleKind =
		typeof options.module === 'number'
			? options.module
			: options.target && options.target >= ts.ScriptTarget.ES2015
				? ts.ModuleKind.ES2015
				: ts.ModuleKind.CommonJS;

	switch (moduleKind) {
		case ts.ModuleKind.CommonJS:
			options.moduleResolution = ts.ModuleResolutionKind.Node10;
			break;
		case ts.ModuleKind.Node16:
			options.moduleResolution = ts.ModuleResolutionKind.Node16;
			break;
		case ts.ModuleKind.NodeNext:
			options.moduleResolution = ts.ModuleResolutionKind.NodeNext;
			break;
		default:
			options.moduleResolution = ts.ModuleResolutionKind.Bundler;
			break;
	}
}
