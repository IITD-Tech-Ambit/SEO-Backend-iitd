import mongoose from "mongoose";


const departmentSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    code: {
        type: String,
        required: true,
        unique: true,
    },
    category: {
        type: String,
        enum: ['Department', 'School', 'Centre', 'Research Lab / Facility', 'Other'],
        default: 'Other',
    }
})

// === INDEXES ===
departmentSchema.index({ name: 1 });
departmentSchema.index({ category: 1 });

export default mongoose.model("Department", departmentSchema);