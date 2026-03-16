import { createRequire } from 'node:module';
import { dirname, resolve as nodeResolve } from 'node:path';

import type {
	ExtractorMessage,
	IExtractorInvokeOptions,
} from '@microsoft/api-extractor';

import { normalizePath, resolvePath } from '../utils/common';
import { tryGetPkgPath } from '../utils/path';

////////////////////////////////////////////////////////////////////////////////

const dtsRE = /\.d\.(m|c)?tsx?$/;
const preambleMessageId = 'console-preamble';
const compilerVersionNoticeMessageId = 'console-compiler-version-notice';
const localRequire = createRequire(import.meta.url);

let apiExtractorModulePromise:
	| Promise<typeof import('@microsoft/api-extractor')>
	| undefined;

////////////////////////////////////////////////////////////////////////////////

/**
 * API Extractor resolves TypeScript independently from the rest of the build.
 * Resolve the compiler package from the consuming project root so declaration
 * rollup stays aligned with the host dependency tree.
 */
function getProjectRequires(root: string): NodeJS.Require[] {
	const resolutionRoots = [root, process.cwd()];
	const seenPaths = new Set<string>();
	const requires: NodeJS.Require[] = [];

	for (const resolutionRoot of resolutionRoots) {
		try {
			const packageJsonPath = nodeResolve(resolutionRoot, 'package.json');
			if (seenPaths.has(packageJsonPath)) {
				continue;
			}

			seenPaths.add(packageJsonPath);
			requires.push(createRequire(packageJsonPath));
		} catch {
			continue;
		}
	}

	requires.push(localRequire);

	return requires;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * API Extractor needs to know the path to the TypeScript compiler to roll up
 * declaration files. Resolve the compiler package from the consuming project
 * root to stay aligned with the host dependency tree and avoid conflicts with
 * API Extractor's own nested version.
 */
export function getTsLibFolder(root: string): string | undefined {
	for (const require of getProjectRequires(root)) {
		try {
			return normalizePath(dirname(require.resolve('typescript/package.json')));
		} catch {
			continue;
		}
	}

	return undefined;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * API Extractor imports its own nested `typescript` package at module load
 * time. Because npm overrides only apply in the consuming application's root
 * manifest, published plugins cannot rely on them. Patch API Extractor's local
 * module cache entry before importing it so its compiler binding uses the host
 * TypeScript instance automatically.
 */
function enforceHostTypeScript(root: string): void {
	let hostTypeScriptModule: NodeJS.Module | undefined;

	for (const require of getProjectRequires(root)) {
		try {
			const hostTypeScriptEntry = require.resolve('typescript');
			require(hostTypeScriptEntry);
			hostTypeScriptModule = require.cache[hostTypeScriptEntry];
			if (hostTypeScriptModule) {
				break;
			}
		} catch {
			continue;
		}
	}

	if (!hostTypeScriptModule) {
		return;
	}

	const apiExtractorPackagePath = localRequire.resolve(
		'@microsoft/api-extractor/package.json',
	);
	const apiExtractorRequire = createRequire(apiExtractorPackagePath);
	const apiExtractorTypeScriptEntry = apiExtractorRequire.resolve('typescript');

	apiExtractorRequire.cache[apiExtractorTypeScriptEntry] = hostTypeScriptModule;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * Load API Extractor lazyly so we can patch its TypeScript dependency before
 * it initializes. This also avoids loading the package at all if declaration
 * rollup is not needed, which can save time and memory in some cases since API
 * Extractor is a large dependency with many nested dependencies of its own.
 */
async function loadApiExtractor(
	root: string,
): Promise<typeof import('@microsoft/api-extractor')> {
	if (!apiExtractorModulePromise) {
		enforceHostTypeScript(root);
		apiExtractorModulePromise = import('@microsoft/api-extractor');
	}

	return apiExtractorModulePromise;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * Roll up declaration files using API Extractor's dtsRollup feature. This is
 * added as a separate step after emit to take advantage of the plugin's import
 * rewriting and avoid conflicts with TS's own declaration bundling, which is
 * less flexible and can only be applied to whole projects. API Extractor also
 * performs better with large projects and produces more consistent output than
 * the built-in bundler, which can be buggy and sensitive to file layout.
 */
export async function rollupDeclarationFiles({
	root,
	configPath,
	compilerOptions,
	outDir,
	entryPath,
	fileName,
	libFolder,
	rollupConfig = {},
	rollupOptions = {},
}: {
	root: string;
	configPath: string | undefined;
	compilerOptions: Record<string, unknown>;
	outDir: string;
	entryPath: string;
	fileName: string;
	libFolder?: string;
	rollupConfig?: Record<string, unknown>;
	rollupOptions?: Record<string, unknown>;
}): Promise<unknown> {
	const { Extractor, ExtractorConfig, ExtractorLogLevel } =
		await loadApiExtractor(root);
	const configObjectFullPath = resolvePath(root, 'api-extractor.json');
	const normalizedFileName = dtsRE.test(fileName)
		? fileName
		: `${fileName}.d.ts`;
	const invokeOptions = rollupOptions as IExtractorInvokeOptions | undefined;
	const userMessageCallback = invokeOptions?.messageCallback;
	const extractorConfig = ExtractorConfig.prepare({
		configObject: {
			...rollupConfig,
			projectFolder: root,
			mainEntryPointFilePath: entryPath,
			compiler: {
				tsconfigFilePath: configPath,
				overrideTsconfig: {
					$schema: 'http://json.schemastore.org/tsconfig',
					compilerOptions,
				},
			},
			apiReport: {
				enabled: false,
				reportFileName: '<unscopedPackageName>.api.md',
				...(rollupConfig.apiReport as Record<string, unknown> | undefined),
			},
			docModel: {
				enabled: false,
				...(rollupConfig.docModel as Record<string, unknown> | undefined),
			},
			dtsRollup: {
				enabled: true,
				publicTrimmedFilePath: resolvePath(outDir, normalizedFileName),
			},
			tsdocMetadata: {
				enabled: false,
				...(rollupConfig.tsdocMetadata as Record<string, unknown> | undefined),
			},
			messages: {
				compilerMessageReporting: {
					default: {
						logLevel: ExtractorLogLevel.Warning,
					},
				},
				extractorMessageReporting: {
					default: {
						logLevel: ExtractorLogLevel.Warning,
					},
				},
				...(rollupConfig.messages as Record<string, unknown> | undefined),
			},
		},
		configObjectFullPath,
		packageJsonFullPath: tryGetPkgPath(configObjectFullPath),
	});

	return Extractor.invoke(extractorConfig, {
		...invokeOptions,
		localBuild: false,
		showVerboseMessages: false,
		showDiagnostics: false,
		typescriptCompilerFolder: libFolder,
		messageCallback(message: ExtractorMessage) {
			if (
				message.messageId === preambleMessageId ||
				message.messageId === compilerVersionNoticeMessageId
			) {
				message.handled = true;
			}

			userMessageCallback?.(message);
		},
	});
}
