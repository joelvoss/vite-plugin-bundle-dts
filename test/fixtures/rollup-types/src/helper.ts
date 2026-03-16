export interface MessageShape {
	value: string;
}

export function createMessage(value: string): MessageShape {
	return { value };
}
