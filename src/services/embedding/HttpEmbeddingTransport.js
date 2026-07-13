/**
 * HTTP transport for the embedding service (legacy REST path, used for local
 * dev without Envoy). Implements the EmbeddingTransport shape:
 *   embed(texts) -> number[][]
 *   rerank(query, documents, topN) -> [{ index, score }]
 *   health() -> boolean
 */
export default class HttpEmbeddingTransport {
    constructor({ url, timeout, rerankTimeout }) {
        this.baseUrl = url;
        this.timeout = timeout;
        this.rerankTimeout = rerankTimeout || 800;
    }

    async _post(path, body, timeoutMs) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            if (!response.ok) {
                throw new Error(`Embedding service error: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Embedding service timeout');
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async embed(texts) {
        const timeoutMs = texts.length > 1 ? this.timeout * 2 : this.timeout;
        const data = await this._post('/embed', { texts }, timeoutMs);
        return data.embeddings;
    }

    async rerank(query, documents, topN = null) {
        const body = { query, documents };
        if (topN != null) body.top_n = topN;
        const data = await this._post('/rerank', body, this.rerankTimeout);
        return data.results;
    }

    async health() {
        try {
            const response = await fetch(`${this.baseUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(2000)
            });
            return response.ok;
        } catch {
            return false;
        }
    }
}
