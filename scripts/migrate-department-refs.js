/**
 * Migration: Convert Faculty.department string values to ObjectId references
 *
 * Matches faculty documents where `department` is a plain string (e.g. "textile")
 * against the Department collection by name or code, then updates the field to the
 * correct ObjectId.
 *
 * Usage:
 *   MONGODB_URI=mongodb://... node scripts/migrate-department-refs.js
 *   Add --dry-run to preview changes without writing anything.
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
const DRY_RUN = process.argv.includes('--dry-run');

if (!MONGODB_URI) {
    console.error('ERROR: MONGODB_URI is not set');
    process.exit(1);
}

await mongoose.connect(MONGODB_URI);
console.log(`Connected to MongoDB${DRY_RUN ? ' [DRY RUN — no writes]' : ''}\n`);

const Faculty    = mongoose.connection.collection('faculties');
const Department = mongoose.connection.collection('departments');

// Load all departments for matching
const departments = await Department.find({}).toArray();
const byName = new Map(departments.map(d => [d.name?.toLowerCase().trim(), d._id]));
const byCode = new Map(departments.map(d => [d.code?.toLowerCase().trim(), d._id]));

// Find faculty whose department is NOT already a valid ObjectId
const allFaculty = await Faculty.find({}).toArray();

const toUpdate  = [];
const unmatched = [];

for (const f of allFaculty) {
    const raw = f.department;

    // Already an ObjectId — skip
    if (raw instanceof mongoose.Types.ObjectId) continue;
    // 24-char hex string that parses as ObjectId — skip
    if (typeof raw === 'string' && /^[a-fA-F0-9]{24}$/.test(raw)) continue;

    // Try to resolve by name then by code
    const key = typeof raw === 'string' ? raw.toLowerCase().trim() : null;
    const resolvedId = key ? (byName.get(key) ?? byCode.get(key)) : null;

    if (resolvedId) {
        toUpdate.push({ _id: f._id, from: raw, to: resolvedId });
    } else {
        unmatched.push({ _id: f._id, name: `${f.firstName} ${f.lastName}`, department: raw });
    }
}

// Report
console.log(`Faculty scanned  : ${allFaculty.length}`);
console.log(`Will be updated  : ${toUpdate.length}`);
console.log(`Cannot be matched: ${unmatched.length}\n`);

if (toUpdate.length > 0) {
    console.log('--- Updates ---');
    for (const u of toUpdate) {
        console.log(`  "${u.from}"  →  ${u.to}`);
    }
    console.log();
}

if (unmatched.length > 0) {
    console.log('--- Unmatched (manual fix needed) ---');
    for (const u of unmatched) {
        console.log(`  [${u._id}] ${u.name}  →  "${u.department}"`);
    }
    console.log();
}

if (!DRY_RUN && toUpdate.length > 0) {
    const ops = toUpdate.map(u => ({
        updateOne: {
            filter: { _id: u._id },
            update: { $set: { department: u.to } }
        }
    }));
    const result = await Faculty.bulkWrite(ops);
    console.log(`Updated ${result.modifiedCount} faculty documents.`);
} else if (DRY_RUN) {
    console.log('Dry run complete — nothing written.');
}

await mongoose.disconnect();
