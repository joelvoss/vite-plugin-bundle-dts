import type ts from 'typescript';

export type MaybePromise<T> = T | Promise<T>;

export interface PathAlias {
	find: string | RegExp;
	replacement: string;
}

export interface DtsOutputFile {
	path: string;
	content: string;
}

export interface DtsResolverContext {
	id: string;
	code: string;
	root: string;
	outDir: string;
	host: ts.CompilerHost;
	program: ts.Program;
}

export interface DtsResolverResult {
	outputs: DtsOutputFile[];
	emitSkipped?: boolean;
	diagnostics?: readonly ts.Diagnostic[];
}

export interface DtsResolver {
	name?: string;
	supports(id: string): boolean;
	transform(
		context: DtsResolverContext,
	): MaybePromise<DtsOutputFile[] | DtsResolverResult>;
}

export interface BeforeWriteFileResult {
	filePath?: string;
	content?: string;
}

export interface BundleDtsOptions {
	root?: string;
	entryRoot?: string;
	outDir?: string | string[];
	tsconfigPath?: string;
	logLevel?: 'silent' | 'error' | 'warn' | 'info';
	staticImport?: boolean;
	clearPureImport?: boolean;
	insertTypesEntry?: boolean;
	rollupTypes?: boolean;
	pathsToAliases?: boolean;
	aliasesExclude?: Array<string | RegExp>;
	rollupConfig?: Record<string, unknown>;
	rollupOptions?: Record<string, unknown>;
	bundledPackages?: string[];
	resolvers?: DtsResolver[];
	copyDtsFiles?: boolean;
	declarationOnly?: boolean;
	strictOutput?: boolean;
	include?: string | string[];
	exclude?: string | string[];
	compilerOptions?: ts.CompilerOptions;
	afterDiagnostic?: (
		diagnostics: readonly ts.Diagnostic[],
	) => MaybePromise<void>;
	beforeWriteFile?: (
		filePath: string,
		content: string,
	) => MaybePromise<void | false | BeforeWriteFileResult>;
	afterRollup?: (result: unknown) => MaybePromise<void>;
	afterBuild?: (
		emittedFiles: ReadonlyMap<string, string>,
	) => MaybePromise<void>;
}

export interface TransformDeclarationOptions {
	filePath: string;
	content: string;
	aliases?: PathAlias[];
	aliasesExclude: Array<string | RegExp>;
	staticImport: boolean;
	clearPureImport: boolean;
}

export interface TransformDeclarationResult {
	content: string;
	declareModules: string[];
	diffLineCount: number | null;
}
