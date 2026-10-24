export interface MessageShape {
	value: string;
}

export function createMessage(value: string): MessageShape {
	return { value };
}

export function createMessages(
	values: ReadonlyArray<string>,
): Promise<ReadonlyArray<MessageShape>> {
	return Promise.resolve(values.map(createMessage));
}
