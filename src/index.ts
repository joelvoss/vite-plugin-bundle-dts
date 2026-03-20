export { bundleDts as default, bundleDts } from './core/plugin';
export { editSourceMapDir } from './utils/source-map';
export type {
	BeforeWriteFileResult,
	DtsOutputFile,
	BundleDtsOptions as DtsPluginOptions,
	DtsResolver,
	DtsResolverContext,
	DtsResolverResult,
	MaybePromise,
	PathAlias,
} from './types';
