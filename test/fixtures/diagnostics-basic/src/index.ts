export interface Shape {
	label: string;
}

// Intentional type error so the plugin's diagnostics hook has something to
// report during the build.
export const value: Shape = {
	label: 'ok',
	extra: true,
};
