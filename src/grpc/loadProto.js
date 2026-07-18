import path from 'path';
import { fileURLToPath } from 'url';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Committed copy of the workspace-level protos/ (see protos/sync.sh); the
// Docker image gets it at /app/protos via the Dockerfile COPY.
const PROTO_DIR = process.env.PROTO_DIR || path.resolve(__dirname, '../../protos');

const LOADER_OPTIONS = {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs: [PROTO_DIR]
};

export function loadPackage(relativeProtoPath) {
    const definition = protoLoader.loadSync(
        path.join(PROTO_DIR, relativeProtoPath),
        LOADER_OPTIONS
    );
    return grpc.loadPackageDefinition(definition);
}
