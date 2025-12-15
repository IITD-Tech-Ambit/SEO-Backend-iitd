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
    }
})

// === INDEXES ===
departmentSchema.index({ name: 1 });

export default mongoose.model("Department", departmentSchema);