import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import type {
	ExtractorMessage,
	IExtractorInvokeOptions,
} from '@microsoft/api-extractor';

import { normalizePath, resolvePath } from '../utils/common.ts';
import { tryGetPkgPath } from '../utils/path.ts';

////////////////////////////////////////////////////////////////////////////////

const dtsRE = /\.d\.(m|c)?tsx?$/;
const preambleMessageId = 'console-preamble';
const compilerVersionNoticeMessageId = 'console-compiler-version-notice';
const localRequire = createRequire(import.meta.url);
const compatibilityPackagePath = localRequire.resolve(
	'@typescript/typescript6/package.json',
);
const compatibilityRequire = createRequire(compatibilityPackagePath);

let apiExtractorModulePromise:
	| Promise<typeof import('@microsoft/api-extractor')>
	| undefined;

////////////////////////////////////////////////////////////////////////////////

/**
 * TypeScript 7 no longer exposes the legacy compiler API required by this
 * plugin and API Extractor. Use the TypeScript 6 compatibility package's
 * compiler library and its matching standard library declarations.
 */
export function getTsLibFolder(): string {
	const compilerPackagePath = compatibilityRequire.resolve(
		'@typescript/old/package.json',
	);
	return normalizePath(dirname(compilerPackagePath));
}

////////////////////////////////////////////////////////////////////////////////

/**
 * API Extractor imports its own nested `typescript` package at module load
 * time. Patch that cache entry before importing API Extractor so its compiler
 * binding uses the same compatibility API as this plugin.
 */
function enforceCompatibilityTypeScript(): void {
	const compilerEntry = compatibilityRequire.resolve('@typescript/old');
	compatibilityRequire(compilerEntry);
	const compilerModule = compatibilityRequire.cache[compilerEntry];
	if (!compilerModule) return;

	const apiExtractorPackagePath = localRequire.resolve(
		'@microsoft/api-extractor/package.json',
	);
	const apiExtractorRequire = createRequire(apiExtractorPackagePath);
	const apiExtractorTypeScriptEntry = apiExtractorRequire.resolve('typescript');

	apiExtractorRequire.cache[apiExtractorTypeScriptEntry] = compilerModule;
}

////////////////////////////////////////////////////////////////////////////////

/**
 * Load API Extractor lazyly so we can patch its TypeScript dependency before
 * it initializes. This also avoids loading the package at all if declaration
 * rollup is not needed, which can save time and memory in some cases since API
 * Extractor is a large dependency with many nested dependencies of its own.
 */
async function loadApiExtractor(): Promise<
	typeof import('@microsoft/api-extractor')
> {
	if (!apiExtractorModulePromise) {
		enforceCompatibilityTypeScript();
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
		await loadApiExtractor();
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
						logLevel: ExtractorLogLevel.None,
					},
				},
				extractorMessageReporting: {
					default: {
						logLevel: ExtractorLogLevel.None,
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
