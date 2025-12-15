from pymongo import MongoClient
import os
from dotenv import load_dotenv

load_dotenv()

uri = os.getenv("MONGODB_URI")
client = MongoClient(uri)
db_name = uri.split("/")[-1].split("?")[0]
db = client[db_name]
coll_name = os.getenv("MONGODB_COLLECTION")

print(f"Indexes on {coll_name}:")
for index in db[coll_name].list_indexes():
    print(index)
