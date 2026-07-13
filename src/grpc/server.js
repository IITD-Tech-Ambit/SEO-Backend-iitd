import grpc from '@grpc/grpc-js';
import { loadPackage } from './loadProto.js';
import { createSearchServiceHandlers } from './handlers/searchServiceHandlers.js';
import { createTaxonomyServiceHandlers } from './handlers/taxonomyServiceHandlers.js';

/**
 * gRPC transport for the search.v1 package — a thin adapter over the same
 * services the REST controllers use. Business logic stays in services/**; this
 * composition root only wires proto service descriptors to handler modules and
 * binds the listener.
 *
 * One listener serves both services in the package (SearchService +
 * TaxonomyService), matching the single Envoy cluster/prefix for /search.v1.*.
 *
 * Under PM2 cluster mode Node's cluster module shares the listening handle
 * across workers, so all instances can serve the same port; a worker that loses
 * the bind race logs a warning and skips gRPC (REST keeps serving) rather than
 * crashing — preserving the original single-RPC server's behaviour.
 */
export function startGrpcServer({ searchService, documentService, suggestService, taxonomyService, logger, bindAddress }) {
    const searchPackage = loadPackage('search/v1/search.proto').search.v1;

    const server = new grpc.Server();
    server.addService(
        searchPackage.SearchService.service,
        createSearchServiceHandlers({ searchService, documentService, suggestService, logger })
    );
    server.addService(
        searchPackage.TaxonomyService.service,
        createTaxonomyServiceHandlers({ taxonomyService, logger })
    );

    return new Promise((resolve) => {
        server.bindAsync(bindAddress, grpc.ServerCredentials.createInsecure(), (err) => {
            if (err) {
                // Non-fatal: REST keeps serving; another cluster worker may own the port.
                logger.warn({ err: err.message, bindAddress }, 'gRPC bind failed');
                return resolve(null);
            }
            logger.info(`search.v1 gRPC server listening on ${bindAddress}`);
            resolve(server);
        });
    });
}
