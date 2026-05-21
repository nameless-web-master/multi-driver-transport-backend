import dotenv from "dotenv";
import { ensureSchema } from "../database";

dotenv.config();

ensureSchema()
  .then(() => {
    console.log("Migration complete");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
