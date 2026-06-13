/**
 * Chat Controller
 * Agentic RAG chatbot endpoint: the LLM picks tools (paper search, faculty
 * lookup, topic-to-faculty matching, publication statistics), we execute them
 * against OpenSearch/MongoDB, and the grounded answer streams back via SSE.
 *
 * SSE events emitted:
 *   - status:  { text } progress while a tool runs ("Computing statistics...")
 *   - sources: JSON array of papers used as context (when paper search ran)
 *   - token:   { text } incremental answer chunk
 *   - done:    { took_ms }
 *   - error:   { message }
 */

const MAX_TOOL_ROUNDS = 2;

function sseWrite(raw, event, data) {
    raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Sliding-window rate limit backed by Redis. Fails open if Redis is down.
 * Returns true when the request is allowed.
 */
async function checkRateLimit(fastify, ip, { windowSec, maxRequests }) {
    try {
        const key = `chat:rl:${ip}`;
        const count = await fastify.redis.incr(key);
        if (count === 1) {
            await fastify.redis.expire(key, windowSec);
        }
        return count <= maxRequests;
    } catch (err) {
        fastify.log.warn({ err }, 'Chat rate-limit check failed (allowing request)');
        return true;
    }
}

export async function chat(request, reply) {
    const startTime = Date.now();
    const fastify = request.server;
    const { llmService, chatToolsService } = fastify;
    const chatConfig = fastify.chatConfig;

    const { message, history = [] } = request.body;

    if (!llmService.isConfigured) {
        return reply.status(503).send({
            error: 'Service Unavailable',
            message: 'Chat service is not configured (missing GROQ_API_KEY)',
            statusCode: 503
        });
    }

    const allowed = await checkRateLimit(fastify, request.ip, chatConfig.rateLimit);
    if (!allowed) {
        return reply.status(429).send({
            error: 'Too Many Requests',
            message: 'Chat rate limit exceeded, please slow down',
            statusCode: 429
        });
    }

    // Keep only the most recent turns to bound prompt size
    const trimmedHistory = history.slice(-chatConfig.maxHistoryTurns);

    // Take over the raw socket for SSE streaming. The CORS plugin does not run
    // on hijacked replies, so reflect the origin manually.
    reply.hijack();
    reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': request.headers.origin || '*'
    });
    if (reply.raw.flushHeaders) reply.raw.flushHeaders();

    let clientGone = false;
    request.raw.on('close', () => { clientGone = true; });

    try {
        const messages = llmService.buildMessages({ message, history: trimmedHistory });
        let paperSources = null;
        let directAnswer = null;

        // Agentic loop: let the model request tools, execute them, feed results back
        for (let round = 0; round < MAX_TOOL_ROUNDS && !clientGone; round++) {
            const assistantMsg = await llmService.chatCompletion(messages, {
                tools: chatToolsService.definitions
            });

            if (!assistantMsg.tool_calls?.length) {
                // Model answered without (further) tools; reuse its content
                directAnswer = assistantMsg.content || '';
                break;
            }

            messages.push(assistantMsg);

            for (const toolCall of assistantMsg.tool_calls) {
                const toolName = toolCall.function?.name;
                let args = {};
                try {
                    args = JSON.parse(toolCall.function?.arguments || '{}');
                } catch {
                    // Leave args empty on malformed JSON
                }

                if (!clientGone) {
                    sseWrite(reply.raw, 'status', { text: chatToolsService.statusFor(toolName) });
                }
                request.log.info({ toolName, args }, 'Chat tool call');

                let toolOutput;
                try {
                    const { result, sources } = await chatToolsService.execute(toolName, args);
                    toolOutput = result;
                    if (sources?.length) paperSources = sources;
                } catch (toolErr) {
                    request.log.error({ err: toolErr, toolName, args }, 'Chat tool execution failed');
                    toolOutput = { error: 'The lookup failed unexpectedly. Answer with what you have or tell the user to try again.' };
                }

                messages.push({
                    role: 'tool',
                    tool_call_id: toolCall.id,
                    content: JSON.stringify(toolOutput)
                });
            }
        }

        if (clientGone) return reply.raw.end();

        // Papers used as context go to the UI (without abstracts)
        if (paperSources) {
            sseWrite(reply.raw, 'sources', paperSources.map(({ abstract, ...rest }) => rest));
        }

        if (directAnswer !== null && directAnswer.trim()) {
            // Answer already produced by the tool-selection call; send it whole
            sseWrite(reply.raw, 'token', { text: directAnswer });
        } else {
            // Stream the final grounded answer (no tools => forces an answer)
            for await (const token of llmService.streamAnswer(messages)) {
                if (clientGone) break;
                sseWrite(reply.raw, 'token', { text: token });
            }
        }

        if (!clientGone) {
            sseWrite(reply.raw, 'done', { took_ms: Date.now() - startTime });
        }

    } catch (error) {
        request.log.error({ err: error, message }, 'Chat request failed');
        if (!clientGone) {
            const userMessage = error.statusCode === 429
                ? 'The AI service is busy right now, please try again in a moment.'
                : 'Something went wrong while generating the answer. Please try again.';
            sseWrite(reply.raw, 'error', { message: userMessage });
        }
    } finally {
        reply.raw.end();
    }
}
