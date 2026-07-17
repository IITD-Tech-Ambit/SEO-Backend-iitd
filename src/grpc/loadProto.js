import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Proto contracts come from the @iitd-tech-ambit/protos package (published
// from github.com/IITD-Tech-Ambit/proto-registry). PROTO_DIR overrides for
// local layouts that don't have it installed as a dependency.
const PROTO_DIR = process.env.PROTO_DIR ||
    path.join(path.dirname(require.resolve('@iitd-tech-ambit/protos/package.json')), 'proto');

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
