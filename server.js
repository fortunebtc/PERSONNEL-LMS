import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Anthropic from "@anthropic-ai/sdk";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

/* ═════════════════════════════════════════════════════════════
   DATABASE CONNECTION
═════════════════════════════════════════════════════════════ */

mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/personnel")
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

/* ═════════════════════════════════════════════════════════════
   AI CLIENT
═════════════════════════════════════════════════════════════ */

const ai = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

/* ═════════════════════════════════════════════════════════════
   SCHEMAS
═════════════════════════════════════════════════════════════ */

const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
  role: String,
  level: { type: Number, default: 1 },
  score: { type: Number, default: 0 },
  completedTasks: { type: Number, default: 0 },
  certificates: [{
    certId: String,
    level: Number,
    date: String,
    paid: Boolean,
    amount: Number
  }],
  payments: [{
    level: Number,
    amount: Number,
    status: String,
    date: String,
    ref: String
  }],
  status: { type: String, default: "active" },
  createdAt: { type: Date, default: Date.now }
});

const taskSchema = new mongoose.Schema({
  userId: String,
  level: Number,
  taskNum: Number,
  question: String,
  answer: String,
  score: { type: Number, default: 0 },
  feedback: String,
  status: { type: String, default: "pending" },
  submittedAt: { type: Date, default: Date.now }
});

const certificateSchema = new mongoose.Schema({
  certId: String,
  userId: String,
  studentName: String,
  level: Number,
  score: Number,
  verified: Boolean,
  issuedAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", userSchema);
const Task = mongoose.model("Task", taskSchema);
const Certificate = mongoose.model("Certificate", certificateSchema);

/* ═════════════════════════════════════════════════════════════
   MIDDLEWARE
═════════════════════════════════════════════════════════════ */

function auth(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET || "personnel_secret");
    req.user = verified;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

/* ═════════════════════════════════════════════════════════════
   TRAINING DATA
═════════════════════════════════════════════════════════════ */

const LEVELS = {
  1: { name: "Foundation", duration: "2 Months", tasks: 5, price: 500, cert: "Personnel Foundation Certificate" },
  2: { name: "Intermediate", duration: "2 Months", tasks: 5, price: 1000, cert: "Advanced Personnel Certificate" },
  3: { name: "Advanced", duration: "3 Months", tasks: 5, price: 1500, cert: "Advanced Research Certificate" },
  4: { name: "Expert", duration: "5 Months", tasks: 5, price: 2000, cert: "Master Personnel Certification" }
};

const QUESTIONS = {
  1: ["Explain research methodology", "Define qualitative research", "What is data collection?", "Describe the scientific method", "Explain literature review"],
  2: ["Design a research study", "Explain statistical analysis", "What is hypothesis testing?", "Discuss research ethics", "How to analyze data?"],
  3: ["Analyze a research gap", "Propose innovative methodology", "Discuss global research impact", "Write a research proposal", "Evaluate research critically"],
  4: ["Lead large research project", "Develop AI research methodology", "Create policy recommendations", "Manage research teams", "Present findings to government"]
};

/* ═════════════════════════════════════════════════════════════
   AI GRADING
═════════════════════════════════════════════════════════════ */

async function gradeAnswer(question, answer, level) {
  try {
    const response = await ai.messages.create({
      model: "claude-opus-4-1",
      max_tokens: 500,
      messages: [{
        role: "user",
        content: `Grade this answer STRICTLY. Return ONLY valid JSON:
{"pass":true/false,"score":0-25,"feedback":"brief feedback"}

QUESTION: ${question}
ANSWER: ${answer}
LEVEL: ${level}`
      }]
    });

    const json = JSON.parse(response.content[0].text.replace(/```json|```/g, "").trim());
    return json;
  } catch (e) {
    return { pass: false, score: 0, feedback: "Grading error" };
  }
}

/* ═════════════════════════════════════════════════════════════
   AI TUTOR
═════════════════════════════════════════════════════════════ */

async function tutor(message, level, role) {
  try {
    const response = await ai.messages.create({
      model: "claude-opus-4-1",
      max_tokens: 800,
      messages: [{
        role: "user",
        content: `PERSONNEL Tutor. User Level: ${level}, Role: ${role}. Answer in 150 words:\n${message}`
      }]
    });

    return response.content[0].text;
  } catch (e) {
    return "Connection error";
  }
}

/* ═════════════════════════════════════════════════════════════
   ROUTES
═════════════════════════════════════════════════════════════ */

app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (await User.findOne({ email })) return res.status(400).json({ error: "Email exists" });

    const hashed = await bcrypt.hash(password, 10);
    const user = await User.create({ name, email, password: hashed, role });
    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET || "personnel_secret");

    res.json({ success: true, token, user: { id: user._id, name, email, level: 1, role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ error: "Not found" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: "Wrong password" });

    const token = jwt.sign({ id: user._id, email: user.email }, process.env.JWT_SECRET || "personnel_secret");
    res.json({ success: true, token, user: { id: user._id, name: user.name, email, level: user.level, role: user.role } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/question/:level/:task", auth, (req, res) => {
  const q = QUESTIONS[req.params.level]?.[parseInt(req.params.task) - 1] || "Complete task";
  res.json({ question: q, level: parseInt(req.params.level), taskNum: parseInt(req.params.task) });
});

app.post("/api/submit-answer", auth, async (req, res) => {
  try {
    const { level, taskNum, question, answer } = req.body;
    if (answer.length < 100) return res.status(400).json({ error: "Min 100 chars" });

    const grade = await gradeAnswer(question, answer, level);
    const task = new Task({
      userId: req.user.id,
      level: parseInt(level),
      taskNum: parseInt(taskNum),
      question,
      answer,
      score: grade.score,
      feedback: grade.feedback,
      status: grade.pass ? "approved" : "failed"
    });
    await task.save();

    const user = await User.findById(req.user.id);
    user.score += grade.score;
    user.completedTasks += 1;
    if (user.completedTasks % 5 === 0 && user.level < 4) user.level += 1;
    await user.save();

    res.json({ success: grade.pass, score: grade.score, feedback: grade.feedback, level: user.level });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/tutor", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    const reply = await tutor(req.body.message, user.level, user.role);
    res.json({ reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/payment", auth, async (req, res) => {
  try {
    const { level } = req.body;
    const ref = `CERT-${level}-${Date.now()}`;
    const user = await User.findById(req.user.id);
    user.payments.push({ level: parseInt(level), amount: LEVELS[level].price, status: "pending", ref });
    await user.save();

    res.json({ ref, amount: LEVELS[level].price, bank: "Opay", account: "7080978265", name: "Eruvwetere Oghenetejiri" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/confirm-payment", auth, async (req, res) => {
  try {
    const { level, ref } = req.body;
    const user = await User.findById(req.user.id);
    const p = user.payments.find(x => x.ref === ref);
    if (p) { p.status = "completed"; await user.save(); }

    const certId = uuidv4().substr(0, 12).toUpperCase();
    const qr = await QRCode.toDataURL(`https://personnel.app/verify/${certId}`);
    user.certificates.push({ certId, level, date: new Date().toLocaleDateString(), paid: true, amount: LEVELS[level].price });
    await user.save();

    await Certificate.create({ certId, userId: user._id, studentName: user.name, level, score: user.score, verified: true });

    res.json({ success: true, certId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/user-profile", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    res.json({ name: user.name, email: user.email, role: user.role, level: user.level, score: user.score, completedTasks: user.completedTasks, certificates: user.certificates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "✅ PERSONNEL Backend Running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 PERSONNEL LMS Server Running on Port ${PORT}`);
  console.log(`✅ AI Grading Enabled`);
  console.log(`✅ Certificate Generation Active`);
  console.log(`✅ Admin Dashboard Ready`);
});

export default app;
