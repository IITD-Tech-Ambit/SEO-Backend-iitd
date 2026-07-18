import grpc from '@grpc/grpc-js';
import { loadPackage } from '../../grpc/loadProto.js';

/**
 * gRPC transport for embedding.v1.EmbeddingService, reached through Envoy
 * (the east-west front door). Same EmbeddingTransport shape as the HTTP
 * adapter, so EmbeddingService is agnostic to the wire protocol.
 */
export default class GrpcEmbeddingTransport {
    constructor({ envoyTarget, timeout, rerankTimeout }) {
        const embeddingPackage = loadPackage('embedding/v1/embedding.proto');
        this._client = new embeddingPackage.embedding.v1.EmbeddingService(
            envoyTarget,
            grpc.credentials.createInsecure()
        );
        this.timeout = timeout;
        this.rerankTimeout = rerankTimeout || 800;
    }

    _call(method, request, timeoutMs) {
        return new Promise((resolve, reject) => {
            const deadline = new Date(Date.now() + timeoutMs);
            this._client[method](request, { deadline }, (err, response) => {
                if (err) return reject(new Error(`Embedding gRPC ${method} failed: ${err.message}`));
                resolve(response);
            });
        });
    }

    async embed(texts) {
        const timeoutMs = texts.length > 1 ? this.timeout * 2 : this.timeout;
        const response = await this._call('Embed', { texts }, timeoutMs);
        return response.embeddings.map((e) => e.values);
    }

    async rerank(query, documents, topN = null) {
        const response = await this._call(
            'Rerank',
            { query, documents, top_n: topN ?? 0 },
            this.rerankTimeout
        );
        return response.results.map((r) => ({ index: r.index, score: r.score }));
    }

    async health() {
        try {
            await this._call('Embed', { texts: ['ping'] }, 2000);
            return true;
        } catch {
            return false;
        }
    }

    close() {
        this._client.close();
    }
}
