export const ipSuggestRequestSchema = {
    type: 'object',
    required: ['q'],
    properties: {
        q: {
            type: 'string',
            maxLength: 200,
            description: 'Prefix being typed. Shorter than ~2 chars returns empty groups.'
        },
        limit: {
            type: 'integer',
            minimum: 1,
            maximum: 15,
            default: 8,
            description: 'Max suggestions per group.'
        }
    },
    additionalProperties: false
};

export const ipSuggestResponseSchema = {
    type: 'object',
    properties: {
        intent: {
            type: 'string',
            enum: ['inventor', 'document', 'mixed'],
            description: 'Predicted intent. Controls group ordering + header hint only; both groups always returned.'
        },
        confidence: {
            type: 'number',
            description: 'Confidence (0-1) in the predicted intent.'
        },
        groups: {
            type: 'object',
            properties: {
                inventors: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            name: { type: 'string' },
                            is_faculty: { type: 'boolean' },
                            kerberos: { type: 'string' },
                            score: { type: 'number' }
                        }
                    }
                },
                documents: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            id: { type: 'string' },
                            title: { type: 'string' },
                            year: { type: 'integer' },
                            type_of_ip: { type: 'string' },
                            lead_inventor: { type: 'string' },
                            score: { type: 'number' }
                        }
                    }
                }
            }
        },
        meta: {
            type: 'object',
            properties: {
                took_ms: { type: 'number' },
                cache_hit: { type: 'boolean' }
            }
        }
    }
};
