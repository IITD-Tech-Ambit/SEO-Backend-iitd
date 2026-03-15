import mongoose from "mongoose";
const facultySchema = new mongoose.Schema({

    name: {
        type: String,
        required: true,
    },
    department: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Department",
        required: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    }
});

// === INDEXES ===
facultySchema.index({ department: 1 });
facultySchema.index({ name: 1 });

export default mongoose.model("Faculty", facultySchema);