import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection;
  const doc = await db.collection('researchmetadatascopuses').findOne({
    "authors.author_name": { $regex: /Rajendra Singh Dhaka/i }
  });
  if (doc) {
    const author = doc.authors.find(a => a.author_name.includes('Dhaka'));
    console.log('Found Author ID:', author.author_id);
    console.log('Querying for top scores now...');
    
    const req = await fetch('http://localhost:3000/api/v1/search/author-scope', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Batteries', author_id: author.author_id, per_page: 100 })
    });
    const res = await req.json();
    console.log('Results length:', res.results?.length);
    if(res.results?.length) {
      console.log('Top score:', res.results[0].similarity_score);
      console.log('Bottom score:', res.results[res.results.length - 1].similarity_score);
    }
  } else {
    console.log('Author not found.');
  }
  process.exit(0);
}
run();
