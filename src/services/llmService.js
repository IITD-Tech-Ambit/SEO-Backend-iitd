import { EnvHttpProxyAgent } from 'undici';

/**
 * LLM Service (Groq)
 * OpenAI-compatible chat completions client used for RAG answer generation
 * (streaming) and follow-up question condensation (non-streaming).
 */

const SYSTEM_PROMPT = `You are the research assistant for IIT Delhi's research portal. You help students and visitors with questions about IIT Delhi research, publications, faculty expertise, and publication statistics.

You have tools available:
- search_papers: semantic search over research papers (for questions about research content/topics)
- find_faculty_for_topic: find professors working on a topic, with department and email
- get_faculty_profile: a named professor's email, department, designation, expertise and publication statistics
- get_publication_stats: publication counts, optionally per department / year range / grouped by year, department or document type

Rules:
- Always use a tool to get real data before answering. Every number, name, email, and fact in your answer MUST come from tool results - never estimate, guess, or invent anything.
- When the user asks who works on a topic or how to contact someone, include the professor's full name, department, designation, and email from the tool results.
- When search_papers was used, cite papers inline with bracketed numbers like [1] or [2][3] matching the citation_index of each paper.
- If tool results are empty or do not contain the answer, say so honestly and suggest rephrasing. Do not fabricate.
- For questions completely unrelated to IIT Delhi research (e.g. cooking recipes, general trivia), politely explain that you can only help with IIT Delhi research, publications and faculty.
- Keep answers concise and well-structured. Use Markdown (short paragraphs, bullet lists, bold for names/emails) where it helps readability.`;

const CONDENSE_PROMPT = `Given a conversation and a follow-up question, rewrite the follow-up into a single standalone search query that captures what the user is asking about. Preserve names, topics and technical terms from the conversation when the follow-up refers to them. Output ONLY the rewritten query, nothing else.`;

export default class LlmService {
    constructor(config, logger) {
        this.config = config.chat;
        this.logger = logger;

        // Node's built-in fetch ignores HTTP(S)_PROXY env vars. On proxied
        // networks (e.g. the IITD VM) route Groq calls through the proxy,
        // honoring NO_PROXY for internal hosts.
        const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy
            || process.env.HTTP_PROXY || process.env.http_proxy;
        this.dispatcher = proxyUrl ? new EnvHttpProxyAgent() : undefined;
        if (proxyUrl) {
            this.logger.info({ proxyUrl }, 'LLM service using HTTP proxy for Groq API');
        }
    }

    get isConfigured() {
        return Boolean(this.config.groqApiKey);
    }

    async _request(payload, { timeoutMs = this.config.llmTimeoutMs } = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(`${this.config.groqBaseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.config.groqApiKey}`
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
                dispatcher: this.dispatcher
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => '');
                const error = new Error(`Groq API error ${response.status}: ${errBody.slice(0, 500)}`);
                error.statusCode = response.status;
                throw error;
            }

            return response;
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('LLM request timeout');
            }
            throw error;
        } finally {
            // The timeout only guards time-to-first-byte; streamed bodies are
            // read by the caller without a per-chunk deadline.
            clearTimeout(timeoutId);
        }
    }

    /**
     * Rewrite a follow-up question into a standalone retrieval query
     * using the conversation history. Falls back to the raw message on failure.
     */
    async condenseQuery(message, history) {
        if (!history?.length) return message;

        const transcript = history
            .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
            .join('\n');

        try {
            const response = await this._request({
                model: this.config.condenseModel,
                messages: [
                    { role: 'system', content: CONDENSE_PROMPT },
                    { role: 'user', content: `Conversation:\n${transcript}\n\nFollow-up question: ${message}` }
                ],
                temperature: 0,
                max_tokens: 120,
                stream: false
            }, { timeoutMs: 8000 });

            const data = await response.json();
            const condensed = data.choices?.[0]?.message?.content?.trim();
            return condensed || message;
        } catch (error) {
            this.logger.warn({ err: error }, 'Query condensation failed, using raw message');
            return message;
        }
    }

    /**
     * Build the base message array (system + history + user question).
     */
    buildMessages({ message, history }) {
        return [
            { role: 'system', content: SYSTEM_PROMPT },
            ...(history || []).map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: message }
        ];
    }

    /**
     * Non-streaming chat completion, optionally with tool definitions.
     * Returns the raw assistant message: { content, tool_calls? }.
     */
    async chatCompletion(messages, { tools } = {}) {
        const payload = {
            model: this.config.groqModel,
            messages,
            temperature: 0,
            max_tokens: this.config.maxAnswerTokens,
            stream: false
        };
        if (tools?.length) {
            payload.tools = tools;
            payload.tool_choice = 'auto';
        }

        const response = await this._request(payload);
        const data = await response.json();
        return data.choices?.[0]?.message || { content: '' };
    }

    /**
     * Stream the final answer for a prebuilt message array.
     * Yields content token strings.
     */
    async *streamAnswer(messages) {
        const response = await this._request({
            model: this.config.groqModel,
            messages,
            temperature: 0.3,
            max_tokens: this.config.maxAnswerTokens,
            stream: true
        });

        // Parse the OpenAI-style SSE stream: lines of `data: {json}` ending with `data: [DONE]`
        const decoder = new TextDecoder();
        let buffer = '';

        for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete trailing line in buffer

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('data:')) continue;

                const data = trimmed.slice(5).trim();
                if (data === '[DONE]') return;

                try {
                    const parsed = JSON.parse(data);
                    const token = parsed.choices?.[0]?.delta?.content;
                    if (token) yield token;
                } catch {
                    // Ignore malformed keep-alive/partial lines
                }
            }
        }
    }
}
