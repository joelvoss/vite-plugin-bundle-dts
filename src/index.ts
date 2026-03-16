export { dtsPlugin as default, dtsPlugin } from './core/plugin';
export { editSourceMapDir } from './utils/source-map';
export type {
	BeforeWriteFileResult,
	DtsOutputFile,
	DtsPluginOptions,
	DtsResolver,
	DtsResolverContext,
	DtsResolverResult,
	MaybePromise,
	PathAlias,
} from './types';
