export { bundleDts as default, bundleDts } from './core/plugin.ts';
export { editSourceMapDir } from './utils/source-map.ts';
export type {
	BeforeWriteFileResult,
	DtsOutputFile,
	BundleDtsOptions as DtsPluginOptions,
	DtsResolver,
	DtsResolverContext,
	DtsResolverResult,
	MaybePromise,
	PathAlias,
} from './types.ts';
