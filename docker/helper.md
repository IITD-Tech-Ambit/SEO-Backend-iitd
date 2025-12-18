To run the search stack, first ensure Docker and Docker Compose are installed and that your system has at least 4–6 GB of free RAM, since OpenSearch is memory intensive. Create a `.env` file in the project root or export environment variables in your shell. At minimum, set `OPENSEARCH_INITIAL_ADMIN_PASSWORD`, `OPENSEARCH_PASSWORD`, and `MONGODB_URI`. For example:

OPENSEARCH_INITIAL_ADMIN_PASSWORD=your_admin_password  
OPENSEARCH_PASSWORD=your_admin_password  
MONGODB_URI=mongodb://localhost:27017  

Optionally, you may set `OPENSEARCH_USER=admin` if not already defined.

Once the environment variables are set, start the full Docker stack by running:

docker-compose -f docker/docker-compose.yml up -d

After startup, you can verify that all containers are running by executing:

docker-compose -f docker/docker-compose.yml ps

To inspect logs for the main services (API, embedding service, OpenSearch, and Redis), run:

docker-compose -f docker/docker-compose.yml logs -f api embedding opensearch-node1 redis

To verify that OpenSearch is reachable (TLS and authentication are enabled), run:

curl -u ${OPENSEARCH_USER:-admin}:${OPENSEARCH_PASSWORD} -k https://localhost:9200/

To verify the embedding service health, run:

curl http://localhost:8001/health

To verify the search API health, run:

curl http://localhost:3000/api/v1/search/health

By default, the stack pulls the images `sudarshan052/embedding-service:latest` and `sudarshan052/search-api:latest`. If you want to use local builds instead, replace the `image:` entries with `build:` blocks in `docker-compose.yml` or build and tag the images locally beforehand. OpenSearch and Redis data are persisted using the volumes `opensearch-data1`, `opensearch-data2`, and `redis-data`.

For indexing data, the Python indexer is located in `services/indexer`. To run it locally, navigate to that directory and create a virtual environment using:

cd services/indexer  
python -m venv .venv  
source .venv/bin/activate  

Install dependencies with:

pip install -r requirements.txt

Set the required environment variables for the indexer:

export MONGODB_URI="mongodb://localhost:27017"  
export OPENSEARCH_NODE="https://localhost:9200"  
export OPENSEARCH_USER=admin  
export OPENSEARCH_PASSWORD=your_admin_password  

Then start the indexer using:

python run.py --create-index --reindex-all 

If OpenSearch is unreachable, inspect its logs using:

docker-compose -f docker/docker-compose.yml logs opensearch-node1

Ensure that `OPENSEARCH_INITIAL_ADMIN_PASSWORD` was set before the first startup. If the API returns 5xx errors, check the API logs and confirm the embedding service is healthy:

docker-compose -f docker/docker-compose.yml logs api  
curl http://localhost:8001/health

To stop the entire stack and remove all persisted data, run:

docker-compose -f docker/docker-compose.yml down --volumes

To pull the latest versions of all Docker images, run:

docker-compose -f docker/docker-compose.yml pull

Before running in a new environment, it is recommended to inspect `docker/docker-compose.yml` to verify environment variable placeholders and review `services/indexer/config.py` to confirm the exact environment variable names expected by the indexer.
