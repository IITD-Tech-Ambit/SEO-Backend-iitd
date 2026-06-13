// Chat (RAG) request validation schema.
// The response is a Server-Sent Events stream, so no response schema applies.

export const chatRequestSchema = {
    type: 'object',
    required: ['message'],
    properties: {
        message: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description: 'The user question.'
        },
        history: {
            type: 'array',
            maxItems: 12,
            description: 'Recent conversation turns (oldest first), used for follow-up questions.',
            items: {
                type: 'object',
                required: ['role', 'content'],
                properties: {
                    role: { type: 'string', enum: ['user', 'assistant'] },
                    content: { type: 'string', maxLength: 4000 }
                },
                additionalProperties: false
            }
        }
    },
    additionalProperties: false
};
