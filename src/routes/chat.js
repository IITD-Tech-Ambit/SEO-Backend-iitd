import { chatRequestSchema } from '../schemas/chat.js';
import { chat } from '../controllers/chatController.js';

/**
 * Chat Routes
 * POST /chat - RAG chatbot: hybrid retrieval + streamed LLM answer (SSE)
 */
export default async function chatRoutes(fastify, options) {
    fastify.post('/chat', {
        schema: {
            description: 'RAG chatbot over indexed research papers. Responds with a Server-Sent Events stream (events: sources, token, done, error).',
            tags: ['chat'],
            body: chatRequestSchema
        },
        handler: chat
    });
}
