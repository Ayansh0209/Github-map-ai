import express from "express";
import cors from "cors";
import { config } from "./config/config";
import { logger } from "./middleware/logger";
import { errorHandler } from "./middleware/errorHandler"
import healthRouter from "./routes/health";
import analyzeRoute from "./routes/analyze";
import statusRoute from "./routes/status";

const app = express();


app.use(cors());
app.use(express.json());
app.use(logger);

app.use("/health", healthRouter);
app.use("/analyze", analyzeRoute);
app.use("/status", statusRoute);

app.get("/", (req, res) => {
    res.send("CodeMap AI Backend Running");
});

// Error handler (ALWAYS LAST)
app.use(errorHandler);


const server = app.listen(config.app.port, () => {
    console.log(`Server running on http://localhost:${config.app.port}`);
});

process.on("SIGINT", () => {
    server.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
    server.close(() => process.exit(0));
});