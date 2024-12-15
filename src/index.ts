import express from "express";
import expressWs from "express-ws";
import dotenv from "dotenv";
import apiRoutes from "./routes/apiRoutes";
import { Instance } from "express-ws";

dotenv.config();

const app = express();
const wsApp: Instance = expressWs(app);
app.use(express.json());

app.use((req, res, next) => {
  req.setTimeout(600000);
  res.setTimeout(600000);
  next();
});

app.use((req, res, next) => {
  res.header("Connection", "keep-alive");
  res.header("Keep-Alive", "timeout=600");
  next();
});

app.use("/api", apiRoutes(wsApp));

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

server.timeout = 600000;
server.keepAliveTimeout = 600000;
server.headersTimeout = 601000;

export { wsApp };
